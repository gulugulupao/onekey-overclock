/* 一键超频 · 前端逻辑（科技感交互版 v1.0.5） */
'use strict';
const $ = s => document.querySelector(s);
const MODE_META = {
  gentle: { name: '乖巧', mhz: '2.2 GHz', desc: '出厂默认 · 最稳 · 零改动', oc: false, hue: '#34d399' },
  perf:   { name: '野兽', mhz: '2.4 GHz', desc: '强力加速档 · 1.03V', oc: true, hue: '#38bdf8' },
  beast:  { name: '狂暴', mhz: '2.5 GHz', desc: '满载峰值档 · 1.04V', oc: true, hue: '#a78bfa' },
};
const ORDER = ['gentle', 'perf', 'beast'];
const GAUGE = { lo: 1000000, hi: 2500000 };

/* 实验档案：纯记录备注，不含任何执行入口（防止误触发非零售档超频） */
const EXP_RECORDS = [
  {
    tag: '2.7GHz',
    date: '2026-09-11',
    freq: '2700 MHz',
    volt: '1.04 V',
    detail: '静态合并 DTB 向大核 OPP 表追加 2.7G 档（同压 1.04V），满 4 核烤机 3 分钟',
    peakTemp: '64.6°C',
    margin: '距 85°C 墙约 20°C，零降频、零掉压',
    verdict: '稳定 · 电压墙内最后一级',
    note: '本档不在零售 MODES 内，仅作实验备注；如需复现请在系统层自行评估，勿经本应用执行。',
  },
];
function renderExp() {
  const host = $('#expList'); if (!host) return;
  host.innerHTML = EXP_RECORDS.map(e => `
    <div class="exp-card">
      <div class="exp-head"><span class="exp-tag">${e.tag}</span></div>
      <div class="exp-grid">
        <div class="exp-cell"><span class="exp-k">频率</span><span class="exp-v">${e.freq}</span></div>
        <div class="exp-cell"><span class="exp-k">电压</span><span class="exp-v">${e.volt}</span></div>
        <div class="exp-cell"><span class="exp-k">满载峰值温度</span><span class="exp-v">${e.peakTemp}</span></div>
        <div class="exp-cell"><span class="exp-k">温度墙余量</span><span class="exp-v">${e.margin}</span></div>
      </div>
      <p class="exp-detail">${e.detail}</p>
      <p class="exp-verdict">结论：${e.verdict}</p>
      <p class="exp-note">✎ 备注：${e.note}</p>
    </div>`).join('');
}

let st = {};
let selMode = 'gentle';
let curveCanvas = null;
let curveScale = 1;         // canvas 的 CSS 逻辑尺寸缓存
let modeEls = {};
let last = { freq: 0, temp: 0, max: 2500000 };

function fmtFreq(k) { return k ? (k / 1000).toFixed(1) : '—'; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pad(n) { return String(n).padStart(2, '0'); }
function setTheme() { document.documentElement.style.setProperty('--theme', MODE_META[selMode].hue); }

/* ---------- 顶部徽章 ---------- */
function renderBadges() {
  const modeCls = st.mode === 'beast' ? 'on warm' : 'on';
  const mode = `<span class="badge ${modeCls}">档位 · ${MODE_META[st.mode] ? MODE_META[st.mode].name : st.mode}</span>`;
  const dtb = st.dtb === 'oc' ? '<span class="badge warn">DTB 超频</span>' : '<span class="badge">DTB 默认</span>';
  const live = st.oc_live ? '<span class="badge on">超频已加载</span>' : '<span class="badge dim">待加载</span>';
  const selfheal = st.selfheal ? '<span class="badge on">自愈回滚 就绪</span>' : '<span class="badge danger">自愈缺失</span>';
  const wd = st.wd_alive ? '<span class="badge on warm">看门狗 启用</span>' : '<span class="badge dim">看门狗 关闭(可选)</span>';
  $('#badges').innerHTML = mode + dtb + live + selfheal + wd;
  const wt = $('#wdToggle');
  wt.classList.toggle('on', !!st.wd_alive);
  wt.classList.toggle('off', !st.wd_alive);
  wt.querySelector('span').textContent = st.wd_alive ? '看门狗已启用 · 点击停用' : '启用硬件看门狗（可选）';
}

/* ---------- 数据卡 ---------- */
function renderCards() {
  const defs = [
    { k: '当前大核频率', v: fmtFreq(st.cur_freq) + '<small> MHz</small>', cls: '' },
    { k: '最大可调频率', v: fmtFreq(st.max_freq) + '<small> MHz</small>', cls: '' },
    { k: '电压 VDDCPU_A', v: st.volt_mv ? (st.volt_mv / 1000000).toFixed(3) + '<small> V</small>' : '—', cls: '' },
    { k: '策略 policy', v: st.pol, cls: '' },
  ];
  $('#readouts').innerHTML = defs.map(d => `
    <div class="card"><div class="k">${d.k}</div><div class="v ${d.cls}">${d.v}</div></div>`).join('');
}

/* ---------- 仪表 ---------- */
function renderGauge() {
  const max = st.max_freq || last.max;
  const cur = st.cur_freq || 0;
  last = { freq: cur, temp: st.temp_c || 0, max };
  const hi = Math.max(GAUGE.hi, max);
  const r = clamp((cur - GAUGE.lo) / (hi - GAUGE.lo), 0, 1);
  const fill = $('#gFill');
  fill.style.strokeDasharray = (r * 100).toFixed(2) + ' 100';
  /* 发光末端光点沿能量弧移动：弧自 135° 顺时针展开 270°（圆心 160,180，半径 130） */
  const rad = (135 + 270 * r) * Math.PI / 180;
  const tip = $('#gTip');
  tip.setAttribute('cx', (160 + 130 * Math.cos(rad)).toFixed(1));
  tip.setAttribute('cy', (180 + 130 * Math.sin(rad)).toFixed(1));
  $('#gFreq').textContent = fmtFreq(cur);
  const t = $('#gTemp');
  const hot = st.temp_c > 83;
  t.textContent = (hot || st.temp_c) ? `${st.temp_c.toFixed(1)} °C` : '— °C';
  t.toggleAttribute('data-hot', hot);
  setTheme();
}

/* ---------- 档位：一次性构建 + 轮询只切状态（避免 1.5s 整块闪烁） ---------- */
function buildModes() {
  const host = $('#modes');
  ORDER.forEach(k => {
    const m = MODE_META[k];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'mode';
    el.dataset.mode = k;
    el.setAttribute('role', 'radio');
    el.setAttribute('aria-checked', selMode === k ? 'true' : 'false');
    el.style.setProperty('--mh', m.hue);
    el.innerHTML = `
      <span class="lock ${m.oc ? 'oc' : 'base'}">${m.oc ? '超频' : '出厂'}</span>
      <span class="mname">${m.name}</span>
      <span class="mhz">${m.mhz}</span>
      <span class="mdesc">${m.desc}</span>`;
    el.onclick = () => selectMode(k);
    el.onkeydown = e => {
      const i = ORDER.indexOf(k);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); selectMode(ORDER[(i + ORDER.length - 1) % ORDER.length], true); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); selectMode(ORDER[(i + 1) % ORDER.length], true); }
    };
    modeEls[k] = el;
    host.appendChild(el);
  });
  syncModes();
}

function selectMode(k, focus) {
  if (selMode !== k) { selMode = k; syncModes(); setTheme(); }
  if (focus) modeEls[k].focus();
}

function syncModes() {
  ORDER.forEach(k => {
    const on = selMode === k;
    const el = modeEls[k];
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.tabIndex = on ? 0 : -1;
  });
  renderModeHint();
}

function renderModeHint() {
  const h = $('#modeHint'); if (!h) return;
  const meta = MODE_META[selMode];
  const needReboot = meta.oc && !st.oc_live;
  h.className = 'mode-hint ' + (needReboot ? 'warn' : 'ok');
  h.innerHTML = needReboot
    ? '<span class="ic">↻</span><span>⚠ 内核尚未加载超频 DTB：应用「<b>' + meta.name + ' ' + meta.mhz + '</b>」后需<b>重启一次</b>；重启后三档即可实时切换。</span>'
    : '<span class="ic">⚡</span><span>✓ 应用「<b>' + meta.name + ' ' + meta.mhz + '</b>」将<b>实时生效</b>，无需重启。</span>';
}

/* ---------- 在线状态指示 ---------- */
function paintLive(ok) {
  const lv = $('#live');
  lv.classList.toggle('off', !ok);
  lv.querySelector('#liveText').textContent = ok
    ? `在线 · ${pad(new Date().getHours())}:${pad(new Date().getMinutes())}:${pad(new Date().getSeconds())}`
    : '连接断开';
}

/* ---------- 状态刷新 ---------- */
async function refresh() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    st = await r.json();
    if (!st.mode) st.mode = 'gentle';
    paintLive(true);
    renderBadges(); renderCards(); renderGauge(); syncModes();
    if ($('#ver')) $('#ver').textContent = 'v' + st.version;
    syncBurnInfo();
  } catch (e) { paintLive(false); }
}

/* 烧机状态徽章：始终跟随后端 st.burn，杜绝“点击开始后仍显示未运行” */
function syncBurnInfo() {
  const bi = $('#burnInfo'); if (!bi) return;
  bi.textContent = st.burn ? ('烧机中 · ' + (st.burn_elapsed || 0) + 's') : '未运行';
  bi.classList.toggle('running', !!st.burn);
}

/* ---------- 烧机曲线 ---------- */
function resizeCurve() {
  const c = curveCanvas; if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  c.width = Math.round(w * dpr);
  c.height = Math.round(w * (220 / 900) * dpr);
  curveScale = { dpr };
}
function drawCurve(points) {
  const c = curveCanvas; if (!c) return;
  const W = c.width, H = c.height, dpr = curveScale.dpr || 1;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = W / dpr, h = H / dpr;
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#070a11'); bg.addColorStop(1, '#0c1019');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

  // 网格
  ctx.strokeStyle = 'rgba(120,160,220,.08)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = h / 4 * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  for (let i = 0; i <= 8; i++) { const x = w / 8 * i; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }

  if (!points || points.length < 2) {
    ctx.fillStyle = '#506077'; ctx.font = '13px system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('启动烧机后，在此实时绘制 频率 / 温度 曲线', w / 2, h / 2);
    return;
  }
  const freqs = points.map(p => p.freq), temps = points.map(p => p.temp);
  const fmin = Math.min.apply(null, freqs) * 0.98, fmax = Math.max.apply(null, freqs) * 1.02 + 1;
  const tmax = Math.max.apply(null, temps) * 1.08 + 1;
  const fy = v => h * 0.65 - (v - fmin) / (fmax - fmin) * h * 0.6;
  const ty = v => h * 0.62 - (v) / tmax * h * 0.6;

  // 温度墙（85°C）虚线
  ctx.strokeStyle = 'rgba(244,63,94,.5)'; ctx.setLineDash([7, 5]); ctx.lineWidth = 1;
  const ywall = ty(85);
  ctx.beginPath(); ctx.moveTo(0, ywall); ctx.lineTo(w, ywall); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#f43f5e'; ctx.font = '10px system-ui'; ctx.fillText('85°C 温度墙', w - 84, ywall - 5);

  // 频率线（渐变描边 + 发光）
  const lf = ctx.createLinearGradient(0, 0, w, 0);
  lf.addColorStop(0, '#22d3ee'); lf.addColorStop(.6, '#38bdf8'); lf.addColorStop(1, '#818cf8');
  ctx.lineWidth = 2.2; ctx.strokeStyle = lf; ctx.shadowColor = 'rgba(56,189,248,.6)'; ctx.shadowBlur = 8;
  ctx.beginPath();
  points.forEach((p, i) => { const x = i * w / Math.max(points.length - 1, 1); const y = fy(p.freq); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#e2f7ff'; ctx.font = '11px system-ui';
  ctx.fillText('频率', 10, fy(freqs[freqs.length - 1]) - 6);

  // 温度线
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(251,113,133,.95)'; ctx.shadowColor = 'rgba(251,113,133,.5)'; ctx.shadowBlur = 6;
  ctx.beginPath();
  points.forEach((p, i) => { const x = i * w / Math.max(points.length - 1, 1); const y = ty(p.temp); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#fecdd3'; ctx.fillText('温度', 10, ty(temps[temps.length - 1]) - 6);

  // 实时末点光点
  const lx = w, lfy = fy(freqs[freqs.length - 1]);
  ctx.beginPath(); ctx.arc(lx, lfy, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#38bdf8'; ctx.shadowBlur = 10; ctx.shadowColor = '#38bdf8'; ctx.fill(); ctx.shadowBlur = 0;
}

/* 烧机曲线拉取：保持只读、缓存可见性，连不上也不抛错 */
setInterval(async () => {
  try { const r = await fetch('/api/readings', { cache: 'no-store' }); const d = await r.json(); if (d.ok) drawCurve(d.points); } catch (e) {}
}, 800);

/* 日志拉取：贴底时跟随滚动，用户上翻阅历史则不打断 */
setInterval(async () => {
  try {
    const r = await fetch('/api/log', { cache: 'no-store' }); const d = await r.json(); if (!d.ok) return;
    const box = $('#log');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.textContent = d.log;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  } catch (e) {}
}, 2500);

function act(path, body, tip) {
  if (tip && !confirm(tip)) return Promise.resolve();
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(r => r.json()).catch(e => ({ error: '请求失败' }));
}

function init() {
  curveCanvas = $('#curve');
  resizeCurve();
  buildModes();
  renderExp();
  let rszT;
  window.addEventListener('resize', () => { clearTimeout(rszT); rszT = setTimeout(() => { resizeCurve(); }, 120); });

  $('#wdToggle').onclick = async () => {
    if (st.wd_alive) {
      if (confirm('停用硬件看门狗？它非强制，仅作可选"保险"。确定停用？')) await act('/api/watchdog', { action: 'disarm' }, null);
    } else {
      await act('/api/watchdog', { action: 'arm' }, null);
    }
    refresh();
  };

  $('#applyBtn').onclick = async () => {
    const meta = MODE_META[selMode];
    const needReboot = meta.oc && !st.oc_live;
    const tip = needReboot
      ? `首次进入「${meta.name} ${meta.mhz}」：写超频 DTB + fnEnv 并授权，将上限即时设为 ${meta.mhz}。\n系统稍后将自动重启以加载超频 DTB（不必手动重启）。\n自愈已就绪：任意未授权重启会自动回默认频率。`
      : `应用「${meta.name} ${meta.mhz}」到当前内核，立即生效，无需重启。`;
    const d = await act('/api/mode', { mode: selMode }, tip);
    if (!d) return;
    if (d.error) { alert('❌ ' + d.error); }
    else if (d.ok) {
      alert(d.reboot_needed
        ? `已应用「${meta.name} ${meta.mhz}」\n系统即将自动重启加载超频 DTB，重启后即跑满 ${meta.mhz}。`
        : `已应用「${meta.name} ${meta.mhz}」，当前立即生效，无需重启。`);
    }
    refresh();
  };

  $('#rebootBtn').onclick = () => {
    if (st.burn) { alert('烧机运行中，请先停止再重启'); return; }
    if (confirm('立即重启系统以加载超频 DTB？重启后若宕机将自动恢复出厂。')) {
      act('/api/reboot').then(() => { $('#rebootBtn').disabled = true; $('#rebootBtn').classList.add('busy'); });
    }
  };

  $('#resetBtn').onclick = () => {
    if (confirm('恢复出厂：剥离全部超频迹（DTB / fnEnv / 授权）并重启到默认 2.2GHz。确定？')) {
      act('/api/reset').then(() => { $('#resetBtn').disabled = true; $('#resetBtn').classList.add('busy'); });
    }
  };

  $('#burnStart').onclick = () => {
    if (st.burn) return;
    const bi = $('#burnInfo');
    if (bi) { bi.textContent = '烧机中 · 0s'; bi.classList.add('running'); } // 乐观置位，防后端尚未回显时依旧显示“未运行”
    act('/api/burn', { action: 'start' }).then(() => refresh());
  };
  $('#burnStop').onclick = () => { act('/api/burn', { action: 'stop' }).then(() => refresh()); };

  /* ---------- 实验记录：双击「App 版本」→ 确认 → 显示弹窗 ---------- */
  const labOverlay = $('#labOverlay');
  const confirmOverlay = $('#confirmOverlay');
  const labClose = $('#labClose');
  const confirmClose = $('#confirmClose');
  const confirmCancel = $('#confirmCancel');
  const confirmOk = $('#confirmOk');
  const verRow = document.querySelector('.ver');
  function show(o) { o.hidden = false; }
  function hide(o) { o.hidden = true; }
  // 确认后展示实验记录，并移除确认层
  if (verRow) verRow.addEventListener('dblclick', () => show(confirmOverlay));
  if (confirmOk) confirmOk.onclick = () => { hide(confirmOverlay); labClose.focus(); show(labOverlay); };
  if (confirmCancel) confirmCancel.onclick = () => hide(confirmOverlay);
  if (confirmClose) confirmClose.onclick = () => hide(confirmOverlay);
  if (labClose) labClose.onclick = () => hide(labOverlay);
  if (confirmOverlay) confirmOverlay.addEventListener('click', e => { if (e.target === confirmOverlay) hide(confirmOverlay); });
  if (labOverlay) labOverlay.addEventListener('click', e => { if (e.target === labOverlay) hide(labOverlay); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!labOverlay.hidden) hide(labOverlay);
    else if (!confirmOverlay.hidden) hide(confirmOverlay);
  });

  $('#exportLogBtn').onclick = () => {
    fetch('/api/log/export', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) { alert('导出失败'); return null; }
        const m = (r.headers.get('Content-Disposition') || '').match(/filename="?([^";]+)"?/);
        const fname = m ? m[1] : 'onekey-oc-logs.zip';
        return r.blob().then(b => { const a = document.createElement('a'); const url = URL.createObjectURL(b); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); });
      }).catch(() => alert('导出失败'));
  };

  refresh();
  setInterval(refresh, 1500);
}
document.addEventListener('DOMContentLoaded', init);