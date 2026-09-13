#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 一键超频 · onekey-overclock 后端（Python 标准库版 v1.1.1 精简版）
# 替代旧版 web/server.js：仅依赖 Python3 标准库 + 宿主 /sys、/boot、bin/*.sh。
# 以 root 运行（fnOS 以 root 启动本应用）。
import os, sys, io, json, re, time, datetime, threading, signal
import subprocess, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

APP = os.environ.get('APP_DIR', '/vol1/@appcenter/onekey-overclock')
VAR = os.environ.get('VAR', '/vol1/@appdata/onekey-overclock')
PORT = int(os.environ.get('SERVICE_PORT', '8090') or '8090')
# 精简版独立版本号（区别于 v1.0.5 捆绑 node 版）
VERSION = '1.1.1'
LOG_DAYS = 7

SETTINGS = os.path.join(VAR, 'settings', 'settings.json')
LOGDIR = os.path.join(VAR, 'log')
BIN = os.path.join(APP, 'bin')
WD = os.path.join(BIN, 'oc-wd.sh')
APPLY = os.path.join(BIN, 'oc-apply.sh')
RESET = os.path.join(BIN, 'oc-reset.sh')
ENV_FILE = '/boot/fnEnv.txt'
OC_DTB = '/boot/dtb/amlogic/meson-g12b-a311d-oes-oc.dtb'
ARM = '/boot/oc-arm'

MODES = {
    'gentle': {'freq': 2208000, 'volt': 1011000, 'name': '乖巧', 'oc': False},
    'perf':   {'freq': 2400000, 'volt': 1030000, 'name': '野兽', 'oc': True},
    'beast':  {'freq': 2500000, 'volt': 1040000, 'name': '狂暴', 'oc': True},
}

def parse_int(s):
    try:
        return int(str(s).strip())
    except Exception:
        return 0

def rd(p):
    try:
        with open(p, 'r', encoding='utf-8') as f:
            return f.read().strip()
    except Exception:
        return ''

def runs(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return (r.stdout or '').strip()
    except Exception as e:
        return (getattr(e, 'stdout', '') or '').strip() if getattr(e, 'stdout', None) else ''

def settings():
    try:
        with open(SETTINGS, 'r', encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception:
        return {'mode': 'gentle', 'wd_enabled': False}

def save_settings(s):
    try:
        os.makedirs(os.path.join(VAR, 'settings'), exist_ok=True)
        with open(SETTINGS, 'w', encoding='utf-8') as f:
            json.dump(s, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

def ymd(d=None):
    d = d or datetime.datetime.now()
    return d.strftime('%Y%m%d')

def day_file():
    return os.path.join(LOGDIR, 'app-' + ymd() + '.log')

_log_lock = threading.Lock()
def log(s):
    line = '[%s] %s\n' % (datetime.datetime.now().isoformat(timespec='seconds'), s)
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        with _log_lock:
            f = os.path.join(LOGDIR, 'app.log')
            try:
                if os.path.isfile(f) and os.path.getsize(f) > 2 * 1024 * 1024:
                    os.replace(f, f + '.1')
            except Exception:
                pass
            for fp in (f, day_file()):
                try:
                    with open(fp, 'a', encoding='utf-8') as fh:
                        fh.write(line)
                except Exception:
                    pass
    except Exception:
        pass

def recent_daily(n=LOG_DAYS):
    out = []
    try:
        fs = [x for x in os.listdir(LOGDIR) if re.fullmatch(r'app-\d{8}\.log', x)]
        fs.sort()
        for fn in fs[-n:]:
            try:
                with open(os.path.join(LOGDIR, fn), 'rb') as f:
                    out.append((fn, f.read()))
            except Exception:
                pass
    except Exception:
        pass
    return out

def prune_daily():
    try:
        cutoff = datetime.datetime.now() - datetime.timedelta(days=LOG_DAYS)
        for fn in os.listdir(LOGDIR):
            m = re.fullmatch(r'app-(\d{8})\.log', fn)
            if not m:
                continue
            try:
                if datetime.datetime.strptime(m.group(1), '%Y%m%d') < cutoff:
                    os.remove(os.path.join(LOGDIR, fn))
            except Exception:
                pass
    except Exception:
        pass

# ---------- 系统探测（沿用 server.js 语义，仅读 /sys /boot） ----------
def big_policy():
    d = '/sys/devices/system/cpu/cpufreq'
    if not os.path.isdir(d):
        return None
    best, bf = None, -1
    for n in os.listdir(d):
        if not n.startswith('policy'):
            continue
        p = os.path.join(d, n)
        mx = parse_int(rd(os.path.join(p, 'cpuinfo_max_freq')))
        if mx > bf:
            bf, best = mx, p
    return best

def get_cores(pol):
    try:
        return [int(x) for x in rd(os.path.join(pol, 'related_cpus')).split() if x.strip().isdigit()]
    except Exception:
        return []

# ---------- 稳定频率口径 ----------
# scaling_cur_freq/cur_freq 只反映 schedutil 瞬时目标，随探测负载剧烈抖动（见 A/B 实测）。
# 改用内核 stats/time_in_state（真实驻留 tick）的"最近窗口主导档"作为 cur_freq，
# 空闲时稳定报 1.0GHz，负载时如实报高档位，避免仪表盘误跳。
_tis_cache = {'t': 0.0, 'd': {}}

def tis_snapshot(pol):
    out = {}
    try:
        with open(os.path.join(pol, 'stats', 'time_in_state'), 'r', encoding='utf-8') as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                p = ln.split()
                if len(p) == 2 and p[0].isdigit():
                    out[int(p[0])] = int(p[1])
    except Exception:
        pass
    return out

def steady_freq(pol):
    global _tis_cache
    now = time.time()
    cur = tis_snapshot(pol)
    dt = now - _tis_cache['t']
    if not cur:
        return 0
    if dt <= 0 or dt > 30 or not _tis_cache['d']:
        # 首次/超窗/无效：直接以瞬时 scaling 兜底，仅作缓存填充
        f = parse_int(rd(os.path.join(pol, 'scaling_cur_freq')))
        _tis_cache = {'t': now, 'd': cur}
        return f
    best, bf, prev = 0, 0, _tis_cache['d']
    for k, v in cur.items():
        d = v - prev.get(k, 0)
        if d > bf:
            bf, best = d, k
    _tis_cache['t'] = now
    _tis_cache['d'] = cur
    return best if best else 0

def probe():
    pol = big_policy()
    curF = maxF = cpuMax = 0
    if pol:
        curF = steady_freq(pol) or parse_int(rd(os.path.join(pol, 'scaling_cur_freq'))) or parse_int(rd(os.path.join(pol, 'cpuinfo_cur_freq')))
        cpuMax = parse_int(rd(os.path.join(pol, 'cpuinfo_max_freq')))
        maxF = parse_int(rd(os.path.join(pol, 'scaling_max_freq')))
    temp = parse_int(rd('/sys/class/thermal/thermal_zone0/temp')) / 1000.0
    machine = rd('/sys/devices/soc0/machine')
    family = rd('/sys/devices/soc0/family')
    env = rd(ENV_FILE)
    ocArmed = 'oes-oc.dtb' in env
    return {
        'pol': os.path.basename(pol) if pol else 'N/A',
        'curF': curF, 'cpuMax': cpuMax, 'maxF': maxF,
        'temp': round(temp, 1),
        'machine': machine, 'family': family,
        'ocArmed': ocArmed, 'ocLive': cpuMax >= 2400000,
        'armExist': os.path.exists(ARM),
    }

# ---------- 看门狗（可选，默认 OFF） ----------
wdState = 'off'
def wd_status_on():
    return 'WD_ENABLED=1' in runs(['sh', WD, 'status'])

def wd_ctrl(action):
    global wdState
    out = runs(['sh', WD, action])
    wdState = 'on' if wd_status_on() else 'off'
    return {'out': out, 'wd_enabled': wdState == 'on'}

# ---------- 烧机：taskset 固定单核 + dash 忙循环（替代 node while(1){}） ----------
burnRunning = False
burnStart = 0.0
burnPoints = []
burnProcs = []
_burn_lock = threading.Lock()

def start_burn():
    global burnRunning, burnStart, burnPoints, burnProcs
    if burnRunning:
        stop_burn('restart')
    cores = get_cores(big_policy()) or []
    procs = []
    for c in cores:
        try:
            p = subprocess.Popen(['taskset', '-c', str(c), '/bin/sh', '-c', 'while :; do :; done'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            p = subprocess.Popen(['/bin/sh', '-c', 'while :; do :; done'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs.append((c, p))
    burnProcs, burnRunning, burnStart, burnPoints = procs, True, time.time(), []
    log('BURN start cores=' + (','.join(str(c) for c in cores)))

def stop_burn(reason=None):
    global burnRunning, burnProcs
    if reason:
        log('BURN stop: ' + reason)
    for _c, p in burnProcs:
        try:
            p.kill()
        except Exception:
            pass
    burnProcs, burnRunning = [], False

def _burn_sampler():
    while True:
        time.sleep(0.7)
        if not burnRunning:
            continue
        try:
            st = probe()
            elapsed = round(time.time() - burnStart, 1)
            with _burn_lock:
                burnPoints.append({'t': elapsed, 'freq': st['curF'], 'max': st['maxF'], 'temp': st['temp']})
                if len(burnPoints) > 240:
                    burnPoints.pop(0)
        except Exception:
            pass

# ---------- HTTP ----------
def guess_volt(cur):
    if cur >= 2500000:
        return MODES['beast']['volt']
    if cur >= 2400000:
        return MODES['perf']['volt']
    return MODES['gentle']['volt']

class Handler(BaseHTTPRequestHandler):
    server_version = 'onekey-oc'

    def log_message(self, fmt, *a):
        pass

    def send_json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def read_body(self):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except Exception:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(min(length, 1024 * 1024))
        try:
            return json.loads(raw.decode('utf-8')) or {}
        except Exception:
            return {}

    def do_GET(self):
        self._dispatch(False)

    def do_POST(self):
        self._dispatch(True)

    def _dispatch(self, is_post):
        p = unquote(urlparse(self.path).path)
        body = self.read_body() if is_post else {}
        try:
            if p == '/api/status':
                st = probe(); s = settings()
                self.send_json(200, {
                    'ok': True, 'version': VERSION,
                    'soc': ' / '.join([x for x in (st['machine'], st['family']) if x]).strip(' / '),
                    'pol': st['pol'], 'cur_freq': st['curF'], 'max_freq': st['maxF'],
                    'temp_c': st['temp'], 'volt_mv': guess_volt(st['curF']),
                    'mode': s.get('mode', 'gentle'), 'wd_enabled': s.get('wd_enabled', False),
                    'wd_alive': wdState == 'on',
                    'dtb': 'oc' if st['ocArmed'] else 'default',
                    'oc_live': st['ocLive'], 'arm': st['armExist'],
                    'selfheal': os.path.exists('/etc/systemd/system/oc-health.service'),
                    'oc_dtb_generated': os.path.exists(OC_DTB),
                    'backup_exists': os.path.exists(os.path.join(VAR, 'backup', 'fnEnv.orig')),
                    'burn': burnRunning,
                    'burn_elapsed': (round(time.time() - burnStart, 1) if burnRunning else '0'),
                })
                return

            if p == '/api/readings':
                with _burn_lock:
                    pts = list(burnPoints)
                self.send_json(200, {'ok': True, 'running': burnRunning, 'points': pts})
                return

            if p == '/api/mode' and is_post:
                mode = body.get('mode')
                if mode not in MODES:
                    self.send_json(400, {'ok': False, 'error': '未知档位'})
                    return
                s = settings()
                out = runs(['sh', APPLY, mode, '--noreboot'])
                s['mode'] = mode; save_settings(s)
                pol = big_policy()
                cpuMax = parse_int(rd(os.path.join(pol, 'cpuinfo_max_freq'))) if pol else 0
                liveOC = cpuMax >= 2400000
                reboot = bool(MODES[mode]['oc'] and not liveOC)
                log('MODE -> ' + mode + ' :: ' + out + (' [REBOOT]' if reboot else ' [LIVE]'))
                if reboot:
                    threading.Timer(0.3, lambda: runs(['systemctl', 'reboot'])).start()
                self.send_json(200, {'ok': True, 'mode': mode, 'reboot_needed': reboot,
                                     'rebooting': reboot, 'output': out})
                return

            if p == '/api/reboot' and is_post:
                log('REBOOT requested (load armed OC DTB)')
                threading.Timer(0.2, lambda: runs(['systemctl', 'reboot'])).start()
                self.send_json(200, {'ok': True, 'rebooting': True})
                return

            if p == '/api/reset' and is_post:
                s = settings(); s['mode'] = 'gentle'; save_settings(s)
                out = runs(['sh', RESET, '--reboot'])
                log('RESET :: ' + out)
                self.send_json(200, {'ok': True, 'output': out, 'rebooting': True})
                return

            if p == '/api/watchdog' and is_post:
                a = body.get('action')
                s = settings()
                if a in ('arm', 'on', 'disarm', 'off'):
                    r = wd_ctrl('arm' if a in ('arm', 'on') else 'disarm')
                    s['wd_enabled'] = (r['wd_enabled'])
                    save_settings(s)
                    log('WD ' + ('arm' if a in ('arm', 'on') else 'disarm'))
                    self.send_json(200, {'ok': True, **r})
                    return
                self.send_json(400, {'ok': False, 'error': 'action=arm|disarm'})
                return

            if p == '/api/burn' and is_post:
                a = body.get('action')
                if a == 'start':
                    start_burn(); self.send_json(200, {'ok': True, 'running': True}); return
                if a == 'stop':
                    stop_burn('user'); self.send_json(200, {'ok': True, 'running': False}); return
                self.send_json(400, {'ok': False, 'error': 'action=start|stop'})
                return

            if p == '/api/log':
                tail = ''
                try:
                    with open(os.path.join(LOGDIR, 'app.log'), 'r', encoding='utf-8', errors='replace') as f:
                        lines = [x for x in f.read().split('\n') if x]
                    tail = '\n'.join(lines[-80:])
                except Exception:
                    pass
                self.send_json(200, {'ok': True, 'log': tail})
                return

            if p == '/api/log/export':
                self._export_log()
                return

            # 仅根路径重定向到 index；/index.html 本身必须由静态分支正常返回，
            # 否则会造成「/index.html -> /index.html」的无限重定向环，页面白屏。
            if p in ('/', ''):
                self.send_response(302)
                self.send_header('Location', '/index.html')
                self.end_headers()
                return

            self._static(p)
        except Exception as e:
            log('ERR ' + p + ' :: ' + str(e))
            try:
                self.send_json(500, {'ok': False, 'error': str(e)})
            except Exception:
                pass

    def _export_log(self):
        st = probe()
        volt = guess_volt(st['curF'])
        s = settings()
        info = ('一键超频 · 运行日志导出（近%d天）\n\n' % LOG_DAYS
                + '应用版本\t: ' + VERSION + '\n'
                + '导出时间\t: ' + datetime.datetime.now().strftime('%F %T') + '\n'
                + '当前档位\t: ' + str(s.get('mode', 'gentle')) + '\n'
                + '大核 DTB 上限\t: ' + str(st['cpuMax']) + ' KHz\n'
                + '大核可调上限\t: ' + str(st['maxF']) + ' KHz\n'
                + '当前频率\t: ' + str(st['curF']) + ' KHz\n'
                + '温度\t: ' + str(st['temp']) + ' °C\n'
                + 'VDDCPU_A(估)\t: ' + ('%.3f V' % (volt / 1000000.0)) + '\n'
                + 'fnEnv\t: ' + ('指向超频 DTB' if st['ocArmed'] else '默认 DTB') + '\n'
                + '超频已加载\t: ' + ('是' if st['ocLive'] else '否') + '\n'
                + '自愈服务\t: ' + ('就绪' if os.path.exists('/etc/systemd/system/oc-health.service') else '缺失') + '\n\n')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_STORED) as z:
            z.writestr('info.txt', info)
            for name, data in recent_daily(LOG_DAYS):
                z.writestr(name, data)
        body = buf.getvalue()
        fname = 'onekey-oc-logs-%s.zip' % ymd()
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Disposition', 'attachment; filename="%s"' % fname)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _static(self, p):
        root = os.path.join(APP, 'web', 'public')
        rel = p.lstrip('/') or 'index.html'
        parts = rel.split('/')
        if '..' in parts or any(not x for x in parts):
            self.send_json(403, {'ok': False})
            return
        fp = os.path.normpath(os.path.join(root, rel))
        if not fp.startswith(root) or not os.path.isfile(fp):
            self.send_json(404, {'ok': False, 'error': 'not found'})
            return
        ext = os.path.splitext(fp)[1].lower()
        mime = {
            '': 'application/octet-stream',
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.png': 'image/png', '.svg': 'image/svg+xml',
        }.get(ext, 'application/octet-stream')
        try:
            with open(fp, 'rb') as f:
                data = f.read()
        except Exception:
            self.send_json(404, {'ok': False, 'error': 'not found'})
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def main():
    prune_daily()
    threading.Thread(target=_burn_sampler, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    log('onekey-overclock server listening :' + str(PORT) + ' (python ' + sys.version.split()[0] + ')')
    # 看门狗保持"可选、默认 OFF"（避免意外开机脉动/复位）
    s = settings()
    if s.get('wd_enabled'):
        wd_ctrl('arm')
    global wdState
    wdState = 'on' if wd_status_on() else 'off'
    s['wd_enabled'] = (wdState == 'on'); save_settings(s)
    log('boot watchdog: ' + ('armed (user)' if wdState == 'on' else 'off (default)'))

    def _periodic():
        while True:
            time.sleep(6 * 3600)
            prune_daily()
    threading.Thread(target=_periodic, daemon=True).start()

    def _die(_sig, _f):
        try:
            stop_burn('term')
        except Exception:
            pass
        sys.exit(0)
    signal.signal(signal.SIGTERM, _die)
    signal.signal(signal.SIGINT, _die)
    # 预热稳定频率缓存：让首个轮询就能用 time_in_state 窗口，而非瞬时值
    try:
        seed = big_policy()
        if seed:
            time.sleep(0.6)
            steady_freq(seed)
    except Exception:
        pass
    server.serve_forever()

if __name__ == '__main__':
    main()