# -*- coding: utf-8 -*-
"""一键超频 · 双版本打包（v1.0.5 node 运行时版 / v1.1.1 Python 精简版）。

前端文件（web/public/*）已按「界面精简」需求修改（移除“未备份”徽章 + “CPU 温度”数据卡）。
本脚本把共享开发树 onekey-overclock 暂存为两份，按版本各自裁剪：
  v1.0.5 : 保留 runtime/node + web/server.js，剔除 server.py，cmd/main 用 node 启动
  v1.1.1 : 剔除 runtime/，保留 web/server.py，剔除 server.js，cmd/main 用宿主 python3
每份用与 build_onekey_oc.py 完全一致的 tar 结构打包，node 强制 0755。
"""
import tarfile, gzip, io, os, shutil, tempfile

BASE    = r'C:\Users\Administrator\Documents\treawork测试文件夹\one_oc_build\onekey-overclock'
RELEASE = r'C:\Users\Administrator\Documents\treawork测试文件夹\一键超频_releases'

UI_NOTE = ('本轮一键同改（仅界面，未动运行逻辑）：移除右上角「未备份」徽章、'
           '移除 hero 数据卡「CPU 温度」（温度已由表盘实时显示），删除后 hero 区卡片自动重排优化排版；')

# ---- cmd/main（node 运行时版，取自 v1.0.5.fpk） ----
NODE_MAIN = '''#!/bin/bash
# 一键超频 · onekey-overclock —— 原生生命周期（start / stop / status）
# 独立自带 aarch64 node 运行时，不依赖 Docker / ClamSentinel / 任何第三方应用。
set +e

APP="${TRIM_APPDEST:-/vol1/@appcenter/onekey-overclock}"
VAR="${TRIM_PKGVAR:-/vol1/@appdata/onekey-overclock}"
RT="$APP/runtime"
LD="$RT/usr/lib/aarch64-linux-gnu"
NODE="$RT/usr/bin/node"
WEB="$APP/web/server.js"

LOG="$VAR/log"
RUN="$VAR/run"
WEBPID="$RUN/web.pid"
HTTP_PORT="${SERVICE_PORT:-8090}"

log(){ echo "[onekey-overclock][$(date '+%F %T')] $*"; }

prepare () {
    mkdir -p "$VAR" "$LOG" "$RUN" "$VAR/settings" "$VAR/burn" "$VAR/selfheal" "$VAR/backup"
    chmod -R a+rwx "$RUN" 2>/dev/null
    [ ! -f "$VAR/settings/settings.json" ] && echo '{"mode":"gentle","wd_enabled":false}' > "$VAR/settings/settings.json"
}

wait_tcp () {
    local port="$1" tries="$2" i=0
    while [ $i -lt "$tries" ]; do
        if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&- 3<&- 2>/dev/null; return 0; fi
        sleep 1; i=$((i+1))
    done
    return 1
}

do_start () {
    log "启动 (APP=$APP)"
    prepare
    chmod +x "$NODE" 2>/dev/null
    # 幂等：已在运行则直接返回
    if [ -f "$WEBPID" ] && kill -0 "$(cat "$WEBPID" 2>/dev/null)" 2>/dev/null; then
        log "web 已在运行 PID=$(cat $WEBPID)，跳过"
        if wait_tcp "$HTTP_PORT" 2; then log "端口 $HTTP_PORT 已就绪"; fi
        return 0
    fi
    rm -f "$WEBPID"
    nohup env LD_LIBRARY_PATH="$LD" \\
        NODE="$NODE" \\
        APP_DIR="$APP" \\
        VAR="$VAR" \\
        SERVICE_PORT="$HTTP_PORT" \\
        "$NODE" "$WEB" </dev/null >>"$LOG/app.log" 2>&1 &
    echo $! > "$WEBPID"
    if wait_tcp "$HTTP_PORT" 8; then
        log "一键超频 web 已就绪 PID=$(cat $WEBPID) :$HTTP_PORT"
    else
        log "web 启动中 PID=$(cat $WEBPID)（可能仍在等待端口）"
    fi
    return 0
}

do_stop () {
    log "停止"
    [ -f "$WEBPID" ] && kill "$(cat "$WEBPID")" 2>/dev/null
    pkill -f "$APP/web/server.js" 2>/dev/null
    rm -f "$WEBPID"
    log "已停止"
    return 0
}

is_running () {
    [ -f "$WEBPID" ] && kill -0 "$(cat "$WEBPID")" 2>/dev/null
}

case "$1" in
start)   do_start ;;
stop)    do_stop ;;
status)  is_running && exit 0 || exit 3 ;;
*)
    echo "usage: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
'''

PY_MAIN = open(os.path.join(BASE, 'cmd', 'main'), 'r', encoding='utf-8').read()

def read(path):
    with open(path, 'rb') as f:
        return f.read()

def build(cfg):
    ver  = cfg['version']
    out  = os.path.join(RELEASE, cfg['out'])
    stage = os.path.join(tempfile.gettempdir(), 'stage_onekey_' + ver)
    if os.path.exists(stage):
        shutil.rmtree(stage)
    shutil.copytree(BASE, stage, ignore=shutil.ignore_patterns('.git', '__pycache__'))

    app = os.path.join(stage, 'app')
    # 剔除不需要的后端文件与缓存
    for rel in ('web/server.py' if cfg['keep'] == 'js' else 'web/server.js',
                'web/__pycache__'):
        p = os.path.join(app, rel)
        if os.path.exists(p):
            os.remove(p)
    # 精简版：整包删除 runtime/
    if not cfg.get('runtime', True):
        shutil.rmtree(os.path.join(app, 'runtime'), ignore_errors=True)

    # 版本化 cmd/main
    with open(os.path.join(stage, 'cmd', 'main'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(NODE_MAIN if cfg['keep'] == 'js' else PY_MAIN)

    # manifest 已为最终态（version 1.0.0 / changelog v1.0.0），连同前端裁剪后的产物直接随包分发
    man = read(os.path.join(stage, 'manifest')).decode('utf-8-sig', errors='replace')
    with open(os.path.join(stage, 'manifest'), 'w', encoding='utf-8') as f:
        f.write(man)

    return _pack(stage, out, cfg)

def _pack(stage, out, cfg):
    APPROOT = os.path.join(stage, 'app')

    def mode_for(path):
        p = path.replace('\\', '/')
        if p.startswith('bin/') or p.startswith('runtime/usr/bin/'):
            return 0o755
        return 0o644

    def add_all(tf, root):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort(); filenames.sort()
            for dn in list(dirnames):
                dp = os.path.join(dirpath, dn)
                arc = os.path.relpath(dp, root).replace('\\', '/')
                ti = tf.gettarinfo(dp, arcname=arc + '/')
                ti.mode = 0o755
                tf.addfile(ti)
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                arc = os.path.relpath(fp, root).replace('\\', '/')
                ti = tf.gettarinfo(fp, arcname=arc)
                ti.mode = mode_for(arc)
                with open(fp, 'rb') as f:
                    tf.addfile(ti, f)

    inner = io.BytesIO()
    ti = tarfile.open(fileobj=inner, mode='w', format=tarfile.PAX_FORMAT)
    add_all(ti, APPROOT)
    ti.close()
    app_tgz = gzip.compress(inner.getvalue(), compresslevel=9)

    outb = io.BytesIO()
    ot = tarfile.open(fileobj=outb, mode='w:gz', format=tarfile.PAX_FORMAT, compresslevel=9)
    for beg in ('cmd', 'config'):
        p = os.path.join(stage, beg)
        ti = ot.gettarinfo(p, arcname=beg + '/')
        ti.mode = 0o755
        ot.addfile(ti)
        for dp, dns, fns in os.walk(p):
            dns.sort(); fns.sort()
            for fn in fns:
                fp = os.path.join(dp, fn)
                arc = os.path.join(beg, os.path.relpath(fp, p)).replace('\\', '/')
                t2 = ot.gettarinfo(fp, arcname=arc)
                t2.mode = 0o755
                with open(fp, 'rb') as f:
                    ot.addfile(t2, f)
    for fn in ('manifest', 'ICON.PNG', 'ICON_256.PNG', 'LICENSE.txt'):
        fp = os.path.join(stage, fn)
        t2 = ot.gettarinfo(fp, arcname=fn)
        t2.mode = 0o644
        with open(fp, 'rb') as f:
            ot.addfile(t2, f)
    ti = tarfile.TarInfo('app.tgz'); ti.size = len(app_tgz); ti.mode = 0o644
    ot.addfile(ti, io.BytesIO(app_tgz))
    ot.close()
    data = outb.getvalue()
    shutil.rmtree(stage, ignore_errors=True)
    with open(out, 'wb') as f:
        f.write(data)
    return out, len(data)

def main():
    node = {
        'version': '1.0.0', 'out': '一键超频_v1.0.0_node.fpk',
        'keep': 'js', 'runtime': True,
    }
    lite = {
        'version': '1.0.0', 'out': '一键超频_v1.0.0_lite.fpk',
        'keep': 'py', 'runtime': False,
    }
    for cfg in (node, lite):
        out, size = build(cfg)
        print('写出', out, size, 'bytes')
        _verify(out)

def _verify(fpk):
    t = tarfile.open(fpk, 'r:*')
    app_tgz = t.extractfile('app.tgz').read()
    inn = tarfile.open(fileobj=io.BytesIO(gzip.decompress(app_tgz)), mode='r:')
    names = {m.name: m for m in inn.getmembers()}
    print('  manifest version =', [l.split('=')[1].strip() for l in t.extractfile('manifest').read().decode('utf-8',errors='replace').splitlines() if l.strip().startswith('version')])
    print('  has server.js =', 'web/server.js' in names, '| has server.py =', 'web/server.py' in names, '| has runtime/node =', 'runtime/usr/bin/node' in names)
    if 'runtime/usr/bin/node' in names:
        print('  node mode =', oct(names['runtime/usr/bin/node'].mode), '| cmd/main mode =', oct(t.getmember('cmd/main').mode))
    js = inn.extractfile('web/public/app.js').read().decode('utf-8', errors='replace')
    ok = ('未备份' not in js) and ('CPU 温度' not in js)
    print('  前端精简校验（打包内 app.js）：未备份徽章/温度卡已去除 =', ok)

if __name__ == '__main__':
    main()