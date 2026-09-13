# -*- coding: utf-8 -*-
"""构建「一键超频.fpk」。
精简版 v1.1.0：后端复用宿主 python3，打包时跳过 app/runtime/（不再捆绑 node），
体积从约 49MB 降至约 0.3MB。
外层 tar：manifest, ICON.PNG, ICON_256.PNG, LICENSE.txt, cmd/, config/, app.tgz
app.tgz：gzip(pax tar)，根 = app/ 目录内容（runtime/ 除外，含 web/, bin/, ui/）。

联调修复（fnOS 安装校验要求）：
1. desktop_applaunchname 必须 == appname 或为 appname 前缀（onekey-overclock.Application）。
2. 外层 tar 须含 cmd/ 与 config/ 目录条目。
3. 可执行文件须有执行位（bin/*.sh、node、cmd/* 脚本为 0755），否则安装/启动失败。
"""
import tarfile, gzip, io, os

BASE = r'C:\Users\Administrator\Documents\treawork测试文件夹\one_oc_build\onekey-overclock'
OUT  = r'C:\Users\Administrator\Documents\treawork测试文件夹\一键超频_releases\一键超频_v1.1.0_精简.fpk'
APPROOT = os.path.join(BASE, 'app')
SKIP_RUNTIME = True   # 精简版：跳过 app/runtime/（host python3 已能满足运行）

# 内层决定模式：可执行置 0755，其余 0644
def mode_for(path):  # path 为 app.tgz 内相对路径
    p = path.replace('\\', '/')
    if p.startswith('bin/'):
        return 0o755
    return 0o644

def add_all(tf, root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(); filenames.sort()
        if SKIP_RUNTIME and dirpath == root and 'runtime' in dirnames:
            dirnames.remove('runtime')   # 剪枝：不进包
        # 目录条目
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

# ---- app.tgz（PAX, gzip） ----
inner = io.BytesIO()
ti = tarfile.open(fileobj=inner, mode='w', format=tarfile.PAX_FORMAT)
add_all(ti, APPROOT)
ti.close()
app_tgz = gzip.compress(inner.getvalue(), compresslevel=9)

# ---- 外层 tar ----
out = io.BytesIO()
ot = tarfile.open(fileobj=out, mode='w:gz', format=tarfile.PAX_FORMAT, compresslevel=9)
# 先写两个目录条目（fnOS 安装校验要求存在 cmd/ 与 config/ 目录成员）
for d in ('cmd', 'config'):
    p = os.path.join(BASE, d)
    ti = ot.gettarinfo(p, arcname=d + '/')
    ti.mode = 0o755
    ot.addfile(ti)
top = ['cmd', 'config']
for name in top:
    p = os.path.join(BASE, name)
    for dp, dns, fns in os.walk(p):
        dns.sort(); fns.sort()
        for fn in fns:
            fp = os.path.join(dp, fn)
            arc = os.path.relpath(fp, p).replace('\\', '/')
            arc = ('cmd/' if name == 'cmd' else 'config/') + arc
            t2 = ot.gettarinfo(fp, arcname=arc)
            t2.mode = 0o755          # cmd/* 脚本与配置脚本可执行
            with open(fp, 'rb') as f:
                ot.addfile(t2, f)
# 顶层文件：manifest / ICON / LICENSE
for fn in ('manifest', 'ICON.PNG', 'ICON_256.PNG', 'LICENSE.txt'):
    fp = os.path.join(BASE, fn)
    t2 = ot.gettarinfo(fp, arcname=fn)
    if fn == 'ICON.PNG' or fn == 'ICON_256.PNG':
        t2.mode = 0o644
    else:
        t2.mode = 0o644
    with open(fp, 'rb') as f:
        ot.addfile(t2, f)
# app.tgz
ti = tarfile.TarInfo('app.tgz'); ti.size = len(app_tgz); ti.mode = 0o644
ot.addfile(ti, io.BytesIO(app_tgz))
ot.close()
data = out.getvalue()
with open(OUT, 'wb') as f:
    f.write(data)
print('写出', OUT, len(data), 'bytes')

# ---- 校验 ----
t = tarfile.open(OUT, 'r:*')
print('外层成员：')
for m in t.getmembers():
    if m.isdir():
        print('  [dir]', m.name, oct(m.mode & 0o777))
# inner 检查
app_tgz2 = t.extractfile('app.tgz').read()
inn = tarfile.open(fileobj=io.BytesIO(gzip.decompress(app_tgz2)), mode='r:')
print('app.tgz 顶层：', sorted(set(m.name.split('/')[0] for m in inn.getmembers())))
for m in inn.getmembers():
    if m.name in ('bin/oc-apply.sh','bin/oc-cap.sh','bin/oc-health.sh','bin/oc-reboot.sh','bin/oc-reset.sh','bin/oc-wd.sh','runtime/usr/bin/node','web/server.js'):
        print('  ', m.name, oct(m.mode & 0o777), m.size)
print('manifest 行 desktop_applaunchname =', [l.split('=')[1].strip() for l in t.extractfile('manifest').read().decode().splitlines() if l.strip().startswith('desktop_applaunchname')])