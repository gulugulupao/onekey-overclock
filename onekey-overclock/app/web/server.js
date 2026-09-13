// 一键超频 · onekey-overclock 后端服务
// 仅依赖 Node 标准库。以 root 运行（fnOS 以 root 启动本应用）。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const APP = process.env.APP_DIR || '/vol1/@appcenter/onekey-overclock';
const VAR = process.env.VAR || '/vol1/@appdata/onekey-overclock';
const NODE = process.env.NODE || path.join(APP, 'runtime/usr/bin/node');
const PORT = parseInt(process.env.SERVICE_PORT || '8090', 10);

const SETTINGS = path.join(VAR, 'settings/settings.json');
const LOGDIR = path.join(VAR, 'log');
const BURN = path.join(VAR, 'burn');
const BIN = path.join(APP, 'bin');
const WD = path.join(BIN, 'oc-wd.sh');
const APPLY = path.join(BIN, 'oc-apply.sh');
const RESET = path.join(BIN, 'oc-reset.sh');
const ENV_FILE = '/boot/fnEnv.txt';
const BASE_DTB = '/boot/dtb/amlogic/meson-g12b-a311d-oes.dtb';
const OC_DTB = '/boot/dtb/amlogic/meson-g12b-a311d-oes-oc.dtb';
const OC_MARK = 'fdtfile=amlogic/meson-g12b-a311d-oes-oc.dtb';
const DEF_MARK = 'fdtfile=amlogic/meson-g12b-a311d-oes.dtb';
const ARM = '/boot/oc-arm';

// 应用版本号（每次迭代发版时递增；与 manifest 的 version 保持一致）
const VERSION = '1.0.5';
// 运行日志保留天数（只导出/保留近 7 天）
const LOG_DAYS = 7;

// ---------------- 常量 ----------------
const MODES = {
  gentle: { freq: 2208000, volt: 1011000, name: '乖巧', oc: false },
  perf:   { freq: 2400000, volt: 1030000, name: '野兽', oc: true },
  beast:  { freq: 2500000, volt: 1040000, name: '狂暴', oc: true },
};

// ---------------- 工具 ----------------
function rd(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; } }
function wd(p, v) { try { fs.writeFileSync(p, v); } catch (e) {} }
function runs(cmd) { try { return cp.execSync(cmd, { timeout: 15000, encoding: 'utf8' }).trim(); } catch (e) { return String(e && e.stdout || '').trim(); } }
function settings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; }
  catch (e) { return { mode: 'gentle', wd_enabled: false }; }
}
function saveSettings(s) {
  try {
    fs.mkdirSync(path.join(VAR, 'settings'), { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  } catch (e) {}
}
function log(s) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    // 保留最近 2MB，超出滚动
    const f = path.join(LOGDIR, 'app.log');
    try { const st = fs.statSync(f); if (st.size > 2 * 1024 * 1024) fs.copyFileSync(f, f + '.1'); } catch (e) {}
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${s}\n`);
    // 同时写入按天文件，供"近7天日志导出"
    fs.appendFileSync(dayFile(), `[${new Date().toISOString()}] ${s}\n`);
  } catch (e) {}
}
function ymd(d = new Date()) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function dayFile(date) { return path.join(LOGDIR, 'app-' + ymd(date) + '.log'); }
// 只保留近 LOG_DAYS 天的按天日志文件
function pruneDaily() {
  try {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - LOG_DAYS);
    for (const f of fs.readdirSync(LOGDIR)) {
      if (!/^app-\d{8}\.log$/.test(f)) continue;
      const y = +f.slice(4, 8), m = +f.slice(8, 10), d = +f.slice(10, 12);
      if (new Date(y, m - 1, d) < cutoff) { try { fs.unlinkSync(path.join(LOGDIR, f)); } catch (e) {} }
    }
  } catch (e) {}
}
// 收集最近 n 天的按天日志文件
function recentDaily(n = LOG_DAYS) {
  const out = []; let list = [];
  try { list = fs.readdirSync(LOGDIR); } catch (e) {}
  list.filter(f => /^app-\d{8}\.log$/.test(f)).sort().slice(-n).forEach(f => {
    try { out.push({ name: f, data: fs.readFileSync(path.join(LOGDIR, f)) }); } catch (e) {}
  });
  return out;
}
// ---- 手写最小 stored ZIP（免依赖） ----
function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => { const t = []; for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; } return t; })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(d = new Date()) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dt = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { t: t & 0xFFFF, dt: dt & 0xFFFF };
}
function makeZip(files) {
  const body = []; const cd = []; let offset = 0; let cdSize = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data; const crc = crc32(data); const { t, dt } = dosDateTime();
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(t, 10); lh.writeUInt16LE(dt, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    body.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(t, 12); ch.writeUInt16LE(dt, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0o644, 38);
    ch.writeUInt32LE(offset, 42); // 中央目录项 offset 必须写到字节 42-45
    cd.push(ch); cd.push(name); cdSize += 46 + name.length;
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...body, cdBuf, eocd]);
}

// ---------------- 系统探测 ----------------
function bigPolicy() {
  const dir = '/sys/devices/system/cpu/cpufreq';
  if (!fs.existsSync(dir)) return null;
  let best = null, bestF = -1;
  for (const n of fs.readdirSync(dir)) {
    if (!n.startsWith('policy')) continue;
    const p = path.join(dir, n);
    const f = parseInt(rd(path.join(p, 'cpuinfo_max_freq')), 10) || 0;
    if (f > bestF) { bestF = f; best = p; }
  }
  return best;
}
function getCores(pol) {
  try {
    return rd(path.join(pol, 'related_cpus')).split(/\s+/).filter(Boolean).map(x => parseInt(x, 10));
  } catch (e) { return []; }
}
function probe() {
  const pol = bigPolicy();
  const curF = pol ? (parseInt(rd(path.join(pol, 'scaling_cur_freq')), 10) || parseInt(rd(path.join(pol, 'cpuinfo_cur_freq')), 10) || 0) : 0;
  const cpuMax = pol ? (parseInt(rd(path.join(pol, 'cpuinfo_max_freq')), 10) || 0) : 0;
  const maxF = pol ? (parseInt(rd(path.join(pol, 'scaling_max_freq')), 10) || 0) : 0;
  const tempRaw = parseInt(rd('/sys/class/thermal/thermal_zone0/temp'), 10) || 0;
  const temp = tempRaw / 1000; // 单位 °C（除以 1000）
  const machine = rd('/sys/devices/soc0/machine');
  const family = rd('/sys/devices/soc0/family');
  const env = rd(ENV_FILE);
  const ocArmed = /oes-oc\.dtb/.test(env);
  const armExist = fs.existsSync(ARM);
  const polName = pol ? path.basename(pol) : 'N/A';
  // 内核已加载超频 OPP？：cpuinfo_max_freq >= 2.4G 即说明当前 DTB 含超频档位
  const ocLive = cpuMax >= 2400000;
  return { pol: polName, curF, cpuMax, maxF, temp, machine, family, ocArmed, ocLive, armExist, };
}

// ---------------- watchdog ----------------
let wdState = 'off';
function wdStatusOn() { return /WD_ENABLED=1/.test(runs(`sh ${WD} status`)); }
function wdCtrl(action) {
  const out = runs(`sh ${WD} ${action}`);
  wdState = wdStatusOn() ? 'on' : 'off';
  return { out, wd_enabled: wdState === 'on' };
}

// ---------------- 烧机 ----------------
const burners = []; let burnPids = []; let burnRunning = false; let burnStart = 0; let burnPoints = [];
function startBurn() {
  if (burnRunning) return stopBurn('restart');
  const pol = bigPolicy();
  const cores = getCores(pol);
  const ns = NODE.replace(/\\/g, '/');
  burnPids = [];
  for (const c of cores) {
    let p;
    try {
      p = cp.spawn('taskset', ['-c', String(c), ns, '-e', 'while(1){}'], { detached: false, stdio: 'ignore' });
    } catch (e) {
      // 无 taskset 兜底：直接在本核忙
      p = cp.spawn(ns, ['-e', 'while(1){}'], { stdio: 'ignore' });
    }
    burnPids.push({ core: c, pid: p.pid, proc: p });
    burners.push(p);
  }
  burnRunning = true; burnStart = Date.now(); burnPoints = [];
  log('BURN start cores=' + cores.join(','));
}
function stopBurn(reason) {
  if (reason === 'restart' || reason) log('BURN stop: ' + reason);
  for (const p of burnPids) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) {} }
  burnPids = []; burners.length = 0; burnRunning = false;
}
setInterval(() => {
  if (!burnRunning) return;
  const st = probe();
  const elapsed = ((Date.now() - burnStart) / 1000).toFixed(1);
  burnPoints.push({ t: Number(elapsed), freq: st.curF, max: st.maxF, temp: Number(st.temp.toFixed(1)) });
  if (burnPoints.length > 240) burnPoints.shift();
}, 700);

// ---------------- HTTP ----------------
function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); }
function body(req) { return new Promise((ok, no) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { ok({}); } }); req.on('error', no); }); }
function logTail(n = 60) {
  const f = path.join(LOGDIR, 'app.log');
  try { const arr = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); return arr.slice(-n).join('\n'); } catch (e) { return ''; }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/api/status') {
      const st = probe();
      const s = settings();
      const cur = st.curF;
      const modeVolt = MODES[s.mode] ? MODES[s.mode].volt : MODES.gentle.volt;
      // 依据当前频率就近估算电压
      let volt;
      if (cur >= 2500000) volt = MODES.beast.volt; else if (cur >= 2400000) volt = MODES.perf.volt; else volt = MODES.gentle.volt;
      send(res, 200, {
        ok: true,
        version: VERSION,
        soc: (st.machine || '') + ' / ' + (st.family || ''),
        pol: st.pol,
        cur_freq: st.curF, max_freq: st.maxF,
        temp_c: st.temp,
        volt_mv: volt,
        mode: s.mode,
        wd_enabled: s.wd_enabled,
        wd_alive: wdState === 'on',
        dtb: st.ocArmed ? 'oc' : 'default',
        oc_live: st.ocLive,
        arm: st.armExist,
        selfheal: fs.existsSync('/etc/systemd/system/oc-health.service'),
        oc_dtb_generated: fs.existsSync(OC_DTB),
        backup_exists: fs.existsSync(path.join(VAR, 'backup/fnEnv.orig')),
        burn: burnRunning,
        burn_elapsed: burnRunning ? ((Date.now() - burnStart) / 1000).toFixed(1) : '0',
      });
      return;
    }
    if (p === '/api/readings') {
      send(res, 200, { ok: true, running: burnRunning, points: burnPoints });
      return;
    }
    if (p === '/api/mode' && req.method === 'POST') {
      const b = await body(req);
      const mode = b.mode;
      if (!MODES[mode]) return send(res, 400, { ok: false, error: '未知档位' });
      const s = settings();
      // 回默认频率由 fnEnv + /boot/oc-arm 许可逻辑保证，不再强制要求先开看门狗；
      // 看门狗仅作可选"保险"，避免意外 arm 导致开机脉动/复位（本次事故元凶之二）。
      const out = runs(`sh ${APPLY} ${mode} --noreboot`);
      s.mode = mode; saveSettings(s);
      // 是否需重启：仅当"当前内核尚未加载超频 DTB(cpuinfo_max<2.4G)"且要进入超频档时，
      // 才需重启一次换 DTB；否则写 scaling_max_freq 即时生效，三档实时切换无需重启。
      const pol = bigPolicy();
      const cpuMax = pol ? (parseInt(rd(path.join(pol, 'cpuinfo_max_freq')), 10) || 0) : 0;
      const liveOC = cpuMax >= 2400000;
      const reboot = !!MODES[mode].oc && !liveOC;
      log('MODE -> ' + mode + ' :: ' + out + (reboot ? ' [REBOOT]' : ' [LIVE]'));
      // 需重启换 DTB 时自动重启，实现"应用所选档位"一键到位，避免用户漏掉/误解重启时序
      send(res, 200, { ok: true, mode, reboot_needed: reboot, rebooting: reboot, output: out });
      if (reboot) {
        setTimeout(() => { try { cp.execSync('systemctl reboot', { timeout: 3000 }); } catch (e) { log('auto reboot failed: ' + e.message); } }, 300);
      }
      return;
    }
    if (p === '/api/reboot' && req.method === 'POST') {
      log('REBOOT requested (load armed OC DTB)');
      send(res, 200, { ok: true, rebooting: true });
      setTimeout(() => { try { cp.execSync('systemctl reboot', { timeout: 3000 }); } catch (e) { log('reboot failed: ' + e.message); } }, 200);
      return;
    }
    if (p === '/api/reset' && req.method === 'POST') {
      const s = settings();
      s.mode = 'gentle'; saveSettings(s);
      const out = runs(`sh ${RESET} --reboot`);
      log('RESET :: ' + out);
      send(res, 200, { ok: true, output: out, rebooting: true });
      return;
    }
    if (p === '/api/watchdog' && req.method === 'POST') {
      const b = await body(req);
      const s = settings();
      if (b.action === 'arm' || b.action === 'on') { const r = wdCtrl('arm'); s.wd_enabled = true; saveSettings(s); log('WD arm'); return send(res, 200, { ok: true, ...r }); }
      if (b.action === 'disarm' || b.action === 'off') { const r = wdCtrl('disarm'); s.wd_enabled = false; saveSettings(s); log('WD disarm'); return send(res, 200, { ok: true, ...r }); }
      return send(res, 400, { ok: false, error: 'action=arm|disarm' });
    }
    if (p === '/api/burn' && req.method === 'POST') {
      const b = await body(req);
      if (b.action === 'start') { startBurn(); send(res, 200, { ok: true, running: true }); return; }
      if (b.action === 'stop') { stopBurn('user'); send(res, 200, { ok: true, running: false }); return; }
      return send(res, 400, { ok: false, error: 'action=start|stop' });
    }
    if (p === '/api/log') {
      send(res, 200, { ok: true, log: logTail(80) });
      return;
    }
    if (p === '/api/log/export') {
      const pr = probe(); const s = settings();
      let volt;
      if (pr.curF >= 2500000) volt = MODES.beast.volt; else if (pr.curF >= 2400000) volt = MODES.perf.volt; else volt = MODES.gentle.volt;
      const info = '一键超频 · 运行日志导出（近' + LOG_DAYS + '天）\n\n' +
        '应用版本\t: ' + VERSION + '\n' +
        '导出时间\t: ' + new Date().toLocaleString() + '\n' +
        '当前档位\t: ' + s.mode + '\n' +
        '大核 DTB 上限\t: ' + pr.cpuMax + ' KHz\n' +
        '大核可调上限\t: ' + pr.maxF + ' KHz\n' +
        '当前频率\t: ' + pr.curF + ' KHz\n' +
        '温度\t: ' + pr.temp + ' °C\n' +
        'VDDCPU_A(估)\t: ' + (volt / 1000000).toFixed(3) + ' V\n' +
        'fnEnv\t: ' + (pr.ocArmed ? '指向超频 DTB' : '默认 DTB') + '\n' +
        '超频已加载\t: ' + (pr.ocLive ? '是' : '否') + '\n' +
        '自愈服务\t: ' + (fs.existsSync('/etc/systemd/system/oc-health.service') ? '就绪' : '缺失') + '\n';
      const files = recentDaily(LOG_DAYS);
      files.push({ name: 'info.txt', data: Buffer.from(info) });
      const buf = makeZip(files);
      const ymdT = ymd();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="onekey-oc-logs-${ymdT}.zip"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
      return;
    }
    if (p === '/') { res.writeHead(302, { Location: '/index.html' }); res.end(); return; }

    // ---- 静态资源 ----
    const root = path.join(APP, 'web/public');
    let rel = (u.pathname === '/' ? '/index.html' : u.pathname);
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const fp = path.join(root, rel);
    if (!fp.startsWith(root)) return send(res, 403, { ok: false });
    fs.readFile(fp, (e, data) => {
      if (e) return send(res, 404, { ok: false, error: 'not found' });
      const ext = path.extname(fp).toLowerCase();
      const mime = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.png' ? 'image/png'
        : ext === '.svg' ? 'image/svg+xml'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } catch (e) {
    log('ERR ' + p + ' :: ' + (e && e.message));
    send(res, 500, { ok: false, error: (e && e.message) || 'server error' });
  }
}

const server = http.createServer(handle);
server.listen(PORT, '0.0.0.0', () => {
  log('onekey-overclock server listening :' + PORT);
  // 看门狗保持"可选、默认OFF"：仅当用户在设置中显式开启时才 arm，
  // 启动即自动 arm 会造成意外开机脉动/复位（历史事故元凶）。
  const s = settings();
  if (s.wd_enabled) {
    runs(`sh ${WD} arm`);
  }
  wdState = wdStatusOn() ? 'on' : 'off';
  s.wd_enabled = (wdState === 'on'); saveSettings(s);
  log('boot watchdog: ' + (wdState === 'on' ? 'armed (user)' : 'off (default)'));
  pruneDaily(); setInterval(pruneDaily, 6 * 3600 * 1000).unref();
  process.on('SIGTERM', () => { try { stopBurn('term'); } catch (e) {} process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
});