// App wiring: roster editing, running the AI in a worker, playback, and the tactical read-out.

import { TIME, POINTS, FIELD, FUEL, RULES, RULE_CONFLICTS, ROBOT_LIMITS } from './rules.js';
import { SAMPLES, ARCHETYPES, derived } from './model.js';
import { DEFAULT_WEIGHTS } from './ai.js';
import { FieldView } from './viz.js';
import { PERIODS, periodSeconds } from './fastsim.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

const state = {
  rosters: {
    red: SAMPLES.slice(0, 3).map((p) => JSON.parse(JSON.stringify(p))),
    blue: SAMPLES.slice(3, 6).map((p) => JSON.parse(JSON.stringify(p))),
  },
  weights: { ...DEFAULT_WEIGHTS },
  calibration: null,
  result: null,
  timeline: null,
  frame: 0,
  playing: false,
  speed: 8,
  raf: 0,
  lastTs: 0,
  acc: 0,
  trainHistory: null,
  bench: null,
};

// ---------------------------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------------------------
let worker = null;
const pending = new Map();
let msgId = 0;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, type, payload, ...rest } = ev.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    if (type === 'progress') {
      entry.onProgress?.(payload);
      return;
    }
    pending.delete(id);
    if (type === 'error') entry.reject(new Error(payload));
    else entry.resolve({ ...payload, ...rest });
  };
  worker.onerror = (e) => {
    status(`工作线程错误：${e.message}`, 'err');
  };
  return worker;
}

function ask(type, payload, onProgress) {
  const id = ++msgId;
  ensureWorker().postMessage({ id, type, payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, onProgress }));
}

function status(text, kind = '') {
  const chip = $('chip-status');
  chip.textContent = text;
  chip.className = `chip ${kind}`;
}

function setProgress(show, frac = 0, label = '') {
  $('progress').hidden = !show;
  $('progress-bar').style.width = `${Math.round(frac * 100)}%`;
  $('progress-label').textContent = label;
}

function busy(on) {
  for (const id of ['btn-run', 'btn-mc', 'btn-bench', 'btn-train', 'btn-bench-recalc', 'btn-train-run']) {
    const b = $(id);
    if (b) b.disabled = on;
  }
}

// ---------------------------------------------------------------------------------------------
// Roster editor
// ---------------------------------------------------------------------------------------------
const CLIMB_OPTIONS = [
  { v: 0, t: '不爬塔' },
  { v: 1, t: '仅 LEVEL 1' },
  { v: 2, t: '到 LEVEL 2' },
  { v: 3, t: '到 LEVEL 3' },
];

function renderRoster(side) {
  const host = $(`roster-${side}`);
  host.innerHTML = '';
  state.rosters[side].forEach((prof, slot) => {
    const d = derived(prof);
    const card = document.createElement('div');
    card.className = 'robot-card';
    const presetIdx = SAMPLES.findIndex((s) => s.team === prof.team);
    const climbLevel = prof.climb.l3 ? 3 : prof.climb.l2 ? 2 : prof.climb.l1 ? 1 : 0;
    card.innerHTML = `
      <div class="robot-title"><span class="dot ${side}"></span>${side === 'red' ? '红' : '蓝'} ${slot + 1} · DRIVER STATION ${slot + 1}
        <em>${d.canTrench ? '可钻 TRENCH' : '仅可过 BUMP（高度 > 22.25in）'}</em></div>
      <div class="robot-row">
        <label>机型预设
          <select data-k="preset">
            ${SAMPLES.map((s, i) => `<option value="${i}" ${i === presetIdx ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            <option value="-1" ${presetIdx < 0 ? 'selected' : ''}>自定义</option>
          </select>
        </label>
        <label>驱动速度 in/s<input data-k="driveSpeedIps" type="number" step="2" value="${prof.driveSpeedIps}" /></label>
        <label>吸球 FUEL/s<input data-k="intakeRate" type="number" step="0.1" value="${prof.intakeRate}" /></label>
        <label>容量 FUEL<input data-k="capacity" type="number" step="1" value="${prof.capacity}" /></label>
        <label>射球 FUEL/s<input data-k="shootRate" type="number" step="0.1" value="${prof.shootRate}" /></label>
        <label>命中率<input data-k="shootAccuracy" type="number" step="0.01" min="0.1" max="0.99" value="${prof.shootAccuracy}" /></label>
        <label>高度 in<input data-k="heightIn" type="number" step="0.5" min="12" max="30" value="${prof.heightIn}" /></label>
        <label>爬塔上限
          <select data-k="climbMax">${CLIMB_OPTIONS.map((o) => `<option value="${o.v}" ${o.v === climbLevel ? 'selected' : ''}>${o.t}</option>`).join('')}</select>
        </label>
      </div>`;
    card.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      const v = e.target.value;
      const p = state.rosters[side][slot];
      if (k === 'preset') {
        const i = Number(v);
        if (i >= 0) state.rosters[side][slot] = { ...JSON.parse(JSON.stringify(SAMPLES[i])), team: SAMPLES[i].team };
      } else if (k === 'climbMax') {
        const n = Number(v);
        p.climb = { ...p.climb, l1: n >= 1, l2: n >= 2, l3: n >= 3 };
        if (n >= 1 && !p.climb.timeSec) p.climb.timeSec = 8;
      } else {
        p[k] = Number(v);
      }
      const keepFrame = state.frame;
      renderRoster(side);
      state.frame = keepFrame;
    });
    host.appendChild(card);
  });
}

// ---------------------------------------------------------------------------------------------
// Field playback
// ---------------------------------------------------------------------------------------------
const view = new FieldView($('field'));

function renderPeriodStrip(schedule) {
  const host = $('period-strip');
  const segs = [{ p: 'AUTO', sec: TIME.autoSec }, { p: 'TRANSITION', sec: TIME.transitionSec }];
  for (let i = 1; i <= 4; i++) segs.push({ p: `SHIFT ${i}`, sec: TIME.shiftSec });
  segs.push({ p: 'END GAME', sec: TIME.endgameSec });
  host.innerHTML = segs
    .map((s) => {
      const row = schedule ? schedule.find((r) => r.period === s.p) : null;
      const cls = !row ? 'rb' : row.red && row.blue ? 'rb' : row.red ? 'r' : 'b';
      const hub = !row ? 'R+B' : row.red && row.blue ? 'R+B 双活' : row.red ? '红 ACTIVE' : '蓝 ACTIVE';
      return `<div class="seg ${cls}" data-period="${s.p}"><strong>${s.p}</strong><small>${hub}</small><small>${s.sec}s</small></div>`;
    })
    .join('');
}

function setFrame(idx) {
  const tl = state.timeline;
  if (!tl) return;
  state.frame = Math.max(0, Math.min(tl.length - 1, idx));
  const f = tl[state.frame];
  view.drawFrame(f, null);
  $('scrub').value = String(state.frame);
  $('period-label').textContent = f.p;
  $('timer-label').textContent = clock(TIME.matchSec - f.t);
  const hubStrip = $('hub-strip');
  hubStrip.innerHTML = `<i class="${f.hub.red ? 'on-r' : ''}"></i><i class="${f.hub.blue ? 'on-b' : ''}"></i>`;
  $('score-red').textContent = String(f.s.red.total);
  $('score-blue').textContent = String(f.s.blue.total);
  $('detail-red').textContent = `FUEL ${f.s.red.fuel} · TOWER ${f.s.red.tower} · 罚分 ${f.s.red.fouls}`;
  $('detail-blue').textContent = `FUEL ${f.s.blue.fuel} · TOWER ${f.s.blue.tower} · 罚分 ${f.s.blue.fouls}`;
  for (const el of document.querySelectorAll('.period-strip .seg')) {
    el.classList.toggle('cur', el.dataset.period === f.p);
  }
}

function clock(sec) {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function animate(ts) {
  if (!state.playing) return;
  if (!state.lastTs) state.lastTs = ts;
  const dt = Math.min(0.25, (ts - state.lastTs) / 1000);
  state.lastTs = ts;
  state.acc += (dt * state.speed) / 0.5; // frames are recorded every 0.5 s
  if (state.acc >= 1) {
    const step = Math.floor(state.acc);
    state.acc -= step;
    if (state.frame + step >= state.timeline.length - 1) {
      setFrame(state.timeline.length - 1);
      state.playing = false;
      $('btn-play').textContent = '播放';
      return;
    }
    setFrame(state.frame + step);
  }
  state.raf = requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------------------------
function scenarioOverride() {
  return {
    objective: $('sel-objective').value,
    event: $('sel-event').value,
    autoWinner: $('sel-autowinner').value,
    towerL1TeleopAllowed: $('chk-l1teleop').checked,
    faultsEnabled: $('chk-faults').checked,
  };
}

function payload(extra = {}) {
  return {
    profilesRed: state.rosters.red,
    profilesBlue: state.rosters.blue,
    weights: state.weights,
    seed: Number($('inp-seed').value) || 20260110,
    iterations: Number($('inp-iter').value) || 200,
    scenarioOverride: scenarioOverride(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Chart helpers (plain canvas, no libraries)
// ---------------------------------------------------------------------------------------------
function barChart(canvas, values, labels, color = '#2f7de1') {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...values);
  const pad = 18;
  const bw = (w - pad) / values.length;
  values.forEach((v, i) => {
    const bh = ((h - 26) * v) / max;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(pad + i * bw + 2, h - 18 - bh, bw - 4, bh);
    ctx.globalAlpha = 1;
    if (labels && labels[i] !== undefined) {
      ctx.fillStyle = '#8ea0bb';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(labels[i], pad + i * bw + bw / 2, h - 5);
    }
  });
}

function lineChart(canvas, points, color = '#ffd94a') {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = Math.max(0.001, max - min);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = 8 + (i / Math.max(1, points.length - 1)) * (w - 16);
    const y = h - 12 - ((p - min) / span) * (h - 24);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#8ea0bb';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`min ${min.toFixed(2)}  max ${max.toFixed(2)}`, 8, 11);
}

// ---------------------------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------------------------
const ROLE_LABEL = { SCORE: '得分', DEFEND: '防守', CLIMB: '攀爬' };

function renderResult(res) {
  state.result = res;
  const r = res;
  const pct = (v) => `${Math.round(v * 100)}%`;
  $('prob-cards').innerHTML = [
    ['胜率（含平局计半）', pct(r.winRate), `${r.wins}胜 / ${r.losses}负 / ${r.ties}平  ·  ${r.matches} 场`],
    ['AI 平均总分', fmt(r.avgAiScore, 0), `对手 ${fmt(r.avgOppScore, 0)} 分`],
    ['平均 FUEL 入 HUB', fmt(r.avgFuel, 0), `SUPERCHARGED 需要 ${r.thresholds.supercharged.regional}`],
    ['平均 TOWER 分', fmt(r.avgTower, 0), `TRAVERSAL 需要 ${r.thresholds.traversal.regional}`],
    ['AUTO 拿下的概率', pct(r.autoWinRate), 'AUTO 多的一方在 SHIFT 1 停摆（Table 6-3）'],
    ['期望排位分 RS', fmt(r.rpProb.expected, 2), '资格赛排名只看这个'],
  ]
    .map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
    .join('');

  const labels = r.scoreHist.map((_, i) => `${i * 50}`);
  barChart($('chart-score'), r.scoreHist, labels, '#2f7de1');

  const rpRows = [
    ['ENERGIZED RP', r.rpProb.energized, `active HUB 得球 ≥ ${r.thresholds.energized.regional}`],
    ['SUPERCHARGED RP', r.rpProb.supercharged, `active HUB 得球 ≥ ${r.thresholds.supercharged.regional}`],
    ['TRAVERSAL RP', r.rpProb.traversal, `TOWER 分 ≥ ${r.thresholds.traversal.regional}`],
    ['胜场 RP', r.rpProb.win, '胜 3 分 / 平 1 分'],
  ];
  $('rp-list').innerHTML = rpRows
    .map(
      ([name, p, note]) => `
      <div class="rp-row"><span>${name}<br /><small class="hint">${note}</small></span><strong class="mono">${pct(p)}</strong>
      <div class="rp-bar"><i style="width:${Math.round(p * 100)}%"></i></div></div>`,
    )
    .join('');

  renderPlan(r.plan);
  renderPosterior(r.plan);
  renderInsights(r);
  renderDetail(r);
  renderPeriodStrip(r.hubSchedule);
}

function renderPlan(plan) {
  const host = $('plan-view');
  if (!plan) {
    host.innerHTML = '<p class="hint">还没有方案。先点「推演单场」或「蒙特卡洛批量推演」。</p>';
    return;
  }
  const periods = PERIODS.filter((p) => p !== 'AUTO');
  const head = periods.map((p) => `<th>${p}<br /><small class="hint">${periodSeconds(p)}s</small></th>`).join('');
  const rows = [0, 1, 2]
    .map((slot) => {
      const cells = periods
        .map((p) => {
          const role = (plan.plan.periods[p] || [])[slot] || 'SCORE';
          return `<td class="role-${role}">${ROLE_LABEL[role] || role}</td>`;
        })
        .join('');
      return `<tr><td>ROBOT ${slot + 1}</td>${cells}</tr>`;
    })
    .join('');
  const climb = plan.plan.climb;
  const auto = plan.plan.auto;
  const lanes = Object.entries(plan.climbLanes || {})
    .map(([slot, lvl]) => `ROBOT ${Number(slot) + 1} → LEVEL ${lvl}`)
    .join('，');
  const towerPts = (climb.levels || []).slice(0, climb.count).reduce((a, l) => a + (l === 1 ? (scenarioOverride().towerL1TeleopAllowed ? POINTS.tower.l1Teleop : 0) : l === 2 ? POINTS.tower.l2Teleop : POINTS.tower.l3Teleop), 0);
  host.innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>换挡期角色</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint" style="margin-top:8px">
      AUTO 策略：射球强度 ${Math.round(auto.fuelTarget * 100)}%，安排 ${auto.climbCount} 台抢 LEVEL 1（15 分/台，上限 2 台）。
    </p>
    <p class="hint">
      END GAME 爬塔梯次：${climb.count === 0 ? '不爬塔' : `${lanes}（起爬 ${fmt(climb.startAt, 0)}s）`}，
      TOWER 合计 ${towerPts} 分 → TRAVERSAL RP（≥${POINTS.rpThreshold.traversal.regional}）${towerPts >= POINTS.rpThreshold.traversal.regional ? '<b style="color:var(--good)">达成</b>' : '<b style="color:var(--warn)">未达成</b>'}。
    </p>
    <p class="hint">MCTS 搜索量：${plan.stats ? plan.stats.rollouts : 0} 次推演 / ${plan.stats ? plan.stats.calls : 0} 个决策点。</p>`;
}

function renderPosterior(plan) {
  const host = $('posterior');
  if (!plan || !plan.posterior) {
    host.innerHTML = '<p class="hint">—</p>';
    return;
  }
  const rows = ARCHETYPES.map((a) => [a.key, plan.posterior[a.key] || 0, a.label, a.hint]);
  const max = Math.max(...rows.map((r) => r[1]), 0.001);
  host.innerHTML = rows
    .map(
      ([, p, label, hint]) => `
    <div class="post-row" title="${esc(hint)}"><span>${label}</span>
      <div class="bar"><i style="width:${Math.round((p / max) * 100)}%"></i></div>
      <span class="mono">${(p * 100).toFixed(0)}%</span></div>`,
    )
    .join('');
}

function renderInsights(r) {
  const list = [];
  const sc = scenarioOverride();
  const th = r.thresholds;
  const winner = r.autoWinner || (r.autoWinRate > 0.5 ? 'AI' : '对手');

  list.push({
    tone: 'info',
    text: `<b>AUTO 是一把双刃剑。</b>本场 AUTO 归属判定为「${winner === 'AI' ? 'AI 方' : winner}」。按 Table 6-3，AUTO 得球多的一方在 SHIFT 1 与 SHIFT 3 的 HUB 是 <b>inactive</b>（打进去 0 分），对手则在 SHIFT 1 与 SHIFT 3 拿到先手窗口。所以「多打 AUTO」并不总是好事——它买的是 AUTO 分，卖的是第一个得分窗口。`,
  });

  if (r.rpProb.energized < 0.95) {
    list.push({ tone: 'warn', text: `<b>ENERGIZED RP 不稳（${Math.round(r.rpProb.energized * 100)}%）。</b>门槛是 active HUB 得球 ≥ ${th.energized.regional}，本方案均值 ${fmt(r.avgFuel, 0)} 颗。差额要靠提高循环效率（容量×命中率）或延长有效窗口。` });
  } else {
    list.push({ tone: 'good', text: `<b>ENERGIZED RP 稳。</b>均值 ${fmt(r.avgFuel, 0)} 颗 ≥ 门槛 ${th.energized.regional}。` });
  }
  if (r.rpProb.supercharged < 0.5) {
    list.push({ tone: 'info', text: `<b>SUPERCHARGED（≥${th.supercharged.regional} 颗）基本放弃。</b>三台合计要在 active 窗口里打出 ${th.supercharged.regional} 颗，等于每分钟 ~${fmt((th.supercharged.regional / 110) * 60, 0)} 颗的持续输出。资格赛里不要为它牺牲稳定性。` });
  }
  if (r.rpProb.traversal < 0.95) {
    list.push({ tone: 'warn', text: `<b>TRAVERSAL RP（TOWER ≥ ${th.traversal.regional} 分）有风险。</b>注意 §6.5.2 允许 AUTO 的 LEVEL 1 与 TELEOP 爬塔分别计分，两次都算进 TRAVERSAL；AUTO 两台 L1（30 分）+ END GAME 一台 L2（20 分）刚好 50 分，是成本最低的凑线法。` });
  } else {
    list.push({ tone: 'good', text: `<b>TRAVERSAL RP 稳。</b>方案 TOWER 均值 ${fmt(r.avgTower, 0)} 分 ≥ ${th.traversal.regional}。` });
  }

  const fouls = (r.events || []).filter((e) => e.kind === 'foul');
  if (fouls.length === 0) {
    list.push({ tone: 'good', text: `<b>本场没有判罚。</b>AI 的取球点会主动避开 HUB 出料口（G408：接 HUB 出来的球算犯规），防守也不在末 30 秒去碰贴塔的对手（G420）。判罚是白送对手 5/15 分，避罚本身就是得分。` });
  } else {
    const byReason = new Map();
    for (const f of fouls) byReason.set(f.reason, (byReason.get(f.reason) || 0) + f.points);
    list.push({ tone: 'warn', text: `<b>本场出现 ${fouls.length} 次判罚，送给对手 ${[...byReason.values()].reduce((a, b) => a + b, 0)} 分。</b>明细：${[...byReason.entries()].map(([k, v]) => `${esc(k)} ×${v / (k.includes('3 s') || k.includes('G418') ? 5 : 15) || 1}`).join('，')}。` });
  }

  if (sc.objective === 'rs') {
    list.push({ tone: 'info', text: `<b>资格赛的目标是 RS 而不是赢球。</b>Table 10-1 的排序是：RS → 平均 MATCH 分（不含罚分）→ 平均 AUTO FUEL → 平均 TOWER 分。所以当胜率已经很高时，多拿 BONUS RP 的边际收益大于继续拉分差。` });
  } else {
    list.push({ tone: 'info', text: `<b>季后赛只看胜负。</b>目标函数已切到胜率，AI 会更愿意用防守换掉对手的一个得分窗口。` });
  }
  list.push({ tone: 'info', text: `<b>别忘了模型的边界。</b>这里的机器人数据是<strong>示例值</strong>；把自家侦察表里的真实速度/容量/命中率填进去，结论才对你队成立。` });

  $('insights').innerHTML = list.map((i) => `<li class="tone-${i.tone}">${i.text}</li>`).join('');
}

function renderDetail(r) {
  const stats = r.robotStats || [];
  $('robot-table').innerHTML = `
    <thead><tr><th>联盟</th><th>ROBOT</th><th class="mono">得分球</th><th class="mono">浪费球</th><th class="mono">捡球</th><th class="mono">爬塔</th><th class="mono">被判罚</th><th class="mono">被压时间</th><th class="mono">行驶 in</th></tr></thead>
    <tbody>${stats
      .map(
        (s) => `<tr><td><span class="dot ${s.alliance}"></span>${s.alliance === 'red' ? '红' : '蓝'}</td><td>${esc(s.name)}</td>
        <td class="mono">${s.fuelScored}</td><td class="mono">${s.fuelWasted}</td><td class="mono">${s.fuelCollected}</td>
        <td class="mono">L${s.climbLevel}</td><td class="mono">${s.fouls}</td><td class="mono">${fmt(s.blockedByOpponentSec, 0)}s</td><td class="mono">${s.distanceIn}</td></tr>`,
      )
      .join('')}</tbody>`;

  const evs = (r.events || []).filter((e) => e.kind === 'foul' || e.kind === 'climb' || e.kind === 'hubSchedule' || e.kind === 'fault');
  $('event-list').innerHTML = evs.length
    ? evs.slice(0, 80).map((e) => `<li>${fmt(e.t, 1)}s · ${e.kind}${e.reason ? ` · ${esc(e.reason)}` : ''}${e.points ? ` · ${e.points} 分` : ''}${e.level ? ` · L${e.level}` : ''}${e.robot !== undefined && e.robot !== null ? ` · ROBOT ${e.robot + 1}` : ''}</li>`).join('')
    : '<li>无</li>';

  const sch = r.hubSchedule || [];
  $('hub-table').innerHTML = `<thead><tr><th>时段</th><th>时长</th><th>红 HUB</th><th>蓝 HUB</th></tr></thead><tbody>${sch
    .map((row) => `<tr><td>${row.period}</td><td class="mono">${periodSeconds(row.period)}s</td><td>${row.red ? '<b style="color:var(--red)">ACTIVE</b>' : 'inactive'}</td><td>${row.blue ? '<b style="color:var(--blue)">ACTIVE</b>' : 'inactive'}</td></tr>`)
    .join('')}</tbody>`;
}

// ---------------------------------------------------------------------------------------------
// Static reference tables
// ---------------------------------------------------------------------------------------------
function renderRules() {
  $('rules-table').innerHTML = `<thead><tr><th>出处</th><th>手册内容</th><th>落到哪段代码</th></tr></thead><tbody>${RULES.map(
    (r) => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.text)}</td><td class="mono">${esc(r.engine)}</td></tr>`,
  ).join('')}</tbody>`;

  $('conflict-list').innerHTML = RULE_CONFLICTS.map(
    (c) => `<div class="conflict"><b>${esc(c.subject)}</b><br />${esc(c.ruleText || '')}${c.ruleText ? '<br />' : ''}${esc(c.tableText)}<br />处理方式：${esc(c.resolution)}</div>`,
  ).join('');

  const consts = [
    ['AUTO', `${TIME.autoSec}s`, 'Table 6-2'],
    ['TRANSITION SHIFT', `${TIME.transitionSec}s`, 'Table 6-2'],
    ['ALLIANCE SHIFT 1–4', `${TIME.shiftSec}s × 4`, 'Table 6-2'],
    ['END GAME', `${TIME.endgameSec}s`, 'Table 6-2'],
    ['FUEL 入 active HUB', `${POINTS.fuelActiveHub} 分`, 'Table 6-4'],
    ['TOWER LEVEL 1 (AUTO)', `${POINTS.tower.l1Auto} 分，每联盟最多 2 台`, 'Table 6-4 / §6.5.2'],
    ['TOWER LEVEL 1 (TELEOP)', `${POINTS.tower.l1Teleop} 分`, 'Table 6-4（与 §6.5.2 冲突）'],
    ['TOWER LEVEL 2 / 3', `${POINTS.tower.l2Teleop} / ${POINTS.tower.l3Teleop} 分`, 'Table 6-4'],
    ['ENERGIZED / SUPERCHARGED / TRAVERSAL', `${POINTS.rpThreshold.energized.regional} / ${POINTS.rpThreshold.supercharged.regional} / ${POINTS.rpThreshold.traversal.regional}`, 'Table 6-5'],
    ['胜 / 平 RP', `3 / 1`, 'Table 6-4'],
    ['MINOR / MAJOR FOUL', `${POINTS.foul.minor} / ${POINTS.foul.major} 分给对手`, 'Table 6-6'],
    ['FUEL 总装填', `${FUEL.stagedTotal} 颗（DEPOT 24×2、CHUTE 24×2、预装 ≤8/台、其余中场）`, '§6.3.4'],
    ['场地尺寸', `${FIELD.lengthIn} × ${FIELD.widthIn} in`, '§5.2'],
    ['ROBOT 起始尺寸', `周长 ≤ ${ROBOT_LIMITS.startPerimeterMaxIn} in，高 ≤ ${ROBOT_LIMITS.startHeightMaxIn} in`, 'R104'],
    ['TRENCH 净空', `${FIELD.trench.clearHeightIn} in（更高的机器人只能走 BUMP）`, '§5.6'],
    ['TOWER 横杆高度', `LOW ${FIELD.tower.rungLowIn} / MID ${FIELD.tower.rungMidIn} / HIGH ${FIELD.tower.rungHighIn} in`, '§5.8'],
  ];
  $('const-table').innerHTML = `<thead><tr><th>项目</th><th>取值</th><th>出处</th></tr></thead><tbody>${consts
    .map(([a, b, c]) => `<tr><td>${a}</td><td class="mono">${b}</td><td class="mono">${c}</td></tr>`)
    .join('')}</tbody>`;
}

function renderBench(data) {
  if (!data) return;
  state.bench = data;
  const rows = data.rows || [];
  $('bench-table').innerHTML = `
    <thead><tr><th>对手基线</th><th class="mono">AI 胜率</th><th class="mono">AI 分</th><th class="mono">对手分</th><th class="mono">AI 期望 RS</th><th class="mono">TRAVERSAL</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr><td>${esc(r.kind)}</td><td class="mono">${Math.round(r.winRate * 100)}%</td><td class="mono">${fmt(r.avgAiScore, 0)}</td>
        <td class="mono">${fmt(r.avgOppScore, 0)}</td><td class="mono">${fmt(r.avgRP, 2)}</td><td class="mono">${Math.round(r.traversalRate * 100)}%</td></tr>`,
      )
      .join('')}</tbody>`;
  if (data.headToHead) {
    const h = data.headToHead;
    $('bench-table').insertAdjacentHTML(
      'beforeend',
      `<caption style="caption-side:bottom;text-align:left;color:var(--dim);font-size:11px;padding-top:6px">
        AI vs greedy 同机型对阵：${h.aWins} 胜 ${h.bWins} 负 ${h.draws} 平，均分 ${fmt(h.aScore, 0)} vs ${fmt(h.bScore, 0)}（${h.matches} 场）</caption>`,
    );
  }
  const ci = state.calibration;
  $('agreement').innerHTML = ci
    ? `加载时用 ${ci.samples} 场真实引擎对局标定分析模型：系数 ${fmt(ci.efficiency, 3)}。标定后残差 红 ${fmt(ci.errRedPct, 1)}% / 蓝 ${fmt(ci.errBluePct, 1)}%（标定前 ${fmt(((ci.rawRed - ci.engineRed) / ci.engineRed) * 100, 1)}%）。搜索用的是标定后的模型。`
    : '尚未标定。';
}

function renderTrain(out) {
  state.trainHistory = out.history || null;
  lineChart($('chart-train'), (out.history || []).map((h) => h.fit), '#ffd94a');
  const changed = Object.keys(out.weights).filter((k) => Math.abs(out.weights[k] - DEFAULT_WEIGHTS[k]) > 1e-6);
  $('weight-table').innerHTML = `<thead><tr><th>权重</th><th class="mono">默认</th><th class="mono">训练后</th></tr></thead><tbody>${
    (changed.length ? changed : Object.keys(DEFAULT_WEIGHTS).slice(0, 12))
      .map((k) => `<tr><td class="mono">${k}</td><td class="mono">${fmt(DEFAULT_WEIGHTS[k], 3)}</td><td class="mono">${fmt(out.weights[k], 3)}</td></tr>`)
      .join('')
  }</tbody>`;
  $('train-result').innerHTML = `共 ${(out.history || []).length - 1} 代，适应度 ${fmt(out.fitness, 3)}。改动 ${changed.length} 个权重。
    <b>注意</b>：浏览器里样本少，训练结果容易过拟合局部噪声，请用「对比基线」重新验证后再采用；默认权重是已验证的那套。`;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------
async function runSingle() {
  busy(true);
  status('推演单场…', 'busy');
  setProgress(true, 0.1, 'AI 正在搜索换挡策略');
  try {
    const res = await ask('mc', payload({ matches: 1, recordFirst: true, mode: 'vsBaseline', opponentKind: 'greedy', aiSide: 'red', planSnapshot: true }));
    state.timeline = res.timeline;
    $('scrub').max = String(Math.max(0, (res.timeline ? res.timeline.length : 1) - 1));
    renderResult(res);
    setFrame(0);
    state.playing = true;
    state.lastTs = 0;
    state.acc = 0;
    $('btn-play').textContent = '暂停';
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(animate);
    status('单场推演完成', 'ok');
  } catch (e) {
    status(`推演失败：${e.message}`, 'err');
  } finally {
    busy(false);
    setProgress(false);
  }
}

async function runMonteCarlo() {
  const matches = Math.max(10, Math.min(600, Number($('inp-mcmatches').value) || 120));
  busy(true);
  status(`蒙特卡洛 ${matches} 场…`, 'busy');
  setProgress(true, 0, '0%');
  try {
    const res = await ask(
      'mc',
      payload({ matches, recordFirst: true, mode: 'vsBaseline', opponentKind: 'greedy', aiSide: 'red' }),
      (p) => setProgress(true, p.done / p.total, `${p.done}/${p.total} 场`),
    );
    state.timeline = res.timeline;
    $('scrub').max = String(Math.max(0, (res.timeline ? res.timeline.length : 1) - 1));
    renderResult(res);
    setFrame(0);
    status(`蒙特卡洛完成（${matches} 场）`, 'ok');
  } catch (e) {
    status(`批量推演失败：${e.message}`, 'err');
  } finally {
    busy(false);
    setProgress(false);
  }
}

async function runBench() {
  busy(true);
  status('跑基线对比…', 'busy');
  setProgress(true, 0.05, '随机 / 满仓乱射 / 贪心');
  try {
    const res = await ask(
      'benchmark',
      { weights: state.weights, matches: 8, iterations: 140 },
      (p) => setProgress(true, 0.4, `正在跑 ${p.stage}`),
    );
    renderBench(res);
    status('基线对比完成', 'ok');
  } catch (e) {
    status(`基线对比失败：${e.message}`, 'err');
  } finally {
    busy(false);
    setProgress(false);
  }
}

async function runTrain() {
  const budget = Math.max(5, Math.min(120, Number($('inp-train-budget').value) || 30)) * 1000;
  busy(true);
  status('自博弈调参…', 'busy');
  setProgress(true, 0, '0 代');
  try {
    const res = await ask(
      'train',
      { weights: state.weights, generations: 40, lambda: 6, matches: 4, iterations: 110, budgetMs: budget, seed: 99, selfPlay: true },
      (p) => setProgress(true, p.gen / p.generations, `第 ${p.gen} 代 · 适应度 ${fmt(p.fit, 3)}`),
    );
    renderTrain(res);
    status('训练结束（记得重新验证）', 'ok');
  } catch (e) {
    status(`训练失败：${e.message}`, 'err');
  } finally {
    busy(false);
    setProgress(false);
  }
}

async function calibrate() {
  status('标定分析模型…', 'busy');
  try {
    const c = await ask('calibrate', { weights: state.weights, samples: 4 });
    state.calibration = c;
    state.weights = { ...state.weights, modelEfficiency: c.efficiency };
    renderBench(state.bench || { rows: [] });
    status('就绪', 'ok');
  } catch (e) {
    status(`标定失败，使用默认权重：${e.message}`, 'err');
  }
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
function boot() {
  renderRoster('red');
  renderRoster('blue');
  renderPeriodStrip(null);
  renderRules();
  renderBench({ rows: [] });
  view.drawFrame(null, null);
  $('legend').innerHTML = view
    .legend()
    .map((l) => `<span><i style="background:${l.c}"></i>${l.t}</span>`)
    .join('');

  $('btn-run').addEventListener('click', runSingle);
  $('btn-mc').addEventListener('click', runMonteCarlo);
  $('btn-bench').addEventListener('click', runBench);
  $('btn-bench-recalc').addEventListener('click', runBench);
  $('btn-train').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="train"]').click();
  });
  $('btn-train-run').addEventListener('click', runTrain);
  $('btn-tab-rules').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="rules"]').click();
  });
  $('btn-play').addEventListener('click', () => {
    if (!state.timeline) return;
    state.playing = !state.playing;
    $('btn-play').textContent = state.playing ? '暂停' : '播放';
    state.lastTs = 0;
    if (state.playing) state.raf = requestAnimationFrame(animate);
  });
  $('scrub').addEventListener('input', (e) => {
    state.playing = false;
    $('btn-play').textContent = '播放';
    setFrame(Number(e.target.value));
  });
  $('sel-speed').addEventListener('change', (e) => {
    state.speed = Number(e.target.value);
  });
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tab')) x.classList.toggle('active', x === t);
      for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.id !== `tab-${t.dataset.tab}`;
      if (t.dataset.tab === 'insight') redrawInsightCharts();
    });
  }
  const relayout = () => {
    view.resize();
    if (state.timeline) setFrame(state.frame);
    else view.drawFrame(null, null);
    if (state.result) redrawInsightCharts();
  };
  window.addEventListener('resize', relayout);
  if (typeof ResizeObserver !== 'undefined') {
    // The canvas must follow its panel, not the window: panel width changes with the grid.
    new ResizeObserver(relayout).observe(document.querySelector('.field-panel'));
  }
  document.querySelector('.tab[data-tab="insight"]').click();
  requestAnimationFrame(relayout);
  calibrate();
}

function redrawInsightCharts() {
  if (state.result) barChart($('chart-score'), state.result.scoreHist, state.result.scoreHist.map((_, i) => `${i * 50}`), '#2f7de1');
  if (state.trainHistory) lineChart($('chart-train'), state.trainHistory.map((h) => h.fit));
}

boot();
