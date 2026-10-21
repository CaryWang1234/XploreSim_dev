// App wiring: roster editing, running the AI in a worker, playback, and the tactical read-out.

import { TIME, POINTS, FIELD, FUEL, RULES, RULE_CONFLICTS, ROBOT_LIMITS } from './rules.js';
import { SAMPLES, ARCHETYPES, MECHANISMS, STARTS, DRIVERS, CHASSIS, CHASSIS_OF, INTAKE_SIDES, derived, periodAt } from './model.js';
import { DEFAULT_WEIGHTS } from './ai.js';
import { FieldView } from './viz.js';
import { PERIODS, periodSeconds } from './fastsim.js';
import { createWorkerClient } from './worker-client.js';
import { sampleReplay } from './replay.js';
import { MODE_ORDER, modeBands, periodBands, robotRows, scoreSeries, sourceRows, windowBands } from './chartdata.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

// The ceiling on one batch, in MATCHes: the number the input's `max` carries, the clamp below applies, and
// `npm run verify` asserts. A MATCH is a few tenths of a second with the AI seat searching — the guard times it
// and prints the figure and the wall time this cap comes to — so a full batch is minutes behind a progress bar
// and a cancel button. `mc.js` does not refuse to run above it — the command-line sweeps in scripts/ ask for
// sizes a browser should not be made to wait through.
const MAX_BATCH = 1200;

const state = {
  rosters: {
    red: SAMPLES.slice(0, 3).map((p) => JSON.parse(JSON.stringify(p))),
    blue: SAMPLES.slice(3, 6).map((p) => JSON.parse(JSON.stringify(p))),
  },
  weights: { ...DEFAULT_WEIGHTS },
  calibration: null,
  result: null,
  timeline: null,
  // The trend chart's drawn state, so the scrubber can move the marker without re-deriving 1601 anchors.
  trend: null,
  trendMarkerSec: -1,
  // What produced the replay currently on screen. Kept as run, because the sliders and the ROBOT cards
  // may have moved since, and Export has to write down what actually ran rather than what is showing.
  lastPayload: null,
  lastCtx: null,
  frame: 0,
  playT: 0,
  playing: false,
  speed: 8,
  raf: 0,
  lastTs: 0,
  cinema: false,
  trainHistory: null,
  bench: null,
  // The last batch's headline numbers, so the next batch can be read as a delta against it.
  prevBatch: null,
  // One row per MATCH of the last batch (its number, its seed, both scores) plus the payload that batch ran
  // under, so a flagged MATCH can be re-simulated to the seed it was measured on instead of stored. `batchMatch`
  // is which row is on the FIELD; 0 means the replay on screen did not come from a batch.
  batchRows: null,
  batchResult: null,
  batchInput: null,
  batchMatch: 0,
  // The HUMAN PLAYER's two variables per alliance (§6.1): throws per second at their own HUB, and how
  // often that throw goes in. Everything else about the role is fixed by the OUTPOST rules.
  humanThrow: { red: 0.4, blue: 0.4 },
  humanAcc: { red: 0.75, blue: 0.75 },
  // ROBOT indices the viewer asked to watch; empty means everyone at full strength.
  focus: new Set(),
  busy: false,
};

// ---------------------------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------------------------
const { ask, dispose: stopWorker } = createWorkerClient(() => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));

function status(text, kind = '') {
  const chip = $('chip-status');
  chip.textContent = text;
  chip.className = `chip ${kind}`;
}

function setProgress(show, frac = 0, label = '') {
  const percent = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  $('progress').hidden = !show;
  $('progress').setAttribute('aria-valuenow', String(percent));
  $('progress').setAttribute('aria-valuetext', label || `${percent}%`);
  $('progress-bar').style.width = `${percent}%`;
  $('progress-label').textContent = label;
}

function busy(on) {
  state.busy = on;
  $('btn-cancel').hidden = !on;
  $('btn-cancel').disabled = !on;
  for (const id of ['btn-run', 'btn-mc', 'btn-bench', 'btn-train', 'btn-bench-recalc', 'btn-train-run', 'btn-import']) {
    const b = $(id);
    if (b) b.disabled = on;
  }
}

function taskFailure(label, error) {
  const cancelled = error.name === 'AbortError';
  status(cancelled ? 'Task cancelled' : `${label}: ${error.message}`, cancelled ? '' : 'err');
}

// ---------------------------------------------------------------------------------------------
// Roster editor
// ---------------------------------------------------------------------------------------------
const CLIMB_OPTIONS = [
  { v: 0, t: 'No climb' },
  { v: 1, t: 'LEVEL 1 only' },
  { v: 2, t: 'Up to LEVEL 2' },
  { v: 3, t: 'Up to LEVEL 3' },
];

// How a ROBOT crosses the BUMP/TRENCH band that separates the two halves of the FIELD. The
// default follows the §5.7 height rule (≤ 22.25 in clear fits the TRENCH); the other options let
// a scout record what the ROBOT actually does, including a low-slung machine that fits the
// TRENCH but still cannot ride the BUMP.
const CROSS_OPTIONS = [
  { v: 'auto', t: 'Auto (from height)' },
  { v: 'both', t: 'TRENCH + BUMP' },
  { v: 'bump', t: 'BUMP only' },
  { v: 'trench', t: 'TRENCH only' },
  { v: 'none', t: 'Neither' },
];

// The two FUEL plays that are a tactical choice rather than a capability, so they are per-ROBOT
// settings next to the BUMP/TRENCH one. Both default to the conservative behaviour.
const PASS_OPTIONS = [
  { v: 'off', t: 'Off' },
  { v: 'auto', t: 'Careful (in range, only if it saves a lot)' },
  { v: 'eager', t: 'Aggressive (same targets, thrown sooner)' },
];
const PUSH_OPTIONS = [
  { v: 'off', t: 'Off' },
  { v: 'passive', t: 'Passive (push on contact)' },
  { v: 'active', t: 'Active (shove FUEL into your half)' },
];
// Whether a full ROBOT that cannot shoot pushes its load into the OUTPOST for the HUMAN PLAYER
// instead of holding it (§5.9.2). Defaults to the conservative behaviour.
const FEED_OPTIONS = [
  { v: 'off', t: 'Off' },
  { v: 'auto', t: 'Auto (deliver a load that cannot score)' },
];

// Where the ROBOT starts the MATCH, from the structures the ROBOT STARTING LINE runs in front of
// (§5.3). STARTS lives in model.js because the engine reads the same keys.
const START_OPTIONS = STARTS.map((s) => ({ v: s.key, t: s.label, hint: s.hint }));
const DRIVER_OPTIONS = DRIVERS.map((d) => ({ v: d.key, t: d.label, hint: d.hint }));

// The stored form is the raw override (null = follow the height rule), so an unset ROBOT reads
// back as "auto" rather than as the resolved capability.
function crossValue(prof) {
  if (prof.canBump == null && prof.canTrench == null) return 'auto';
  const b = prof.canBump == null ? true : !!prof.canBump;
  const t = prof.canTrench == null ? true : !!prof.canTrench;
  if (b && t) return 'both';
  if (b) return 'bump';
  if (t) return 'trench';
  return 'none';
}

const PRESET_KEYS = ['driveSpeedIps', 'intakeRate', 'capacity', 'shootRate', 'shootAccuracy', 'passRangeIn', 'heightIn', 'turnRateDegPerSec'];

// A profile counts as a preset only while it still matches one. Matching on `team` alone would
// keep labelling edited numbers "Chezy", which is exactly the kind of implied
// authority this page must not have. The BUMP/TRENCH override is deliberately NOT part of the
// match: it says what the scout saw the ROBOT do, not what its numbers are, so setting it must not
// throw away the provenance of parameters the user never touched.
function presetIndexOf(prof) {
  return SAMPLES.findIndex(
    (s) =>
      s.team === prof.team &&
      PRESET_KEYS.every((k) => Number(s[k]) === Number(prof[k])) &&
      s.mechanism === prof.mechanism &&
      (s.chassis || 'swerve') === (prof.chassis || 'swerve') &&
      (s.intakeSide || 'back') === (prof.intakeSide || 'back') &&
      Number(s.climb.timeSec) === Number(prof.climb.timeSec) &&
      s.climb.l1 === prof.climb.l1 &&
      s.climb.l2 === prof.climb.l2 &&
      s.climb.l3 === prof.climb.l3,
  );
}

function renderRoster(side) {
  const host = $(`roster-${side}`);
  host.innerHTML = '';
  state.rosters[side].forEach((prof, slot) => {
    const d = derived(prof);
    const card = document.createElement('div');
    card.className = prof.plays === false ? 'robot-card bench' : 'robot-card';
    // DRIVER STATIONS close up around a benched ROBOT, so the number a card shows is its place among
    // the ROBOTs that are actually on the field, not its index in this list.
    const station = state.rosters[side].slice(0, slot + 1).filter((x) => x.plays !== false).length;
    const presetIdx = presetIndexOf(prof);
    const preset = presetIdx >= 0 ? SAMPLES[presetIdx] : null;
    const climbLevel = prof.climb.l3 ? 3 : prof.climb.l2 ? 2 : prof.climb.l1 ? 1 : 0;
    const cross = crossValue(prof);
    const crossLabel = d.canBump && d.canTrench ? 'TRENCH + BUMP' : d.canBump ? 'BUMP only' : d.canTrench ? 'TRENCH only' : 'Cannot cross';
    // Say so when the recorded value disagrees with the height rule, because that is exactly the
    // case a reader will want to know is deliberate rather than a typo.
    const crossConflict =
      (prof.canTrench === true && !d.fitsTrench) || (prof.canTrench === false && d.fitsTrench);
    card.innerHTML = `
      <div class="robot-title"><span class="dot ${side}"></span>${side === 'red' ? 'RED' : 'BLUE'} ${slot + 1} · DRIVER STATION ${prof.plays === false ? '—' : station}
        <em>${prof.plays === false ? 'BENCHED — NOT ON THE FIELD' : crossLabel}</em></div>
      <div class="robot-row">
        <label>Preset
          <select data-k="preset">
            ${SAMPLES.map((s, i) => `<option value="${i}" ${i === presetIdx ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            <option value="-1" ${presetIdx < 0 ? 'selected' : ''}>Custom</option>
          </select>
        </label>
        <label>Driver
          <select data-k="driver" title="${esc(DRIVER_OPTIONS[0].hint)}">${DRIVER_OPTIONS.map((o) => `<option value="${o.v}" title="${esc(o.hint)}" ${o.v === (prof.driver || 'average') ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>
        </label>
        <label>Starting position
          <select data-k="start">${START_OPTIONS.map((o) => `<option value="${o.v}" title="${esc(o.hint)}" ${o.v === (prof.start || 'auto') ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>
        </label>
        <label class="check" title="Turn this ROBOT off and it is not fielded at all: no start position, no preload, nothing to collide with, and the DRIVER STATIONS close up around it. Field one ROBOT on each side for a 1v1. The last ROBOT on the field cannot be turned off.">
          <input data-k="plays" type="checkbox" ${prof.plays === false ? '' : 'checked'} />
          On the field
        </label>
        <label>Shooter
          <select data-k="mechanism">
            ${MECHANISMS.map((m) => `<option value="${m.key}" title="${esc(m.hint)}" ${m.key === prof.mechanism ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </label>
        <label>Chassis
          <select data-k="chassis">${CHASSIS.map((c) => `<option value="${c.key}" title="${esc(c.hint)}" ${c.key === (prof.chassis || 'swerve') ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
        </label>
        <label title="Which face of the square carries the full-width intake slot. Back is the default because a Front slot and a front-mounted Dumper shooter share the same bumper. The ROBOT sweeps a pile by leading with the mouth, so a rear intake backs into it at the chassis's reverse speed and a side intake has to strafe — which a tank drive cannot do, and then it only picks up what the side brushes past.">Intake
          <select data-k="intakeSide">${INTAKE_SIDES.map((s) => `<option value="${s.key}" title="${esc(s.hint)}" ${s.key === (prof.intakeSide || 'back') ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        </label>
        <label title="How fast the whole car rotates, in degrees per second. A square ROBOT has to turn its shooting face onto the HUB, so this is a cycle-time number, not a cosmetic one. Changing the chassis resets it to that chassis's reference value.">Turn rate deg/s<input data-k="turnRateDegPerSec" type="number" step="10" min="30" max="1200" value="${prof.turnRateDegPerSec}" /></label>
        <label>Drive speed in/s<input data-k="driveSpeedIps" type="number" step="2" value="${prof.driveSpeedIps}" /></label>
        <label>Intake FUEL/s<input data-k="intakeRate" type="number" step="0.1" value="${prof.intakeRate}" /></label>
        <label>Capacity FUEL<input data-k="capacity" type="number" step="1" value="${prof.capacity}" /></label>
        <label>Shoot rate FUEL/s<input data-k="shootRate" type="number" step="0.1" value="${prof.shootRate}" /></label>
        <label>Accuracy<input data-k="shootAccuracy" type="number" step="0.01" min="0.1" max="0.99" value="${prof.shootAccuracy}" /></label>
        <label title="How far a PASS actually carries. The shooter throws with one fixed punch, so a partner further than this is not reached: the FUEL comes down short, on the same line, wherever it lands. The front edges of the two ALLIANCE ZONES are 334 in apart and their middle lines 493 in, so throwing from inside the opponent's zone back to a partner in your own needs about 400-500 in. Nothing to do with a shot at the HUB, which has its own reference distance and accuracy falloff.">Pass range in<input data-k="passRangeIn" type="number" step="10" min="24" max="660" value="${prof.passRangeIn}" /></label>
        <label>Height in<input data-k="heightIn" type="number" step="0.5" min="12" max="30" value="${prof.heightIn}" /></label>
        <label>Crossing
          <select data-k="cross">${CROSS_OPTIONS.map((o) => `<option value="${o.v}" ${o.v === cross ? 'selected' : ''}>${o.t}</option>`).join('')}</select>
        </label>
        <label>Passing
          <select data-k="passMode">${PASS_OPTIONS.map((o) => `<option value="${o.v}" ${o.v === (prof.passMode || 'auto') ? 'selected' : ''}>${o.t}</option>`).join('')}</select>
        </label>
        <label>Bulldozing
          <select data-k="pushMode">${PUSH_OPTIONS.map((o) => `<option value="${o.v}" ${o.v === (prof.pushMode || 'passive') ? 'selected' : ''}>${o.t}</option>`).join('')}</select>
        </label>
        <label>Outpost
          <select data-k="feedMode">${FEED_OPTIONS.map((o) => `<option value="${o.v}" ${o.v === (prof.feedMode || 'auto') ? 'selected' : ''}>${o.t}</option>`).join('')}</select>
        </label>
        <label>Max climb
          <select data-k="climbMax">${CLIMB_OPTIONS.map((o) => `<option value="${o.v}" ${o.v === climbLevel ? 'selected' : ''}>${o.t}</option>`).join('')}</select>
        </label>
        <label>Climb time s
          <input data-k="climbTime" type="number" step="0.5" min="0" max="30" value="${prof.climb.timeSec}" ${climbLevel === 0 ? 'disabled' : ''} />
        </label>
      </div>
      ${
        preset && preset.ref
          ? `<p class="prov">Reference robot · ${esc(preset.ref)}<span>Source: ${esc(preset.source || 'not given')}</span><span>Most numbers are estimates, not measurements, and do not describe what this team actually did.</span></p>`
          : presetIdx < 0
            ? '<p class="prov">Custom specs<span>Fill in your own scouting data.</span></p>'
            : ''
      }
      ${
        crossConflict
          ? `<p class="prov">Crossing disagrees with height<span>Height ${prof.heightIn}in ${d.fitsTrench ? 'fits the TRENCH' : 'cannot fit the TRENCH (> 22.25in)'}; running your setting anyway.</span></p>`
          : ''
      }`;
    card.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      const p = state.rosters[side][slot];
      if (k === 'preset') {
        const i = Number(v);
        if (i >= 0) state.rosters[side][slot] = { ...JSON.parse(JSON.stringify(SAMPLES[i])), team: SAMPLES[i].team };
      } else if (k === 'plays') {
        // A side with nobody on the field is not a match, so the last one on it cannot be benched.
        const onField = state.rosters[side].filter((x) => x.plays !== false).length;
        if (!v && onField <= 1) {
          e.target.checked = true;
          $('chip-status').textContent = `${side.toUpperCase()} needs at least one robot on the field`;
          return;
        }
        p.plays = v;
      } else if (k === 'driver') {
        p.driver = v;
      } else if (k === 'mechanism') {
        p.mechanism = v;
      } else if (k === 'chassis') {
        p.chassis = v;
        // A turn rate that is still one of the chassis reference values is a preset the user never
        // typed, so it follows the chassis; a number of their own is a measurement and is left alone.
        if (CHASSIS.some((c) => c.turnRateDegPerSec === p.turnRateDegPerSec)) {
          p.turnRateDegPerSec = CHASSIS_OF(v).turnRateDegPerSec;
        }
      } else if (k === 'intakeSide') {
        p.intakeSide = v;
      } else if (k === 'start') {
        p.start = v;
      } else if (k === 'cross') {
        if (v === 'auto') {
          p.canBump = null;
          p.canTrench = null;
        } else {
          p.canBump = v === 'both' || v === 'bump';
          p.canTrench = v === 'both' || v === 'trench';
        }
      } else if (k === 'passMode') {
        p.passMode = v;
      } else if (k === 'pushMode') {
        p.pushMode = v;
      } else if (k === 'feedMode') {
        p.feedMode = v;
      } else if (k === 'climbTime') {
        p.climb = { ...p.climb, timeSec: Math.max(0, Number(v)) };
      } else if (k === 'climbMax') {
        const n = Number(v);
        p.climb = { ...p.climb, l1: n >= 1, l2: n >= 2, l3: n >= 3 };
        if (n >= 1 && !p.climb.timeSec) p.climb.timeSec = 8;
      } else {
        p[k] = Number(v);
      }
      const keepFrame = state.frame;
      renderRoster(side);
      renderTeams();
      state.frame = keepFrame;
    });
    host.appendChild(card);
  });
}

// The six ROBOT teams, shown next to their score the way the audience display names the ALLIANCE.
// Benched ROBOTs are left out because the score beside this list is only the fielded ROBOTs' — a
// header reading three teams over a one-ROBOT score would be the wrong count. Empty slots and
// hand-edited profiles read "—" rather than silently reusing a preset number.
function renderTeams() {
  const rosters = replayRosters();
  for (const side of ['red', 'blue']) {
    $(`teams-${side}`).textContent = rosters[side]
      .filter(onField)
      .map((p) => (p.team ? String(p.team) : '—'))
      .join(' · ');
  }
  // The FIELD labels each ROBOT with its team number, so the map from DRIVER STATION to team has to
  // be visible next to the FIELD as well as in the header. The map handed to the canvas is the roster
  // that is actually on the field, because a recorded frame's order is the fielded order.
  view.setRoster({
    red: rosters.red.filter(onField),
    blue: rosters.blue.filter(onField),
  });
  renderLegend();
}

// A ROBOT with `plays: false` is on the bench: not fielded, so it is not in the match, the replay or
// the DRIVER STATION numbering.
const onField = (p) => p.plays !== false;

function replayRosters() {
  if (state.result && state.lastPayload?.profilesRed && state.lastPayload?.profilesBlue) {
    return { red: state.lastPayload.profilesRed, blue: state.lastPayload.profilesBlue };
  }
  if (state.result?.robotStats) {
    return Object.fromEntries(['red', 'blue'].map((side) => [
      side, state.result.robotStats.filter((robot) => robot.alliance === side),
    ]));
  }
  return state.rosters;
}

function renderLegend() {
  const items = view.legend();
  const html = items.map((l) => `<span><i style="background:${l.c}"></i>${l.t}</span>`).join('');
  // One chip per ROBOT, and the chips are buttons: with six team plates on a 650 in FIELD a replay
  // gets busy, so clicking a chip focuses that car and dims the rest. Clicking it again releases it.
  const roster = [];
  // The engine numbers ROBOTs red first then blue, over the ROBOTs that are on the field only, so a
  // benched ROBOT gets no chip and does not consume an index.
  let idx = 0;
  for (const side of ['red', 'blue']) {
    roster.push(`<span class="roster-side">${side === 'red' ? 'RED' : 'BLUE'}</span>`);
    let station = 0;
    for (const p of replayRosters()[side]) {
      if (p.plays === false) continue;
      station += 1;
      const on = state.focus.has(idx);
      roster.push(
        `<button type="button" class="roster-chip${on ? ' on' : ''}" data-idx="${idx}" title="Watch just this robot (click again to release)">${
          station
        }·${p.team ? p.team : '—'}</button>`,
      );
      idx += 1;
    }
  }
  $('legend').innerHTML = html + roster.join('');
  for (const b of document.querySelectorAll('.roster-chip')) {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.idx);
      if (state.focus.has(i)) state.focus.delete(i);
      else state.focus.add(i);
      view.setFocus(state.focus);
      renderLegend();
      if (state.timeline) drawAt(state.playT);
      else view.drawFrame(null, null);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Field playback
// ---------------------------------------------------------------------------------------------
const view = new FieldView($('field'));

function renderPeriodStrip(schedule) {
  hudPeriod = null;
  const host = $('period-strip');
  const segs = [{ p: 'AUTO', sec: TIME.autoSec }, { p: 'TRANSITION', sec: TIME.transitionSec }];
  for (let i = 1; i <= 4; i++) segs.push({ p: `SHIFT ${i}`, sec: TIME.shiftSec });
  segs.push({ p: 'END GAME', sec: TIME.endgameSec });
  // Clicking a segment jumps the replay to the start of that phase, which is how a reader gets back
  // to the SHIFT they were looking at without scrubbing for it.
  let at = 0;
  host.innerHTML = segs
    .map((s) => {
      const row = schedule ? schedule.find((r) => r.period === s.p) : null;
      const cls = !row ? 'rb' : row.red && row.blue ? 'rb' : row.red ? 'r' : 'b';
      const hub = !row ? 'R+B' : row.red && row.blue ? 'R+B both' : row.red ? 'RED ACTIVE' : 'BLUE ACTIVE';
      const start = at;
      at += s.sec;
      return `<div class="seg ${cls}" data-period="${s.p}" data-start="${start}" role="button" tabindex="0" title="Jump to the start of ${s.p} (${clock(start)})"><strong>${s.p}</strong><small>${hub}</small><small>${s.sec}s</small></div>`;
    })
    .join('');
  for (const seg of host.querySelectorAll('.seg')) {
    seg.addEventListener('click', () => goToTime(Number(seg.dataset.start)));
    seg.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      seg.click();
    });
  }
}

// A recorded frame is an anchor, and the display runs at the browser's refresh rate, so the picture is
// rebuilt by blending the two anchors that bracket the current match time. FUEL is blended per ball —
// the recorded samples carry the FUEL's index, without which a blend would smear one ball into another
// as the loose set churns. A ROBOT that "jumps" is not blended at all: the TRANSITION dismount and the
// TOWER snap are teleports, and interpolating them would animate a slide across the FIELD.
const TELEPORT_IN = 60;

function blendFrame(f0, f1, alpha) {
  const a = Math.min(1, Math.max(0, alpha));
  // Only the position is blended. Everything else in the entry (kind, flight target, time left, the
  // shooter's index) is carried through whole from whichever anchor is nearer, because half a kind is
  // not a thing the renderer can draw: a ball that lands mid-blend should switch from a glowing shot
  // to a loose FUEL at the halfway point, not fade between the two.
  const other = new Map();
  for (const f of f1.fuel) other.set(f[0], f);
  const fuel = [];
  const nearOf = (x, y) => (a < 0.5 ? x : y);
  for (const f of f0.fuel) {
    const b = other.get(f[0]);
    if (!b) {
      fuel.push(f);
      continue;
    }
    const out = nearOf(f, b).slice();
    out[1] = f[1] + (b[1] - f[1]) * a;
    out[2] = f[2] + (b[2] - f[2]) * a;
    fuel.push(out);
    other.delete(f[0]);
  }
  // A ball only in f1 appears: nothing to interpolate, but it still has to carry its kind, or a shot
  // that was launched between the two anchors would be drawn as a loose ball for one anchor.
  for (const [, f] of other) fuel.push(f);
  const r = f0.r.map((ra, i) => {
    const rb = f1.r[i];
    if (!rb || rb.i !== ra.i) return ra;
    if (Math.abs(rb.x - ra.x) + Math.abs(rb.y - ra.y) > TELEPORT_IN) return ra;
    const out = { ...ra, x: ra.x + (rb.x - ra.x) * a, y: ra.y + (rb.y - ra.y) * a };
    // Heading is an angle, so the blend has to go the short way round: the linear mean of +179 deg and
    // -179 deg is 0, which would spin a car through a whole turn instead of holding it still.
    if (typeof ra.h === 'number' && typeof rb.h === 'number') {
      let d = (rb.h - ra.h) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d <= -Math.PI) d += Math.PI * 2;
      out.h = ra.h + d * a;
    }
    return out;
  });
  const near = a < 0.5 ? f0 : f1;
  return { t: f0.t + (f1.t - f0.t) * a, p: near.p, hub: near.hub, fuel, r, s: near.s, hp: near.hp };
}

// Which recorded anchor is at or before match time `t`.
function anchorAt(t) {
  const tl = state.timeline;
  let lo = 0;
  let hi = tl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---- Replay navigation: a ruler of the interesting moments, and somewhere to jump to -------------
// A 2:40 MATCH is 1600 anchors, so scrubbing to the one foul or the one climb means hunting. The
// engine already logs these events with their match time, so the replay draws them instead of asking
// the eye to find them.
const MARKER_KIND = { foul: 'foul', towerAwarded: 'climb', climb: 'climb', fault: 'fault' };

function replayMarkers() {
  // The worker strips `recorded` and re-posts that match's `events` at the top level of the result,
  // so the replay reads the same array renderDetail does.
  const events = (state.result && state.result.events) || [];
  const last = state.timeline && state.timeline.length ? state.timeline[state.timeline.length - 1].t : 0;
  return events
    .map((e) => ({ ...e, cls: MARKER_KIND[e.kind] }))
    .filter((e) => e.cls && e.t <= last)
    .sort((a, b) => a.t - b.t);
}

function renderMarkers() {
  const host = $('scrub-marks');
  const marks = replayMarkers();
  state.markerTimes = marks.map((m) => m.t);
  const last = state.timeline && state.timeline.length ? state.timeline[state.timeline.length - 1].t : 1;
  const label = (m) => {
    if (m.kind === 'foul') return m.reason || 'FOUL';
    if (m.kind === 'climb') return `ROBOT ${m.robot + 1} climbs to LEVEL ${m.level} in ${m.period}`;
    if (m.kind === 'towerAwarded') return `TOWER points to ROBOT ${m.robot + 1} (${m.reason})`;
    if (m.kind === 'fault') return `${m.hard ? 'hard' : 'soft'} fault — ROBOT ${m.robot + 1} ${m.hard ? 'disabled' : 'impaired'}`;
    return m.kind;
  };
  host.innerHTML = marks
    .map(
      (m) =>
        `<i class="${m.cls}" role="listitem" style="left:${((m.t / (last || 1)) * 100).toFixed(2)}%" data-t="${m.t}" title="${fmt(m.t, 1)}s · ${esc(label(m))}"></i>`,
    )
    .join('');
  for (const tick of host.querySelectorAll('i')) {
    tick.addEventListener('click', () => goToTime(Number(tick.dataset.t)));
  }
}

// Pausing on a jump is deliberate: the point of the jump is to LOOK at that moment.
function goToTime(t) {
  if (!state.timeline || !state.timeline.length) return;
  pausePlayback();
  setFrame(anchorAt(t));
}

function stepFrames(n) {
  if (!state.timeline || !state.timeline.length) return;
  // Keyboard steps are seconds, including recordings exported at a different anchor stride.
  goToTime(state.playT + n * 0.1);
}

function jumpEvent(dir) {
  const times = state.markerTimes || [];
  if (!times.length) return;
  const now = state.timeline && state.timeline[state.frame] ? state.timeline[state.frame].t : 0;
  const next = dir > 0 ? times.find((t) => t > now + 0.05) : [...times].reverse().find((t) => t < now - 0.05);
  if (next === undefined) return;
  goToTime(next);
}

// The recording carries no "rollers on" flag, because the engine runs the intake whenever the ROBOT
// is sweeping — including while it shoots or passes. A carry count that goes UP between two anchors
// can only have come from the intake, so that rise is the flag: a ROBOT gaining FUEL while its mode
// is SCORE or PASS is sweeping and shooting at once, and the replay marks its glyph with a "+".
function markSweep(frame, prevFrame, nextFrame) {
  const carried = (src) => {
    const m = new Map();
    if (src) for (const r of src.r) m.set(r.i, r.c);
    return m;
  };
  const before = carried(prevFrame);
  const after = carried(nextFrame);
  for (const r of frame.r) {
    const p = before.get(r.i);
    const n = after.get(r.i);
    const gained = (p !== undefined && r.c > p) || (n !== undefined && n > r.c);
    r.sweep = gained && (r.m === 'SCORE' || r.m === 'PASS') ? 1 : 0;
  }
  return frame;
}

// An older recording carries only a rising FUEL count per side, a newer one the HP's action and door
// state. Both read as "is this HUMAN PLAYER doing something right now" for the ring the view draws,
// and the newer shape additionally drives the door arm, so the two plays stay distinguishable.
function markHuman(frame, prevFrame, nextFrame) {
  const hp = frame.hp || null;
  const before = (prevFrame || frame).hp || null;
  const after = (nextFrame || frame).hp || null;
  const active = (side, i) => {
    if (hp && hp[side] && typeof hp[side] === 'object') return hp[side].a !== 'HOLD';
    return !!(before && after && after[i] > before[i]);
  };
  frame.hpActive = { red: active('red', 0), blue: active('blue', 1) };
  return frame;
}

let hudFrame = null;
let hudHub = '';
let hudPeriod = null;

function paintHud(f, t) {
  $('scrub').value = String(state.frame);
  const timer = $('timer-label');
  const remaining = clock(TIME.matchSec - t);
  if (timer.textContent !== remaining) timer.textContent = remaining;
  if (hudFrame === f && hudPeriod === f.p) return;
  hudFrame = f;
  // The audience display's key tell is which HUB is live, so the header answers that with a YELLOW
  // ARROW aimed at the ALLIANCE that can still score. Both arrows light while both HUBs are active
  // (AUTO / TRANSITION / END GAME), so the arrow only separates the two sides during the SHIFTs.
  const strip = $('hub-strip');
  const both = f.hub.red && f.hub.blue;
  const hubKey = both ? 'both' : f.hub.red ? 'red' : f.hub.blue ? 'blue' : 'none';
  if (hudHub !== hubKey) {
    hudHub = hubKey;
    strip.className = `hub-strip ${hubKey}`;
    strip.innerHTML =
    `<i class="ar${f.hub.red ? ' on' : ''}">◀</i>` +
    `<span>${both ? 'BOTH HUBS ACTIVE' : f.hub.red ? 'RED HUB ACTIVE' : f.hub.blue ? 'BLUE HUB ACTIVE' : 'BOTH HUBS OFF'}</span>` +
    `<i class="ar${f.hub.blue ? ' on' : ''}">▶</i>`;
  }
  $('score-red').textContent = String(f.s.red.total);
  $('score-blue').textContent = String(f.s.blue.total);
  const delta = f.s.red.total - f.s.blue.total;
  const ml = $('margin-label');
  ml.textContent = delta === 0 ? 'TIE' : `${delta > 0 ? 'RED' : 'BLUE'} +${Math.abs(delta)}`;
  ml.className = `margin ${delta === 0 ? 'tie' : delta > 0 ? 'red' : 'blue'}`;
  // The recorder carries foul POINTS credited, not a count of opponent infractions.
  $('detail-red').textContent = `FUEL ${f.s.red.fuel} · TOWER ${f.s.red.tower} · +${f.s.red.fouls} BLUE foul points`;
  $('detail-blue').textContent = `FUEL ${f.s.blue.fuel} · TOWER ${f.s.blue.tower} · +${f.s.blue.fouls} RED foul points`;
  // The RP ladder, on the frame the scrubber is sitting on rather than at the whistle. The two counters it
  // reads are still climbing until the MATCH ends, and TOWER points in particular are not assessed until
  // after it (§6.5-B/D), so this line answers "what would this be worth if the MATCH stopped here".
  const th = state.result && state.result.final && state.result.final.red && state.result.final.red.rp && state.result.final.red.rp.thresholds;
  if (th) {
    $('rp-live-red').textContent = rpLadder(f.s.red, th);
    $('rp-live-blue').textContent = rpLadder(f.s.blue, th);
  } else {
    $('rp-live-red').textContent = '';
    $('rp-live-blue').textContent = '';
  }
  // The same instant the two lines above are read from, drawn on the trend chart. Once a second is enough:
  // the marker is a second wide on a 160 s axis, so a faster redraw moves it less than a pixel.
  trendMarkerAt(t);
  if (hudPeriod !== f.p) {
    hudPeriod = f.p;
    $('period-label').textContent = f.p;
    for (const el of document.querySelectorAll('.period-strip .seg')) {
      el.classList.toggle('cur', el.dataset.period === f.p);
    }
  }
}

// Draw the MATCH at an arbitrary instant inside the recording.
function drawAt(t) {
  const tl = state.timeline;
  if (!tl || !tl.length) return;
  const i = anchorAt(t);
  const f0 = tl[i];
  const f1 = tl[i + 1] || null;
  state.frame = i;
  const prev = tl[i - 1] || null;
  if (!f1) {
    view.drawFrame(markHuman(markSweep(f0, prev, null), prev, null), null);
    paintHud(f0, t);
    return;
  }
  const span = Math.max(1e-6, f1.t - f0.t);
  const a = Math.min(1, Math.max(0, (t - f0.t) / span));
  view.drawFrame(markHuman(markSweep(blendFrame(f0, f1, a), prev, f1), prev, f1), null);
  paintHud(a < 0.5 ? f0 : f1, t);
}

function setFrame(idx) {
  const tl = state.timeline;
  if (!tl) return;
  const i = Math.max(0, Math.min(tl.length - 1, idx));
  state.playT = tl[i].t;
  drawAt(state.playT);
}

// ---------------------------------------------------------------------------------------------
// Presentation: two ways to watch a MATCH like a video.
//   Fill (cinema) — the FIELD takes the viewport and the other panels step aside. Browser chrome
//                   stays, so it is the mode to use when jumping between this tab and something else.
//   Fullscreen    — the Fullscreen API, so the browser chrome goes away entirely.
// Both need the canvas measured against the space that is actually left over, which is what the
// `box` argument to FieldView.resize() is for.
// ---------------------------------------------------------------------------------------------
function fieldBox() {
  const panel = document.querySelector('.field-panel');
  const canvas = $('field');
  let chrome = 0;
  for (const c of panel.children) {
    if (c === canvas || c.tagName === 'CANVAS') continue;
    chrome += c.getBoundingClientRect().height + 8;
  }
  // window.innerHeight is the viewport in a normal browser; the documentElement fallback covers a
  // host that reports no rendering surface at all, where innerHeight is 0.
  const viewH = window.innerHeight || document.documentElement.clientHeight || 800;
  return {
    w: Math.max(240, panel.clientWidth - 34),
    h: Math.max(160, viewH - chrome - 24),
  };
}

function relayoutStage() {
  const immersive = state.cinema || !!document.fullscreenElement;
  if (immersive) view.resize(fieldBox());
  else view.resize();
  if (state.timeline) drawAt(state.playT);
  else view.drawFrame(null, null);
  if (state.result) redrawInsightCharts();
}

function setCinema(on) {
  state.cinema = on;
  document.body.classList.toggle('cinema', on);
  const btn = $('btn-cinema');
  if (btn) btn.textContent = on ? 'Exit fill' : 'Fill';
  requestAnimationFrame(relayoutStage);
}

function toggleFullscreen() {
  const panel = document.querySelector('.field-panel');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (panel.requestFullscreen) panel.requestFullscreen({ navigationUI: 'hide' }).catch(() => setCinema(true));
  else setCinema(!state.cinema);
}

function clock(sec) {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function pausePlayback() {
  cancelAnimationFrame(state.raf);
  state.raf = 0;
  state.playing = false;
  state.lastTs = 0;
  $('btn-play').textContent = 'Play';
}

function startPlayback() {
  pausePlayback();
  if (!state.timeline?.length) return;
  if (state.playT >= state.timeline[state.timeline.length - 1].t) setFrame(0);
  state.playing = true;
  $('btn-play').textContent = 'Pause';
  state.raf = requestAnimationFrame(animate);
}

function animate(ts) {
  state.raf = 0;
  if (!state.playing) return;
  if (!state.lastTs) state.lastTs = ts;
  const dt = Math.min(0.25, (ts - state.lastTs) / 1000);
  state.lastTs = ts;
  const end = state.timeline[state.timeline.length - 1].t;
  state.playT += dt * state.speed;
  if (state.playT >= end) {
    state.playT = end;
    drawAt(end);
    pausePlayback();
    return;
  }
  drawAt(state.playT);
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
    contactFouls: $('chk-contactfouls').checked,
    humanThrowPerSec: { red: state.humanThrow.red, blue: state.humanThrow.blue },
    humanAccuracy: { red: state.humanAcc.red, blue: state.humanAcc.blue },
  };
}

function payload(extra = {}) {
  return {
    profilesRed: state.rosters.red,
    profilesBlue: state.rosters.blue,
    weights: state.weights,
    seed: Number($('inp-seed').value) || 20260110,
    iterations: Math.max(1, Math.round(Number($('inp-iter').value) || 200)),
    scenarioOverride: scenarioOverride(),
    ...extra,
  };
}

// Which ALLIANCE the AI plans for. The other side plays the baseline, so this is a change of question
// and not a change of display: the plan, the opponent posterior, the score distribution and every
// insight below are all read from this seat, and a batch run under the other one answers it wrongly.
function plannedSide() {
  const el = $('sel-aiside');
  return el && el.value === 'blue' ? 'blue' : 'red';
}

// Who drives the other ALLIANCE. 'ai' is the only value that is not a baseline: it hands the opposite
// seat the same search, which turns the run into a mirror of your own roster rather than a measurement
// against the hand-written plan the calibration figures use.
const OPPONENT_LABEL = {
  greedy: 'the greedy baseline',
  shootalways: 'the shoot-always baseline',
  random: 'the random baseline',
  ai: 'the same AI on both sides',
};
function opponentPick() {
  const el = $('sel-opponent');
  const v = el ? el.value : 'greedy';
  const kind = OPPONENT_LABEL[v] ? v : 'greedy';
  return { kind, mode: kind === 'ai' ? 'aiVsAi' : 'vsBaseline', label: OPPONENT_LABEL[kind] };
}

// ---------------------------------------------------------------------------------------------
// Chart helpers (plain canvas, no libraries)
// ---------------------------------------------------------------------------------------------
const AXIS = '#6f809b';
const GRID = '#1e2836';

function prepCanvas(canvas, fallbackW = 320, fallbackH = 120) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || fallbackW;
  const h = canvas.clientHeight || fallbackH;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// Horizontal gridlines with value labels, shared by both charts so the axis reads the same.
function drawYAxis(ctx, w, h, padL, padB, padT, lo, hi, fmt) {
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const f of [0, 0.5, 1]) {
    const y = h - padB - f * (h - padB - padT);
    ctx.strokeStyle = f === 0 ? '#33415a' : GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(w - 4, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = AXIS;
    ctx.fillText(fmt(lo + (hi - lo) * f), padL - 5, y);
  }
}

function barChart(canvas, values, labels, color = '#2f7de1') {
  const { ctx, w, h } = prepCanvas(canvas);
  const padL = 26;
  const padB = 15;
  const padT = 13;
  const plotH = Math.max(1, h - padB - padT);
  const max = Math.max(1, ...values);
  const bw = (w - padL - 4) / Math.max(1, values.length);
  drawYAxis(ctx, w, h, padL, padB, padT, 0, max, (v) => String(Math.round(v)));

  values.forEach((v, i) => {
    const bh = (plotH * v) / max;
    const x = padL + i * bw + 2;
    const y = h - padB - bh;
    const barW = Math.max(1, bw - 4);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barW, bh, Math.min(3, barW / 2));
    else ctx.rect(x, y, barW, bh);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (v > 0 && bw > 26) {
      ctx.fillStyle = '#cdd8e8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(v), x + barW / 2, Math.max(padT, y - 4));
    }
  });

  if (labels && labels.length) {
    ctx.fillStyle = AXIS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const step = Math.max(1, Math.ceil((labels.length * 24) / Math.max(1, w - padL)));
    labels.forEach((l, i) => {
      if (i % step === 0) ctx.fillText(l, padL + i * bw + bw / 2, h - 4);
    });
  }
}

function lineChart(canvas, points, color = '#ffd94a') {
  const { ctx, w, h } = prepCanvas(canvas);
  if (!points || !points.length) return;
  const padL = 30;
  const padB = 12;
  const padT = 12;
  const padR = 8;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = Math.max(1e-6, max - min);
  const X = (i) => padL + (i / Math.max(1, points.length - 1)) * (w - padL - padR);
  const Y = (p) => h - padB - ((p - min) / span) * (h - padB - padT);
  drawYAxis(ctx, w, h, padL, padB, padT, min, max, (v) => v.toFixed(2));

  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p)) : ctx.moveTo(X(i), Y(p))));
  ctx.lineTo(X(points.length - 1), h - padB);
  ctx.lineTo(X(0), h - padB);
  ctx.closePath();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p)) : ctx.moveTo(X(i), Y(p))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const li = points.length - 1;
  ctx.beginPath();
  ctx.arc(X(li), Y(points[li]), 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = '#cdd8e8';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(points[li].toFixed(3), w - padR, Math.max(padT + 8, Y(points[li]) - 6));
}

// ---------------------------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------------------------
const ROLE_LABEL = { SCORE: 'Score', DEFEND: 'Defend', CLIMB: 'Climb' };
const INTENT_LABEL = {
  COLLECT: 'Sweep',
  STOCKPILE: 'Hold',
  SCORE: 'Score',
  PASS: 'Pass',
  PUSH: 'Push',
  DEFEND: 'Defend/Block',
  CLIMB: 'Climb',
  FEED: 'Feed',
  IDLE: 'Idle',
};

// A batch and a replay are different objects and used to be shown under one heading, so a reader could
// not tell which numbers came from 120 matches and which from the single match on screen. Everything
// below states its own scope, and a one-match run hides the distribution blocks rather than drawing a
// "distribution" of one sample.
function renderResult(res, ctx = {}) {
  state.result = res;
  renderTeams();
  const r = res;
  const matches = r.matches || ctx.matches || 1;
  const seed = ctx.seed == null ? '—' : ctx.seed;
  const opp = ctx.opponentLabel || (ctx.opponentKind ? `${ctx.opponentKind} baseline` : 'the baseline');
  const side = (ctx.aiSide || 'red').toUpperCase();
  $('scope-batch').innerHTML =
    ctx.batchMatch
      ? `<b>MATCH ${ctx.batchMatch} of the ${ctx.batchTotal}-MATCH batch</b> · seed ${seed} · replayed under the settings that batch ran · ${side} was the AI against ${opp}. The cards above are this one MATCH; the notable list below still belongs to the batch.`
      : matches > 1
      ? `<b>Monte-Carlo batch · ${matches} matches</b> · seed ${seed} · ${side} is the AI against ${opp} · objective ${ctx.objective || 'rs'} · ${ctx.event === 'districtChamp' ? 'DCMP thresholds' : 'regional thresholds'}`
      : `<b>One match, no distribution</b> · seed ${seed} · ${side} is the AI against ${opp}. Run the Monte-Carlo batch (10 or more matches) for win rates, spread and RP chances.`;
  $('batch-blocks').hidden = matches <= 1;

  $('prob-cards').innerHTML = [
    ['Win rate (ties half)', pct(r.winRate), `${r.wins}W / ${r.losses}L / ${r.ties}T  ·  ${matches} ${matches === 1 ? 'match' : 'matches'}`],
    ['AI average score', fmt(r.avgAiScore, 0), `opponent ${fmt(r.avgOppScore, 0)} · margin ${sign(r.avgMargin)}${fmt(Math.abs(r.avgMargin), 0)}`],
    ['Average FUEL in the HUB', fmt(r.avgFuel, 0), `SUPERCHARGED needs ${r.thresholds.supercharged.regional}`],
    ['Average TOWER points', fmt(r.avgTower, 0), `TRAVERSAL needs ${r.thresholds.traversal.regional}`],
    ['Chance of winning AUTO', pct(r.autoWinRate), 'the AUTO winner sits out SHIFT 1 (Table 6-3)'],
    ['Expected ranking points', fmt(r.rpProb.expected, 2), 'the only thing qualification ranking looks at'],
  ]
    .map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
    .join('');

  const labels = r.scoreHist.map((_, i) => `${i * 50}`);
  barChart($('chart-score'), r.scoreHist, labels, '#2f7de1');

  // The margin histogram was collected from the first build and never drawn, which left "we win 36% of
  // the time" with no answer to "by how much".
  const mLabels = r.deltaHist.map((_, i) => `${i * 50 - 250}`);
  barChart($('chart-margin'), r.deltaHist, mLabels, '#7ad0a6');

  const rpRows = [
    ['ENERGIZED RP', r.rpProb.energized, `FUEL into the active HUB ≥ ${r.thresholds.energized.regional}`],
    ['SUPERCHARGED RP', r.rpProb.supercharged, `FUEL into the active HUB ≥ ${r.thresholds.supercharged.regional}`],
    ['TRAVERSAL RP', r.rpProb.traversal, `TOWER points ≥ ${r.thresholds.traversal.regional}`],
    ['Win RP', r.rpProb.win, 'win 3 points / tie 1'],
  ];
  $('rp-list').innerHTML = rpRows
    .map(
      ([name, p, note]) => `
      <div class="rp-row"><span>${name}<br /><small class="hint">${note}</small></span><strong class="mono">${pct(p)}</strong>
      <div class="rp-bar"><i style="width:${Math.round(p * 100)}%"></i></div></div>`,
    )
    .join('');

  renderBatchTable(r, ctx);
  renderBatchDelta(r, ctx);

  renderPlan(r.plan, r);
  renderPosterior(r.plan);
  renderInsights(r);
  renderDetail(r);
  renderFlow(r);
  renderMatchCharts(r);
  renderFouls(r);
  renderFoulBatch(r);
  renderFoulStrip(r);
  renderPeriodStrip(r.hubSchedule);
  renderMarkers();
  renderAutoNote(r);
  $('tab-insight').classList.remove('is-empty');
}

const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
const pct = (v) => `${Math.round(v * 100)}%`;

// The per-MATCH numbers a planner argues about, which the batch used to reduce to "average score".
function renderBatchTable(r, ctx) {
  const at = r.at;
  const atRow = (key) => r.rows?.[at?.[key]];
  const where = (key) => (atRow(key) ? ` · MATCH ${atRow(key).n}` : '');
  const marginNote = at
    ? `widest win ${sign(atRow('bestMargin')?.margin ?? r.bestMargin)}${fmt(Math.abs(atRow('bestMargin')?.margin ?? r.bestMargin), 0)}${where('bestMargin')}, widest loss ${sign(atRow('worstMargin')?.margin ?? 0)}${fmt(Math.abs(atRow('worstMargin')?.margin ?? 0), 0)}${where('worstMargin')}`
    : `best ${sign(r.bestMargin)}${fmt(Math.abs(r.bestMargin), 0)}`;
  const scoreNote = at
    ? `AI scores ran ${fmt(r.worstScore, 0)} (MATCH ${atRow('worstAi')?.n}) to ${fmt(r.bestScore, 0)} (MATCH ${atRow('bestAi')?.n})`
    : `scores ranged ${fmt(r.worstScore, 0)} to ${fmt(r.bestScore, 0)}`;
  const rows = [
    ['Point margin', `${sign(r.avgMargin)}${fmt(Math.abs(r.avgMargin), 0)} per match`, `${marginNote} · ${scoreNote}`],
    ['Highest / lowest combined', at ? `${r.bestTotal} · MATCH ${atRow('bestTotal')?.n}` : `${fmt(r.bestTotal, 0)}`, at ? `${r.worstTotal} · MATCH ${atRow('worstTotal')?.n}` : `${fmt(r.worstTotal, 0)}`],
    ['FUEL scored in AUTO', fmt(r.avgAutoFuel, 0), 'real finals 111–177; the AUTO winner sits out SHIFT 1 (Table 6-3)'],
    ['Foul points won / given away', `${fmt(r.avgFoulsWon, 1)} / ${fmt(r.avgFoulsGiven, 1)}`, 'Table 6-6: MINOR 5, MAJOR 15 to the opponent'],
    [
      'G415/G416/G417 contact fouls',
      r.contactFoulsPerMatch > 0
        ? `${fmt(r.contactFoulsPerMatch, 2)} per match · ${pct(r.contactMatchShare)} of matches`
        : 'none this batch',
      r.avgImpairedSec > 0
        ? `${fmt(r.avgImpairedSec, 1)} robot-seconds impaired per match (§7.4.4 switch on)`
        : 'the hard-contact switch is off, or nothing was damaged (see Hard contact between ROBOTS)',
    ],
  ];
  $('batch-table').innerHTML = `<tbody>${rows
    .map(([k, v, note]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td><td class="hint">${esc(note)}</td></tr>`)
    .join('')}</tbody>`;
}

// Changing one setting and running the batch again is the only way to attribute a difference, so keep
// the previous batch's headline numbers and show the move. Two batches only compare as "the effect of
// the one thing I changed" while nothing else moved, so the snapshot decides whether to say that.
const DIFF_LABEL = {
  seed: 'the seed',
  side: 'which alliance the AI plans for',
  objective: 'the objective',
  event: 'the event (regional / DCMP thresholds)',
  autoWinner: 'who wins AUTO',
  towerL1TeleopAllowed: 'L1 climbs in teleop',
  faultsEnabled: 'the fault switch',
  contactFouls: 'the hard-contact switch',
  humanThrow: "the HUMAN PLAYER's throw rate",
  humanAcc: "the HUMAN PLAYER's accuracy",
  red: 'the red ROBOTs',
  blue: 'the blue ROBOTs',
  weights: 'the policy weights',
  iterations: 'the search budget',
};

function renderBatchDelta(r, ctx) {
  const host = $('batch-delta');
  if (r.matches <= 1) {
    host.innerHTML = '';
    return;
  }
  const prev = state.prevBatch;
  const now = {
    win: r.winRate * 100,
    score: r.avgAiScore,
    margin: r.avgMargin,
    rp: r.rpProb.expected,
    matches: r.matches,
    seed: ctx.seed,
    snapshot: ctx.snapshot || null,
  };
  if (prev) {
    const changed =
      prev.snapshot && now.snapshot
        ? Object.keys(now.snapshot).filter((k) => now.snapshot[k] !== prev.snapshot[k]).map((k) => DIFF_LABEL[k] || k)
        : [];
    const note =
      changed.length === 0
        ? '<span>Same settings as the previous batch.</span><br />'
        : changed.length === 1
          ? `<span>The settings changed in one place (${changed[0]}), so the move is that setting's effect and nothing else.</span><br />`
          : `<b style="color:var(--warn)">These two batches were not run on the same settings (${changed.join(', ')}), so the move compares two different questions rather than one change.</b><br />`;
    const cell = (name, a, b, digits = 1) => {
      const d = a - b;
      const cls = Math.abs(d) < 0.05 ? '' : d > 0 ? 'up' : 'down';
      const num = (v) => v.toFixed(digits).replace('-', '−');
      return `<b>${name}</b> ${num(b)} → ${num(a)} <span class="${cls}">(${sign(d)}${Math.abs(d).toFixed(digits)})</span>`;
    };
    host.innerHTML =
      note +
      `<span>Against the previous batch (${prev.matches} matches, seed ${prev.seed}):</span><br />` +
      cell('win', now.win, prev.win, 0) +
      ' · ' +
      cell('score', now.score, prev.score, 0) +
      ' · ' +
      cell('margin', now.margin, prev.margin, 0) +
      ' · ' +
      cell('RP', now.rp, prev.rp, 2) +
      ' <button class="btn small" id="btn-clear-delta" type="button">clear</button>';
    const b = $('btn-clear-delta');
    if (b) {
      b.addEventListener('click', () => {
        state.prevBatch = null;
        host.innerHTML = '';
      });
    }
  } else {
    host.innerHTML = '<span>Change one setting and run the batch again and this line will show the move.</span>';
  }
  state.prevBatch = now;
}

// Which ALLIANCE took AUTO decides which two SHIFTs belong to whom (Table 6-3), and that is the
// single most counter-intuitive thing in this game: winning AUTO buys points and sells a window.
function renderAutoNote(r) {
  const host = $('auto-note');
  const af = r && r.autoFuel;
  if (!r || !r.hubSchedule || !af) {
    host.textContent = '';
    return;
  }
  const tie = af.red === af.blue;
  const w = r.autoWinner;
  const who = w === 'red' ? 'red' : 'blue';
  const other = w === 'red' ? 'blue' : 'red';
  const off = r.hubSchedule.filter((x) => String(x.period).startsWith('SHIFT') && x[w] === false).map((x) => x.period);
  host.innerHTML =
    `<b>AUTO ${af.red} : ${af.blue}</b> ${tie ? 'tied → FMS assigns it at random' : `→ <b>${who}</b> scored more`}` +
    ` Table 6-3: the ${who} HUB is off in <b>${off.join(' / ')}</b>, so those two shifts are the ${other} alliance's exclusive scoring window.`;
}

function renderPlan(plan, res) {
  const host = $('plan-view');
  // The replay scope line: the plan and the posterior come from the ONE recorded match, not from the
  // batch above, and after a 1v1 the table has to have one row rather than three.
  const fielded = res && res.robotStats ? res.robotStats : null;
  const redN = fielded ? fielded.filter((x) => x.alliance === 'red').length : 3;
  const blueN = fielded ? fielded.filter((x) => x.alliance === 'blue').length : 3;
  const seat = plan ? (plan.side === 'blue' ? 'BLUE' : 'RED') : null;
  $('scope-replay').innerHTML = fielded
    ? `<b>This replay</b> · the recorded match (the first of the batch, or the single match you ran) · ${redN}v${blueN} ROBOTs on the FIELD. The plan and the archetype below are the AI's from this one match, read from the <b>${seat}</b> seat.`
    : '';
  if (!plan) {
    host.innerHTML = '<p class="hint">No plan yet. Run a match or the Monte Carlo batch first.</p>';
    return;
  }
  const periods = PERIODS.filter((p) => p !== 'AUTO');
  const head = periods.map((p) => `<th>${p}<br /><small class="hint">${periodSeconds(p)}s</small></th>`).join('');
  const aiSide = plan.side === 'blue' ? 'blue' : 'red';
  const ownN = aiSide === 'red' ? redN : blueN;
  const rows = Array.from({ length: ownN }, (_, slot) => slot)
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
    .join(', ');
  const towerPts = (climb.levels || []).slice(0, climb.count).reduce((a, l) => a + (l === 1 ? (scenarioOverride().towerL1TeleopAllowed ? POINTS.tower.l1Teleop : 0) : l === 2 ? POINTS.tower.l2Teleop : POINTS.tower.l3Teleop), 0);
  host.innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>Role by shift · ${aiSide.toUpperCase()}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint" style="margin-top:8px">
      AUTO plan: shooting at ${Math.round(auto.fuelTarget * 100)}% strength, sending ${auto.climbCount} robot(s) for LEVEL 1 (15 points each, 2 max).
    </p>
    <p class="hint">
      END GAME climb ladder: ${climb.count === 0 ? 'no climb' : `${lanes} (starts at ${fmt(climb.startAt, 0)}s)`},
      TOWER total ${towerPts} points → TRAVERSAL RP (≥${POINTS.rpThreshold.traversal.regional}) ${towerPts >= POINTS.rpThreshold.traversal.regional ? '<b style="color:var(--good)">met</b>' : '<b style="color:var(--warn)">not met</b>'}.
    </p>
    <p class="hint">MCTS search: ${plan.stats ? plan.stats.rollouts : 0} rollouts across ${plan.stats ? plan.stats.calls : 0} decision points.</p>`;
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
  const winner = r.autoWinner || (r.autoWinRate > 0.5 ? 'the AI' : 'the opponent');

  list.push({
    tone: 'info',
    text: `<b>AUTO cuts both ways.</b> This match gave AUTO to ${winner}. Under Table 6-3 the alliance that scores more in AUTO has an <b>inactive</b> HUB in SHIFT 1 and SHIFT 3 (shots score 0), while the other alliance gets the first scoring window in SHIFT 1 and SHIFT 3. So winning AUTO is not always good: it buys AUTO points and sells the first scoring window.`,
  });

  if (r.rpProb.energized < 0.95) {
    list.push({ tone: 'warn', text: `<b>ENERGIZED RP is shaky (${Math.round(r.rpProb.energized * 100)}%).</b> The bar is ≥ ${th.energized.regional} FUEL in the active HUB, and this plan averages ${fmt(r.avgFuel, 0)}. Close the gap with a faster cycle (capacity × accuracy) or a longer effective window.` });
  } else {
    list.push({ tone: 'good', text: `<b>ENERGIZED RP is safe.</b> Average ${fmt(r.avgFuel, 0)} FUEL ≥ the ${th.energized.regional} bar.` });
  }
  if (r.rpProb.supercharged < 0.5) {
    list.push({ tone: 'info', text: `<b>SUPERCHARGED (≥ ${th.supercharged.regional} FUEL) is out of reach.</b> Three robots would have to put up ${th.supercharged.regional} inside the active windows, a sustained ~${fmt((th.supercharged.regional / 110) * 60, 0)} per minute. Do not trade consistency for it in qualification.` });
  }

  // The only external check on whether a recommended margin is real: how the simulated score
  // compares with what elite ALLIANCES actually put up at the 2026 Championship.
  const runMean = ((r.avgAiScore || 0) + (r.avgOppScore || 0)) / 2;
  if (runMean > 0) {
    const high = runMean > 850;
    list.push({
      tone: high ? 'warn' : 'info',
      text:
        `<b>Against real matches: this plan averages ${fmt(runMean, 0)} per alliance.</b> The real 2026 Einstein Finals scores were 406 / 456 / 518 / 561 / 711 / 712, event average 627, high 842 (The Blue Alliance; the calibration table is on the Rule sources tab). ` +
        (high
          ? 'That is above the real range, so these scouting parameters are more optimistic about window use than the top field is, and the simulated margin is proportionally large. Swap in your own measured speed, capacity, and accuracy and run it again.'
          : 'That is the same range as the top field, so the margin is fair to read as a tactical gain.'),
    });
  }
  // The AI's answer to "what does a ROBOT do in the SHIFTs where our HUB is dead" is a rule, not a
  // hope, so it is reported from the recorded match rather than asserted. A non-zero IDLE share here
  // would mean the ladder in policy.js fell through, which is the one outcome it is built to avoid.
  // The worker hands the recorded frames over on the result itself (it strips the rest of `recorded`).
  const frames = r.timeline || (r.recorded && r.recorded.timeline) || null;
  const aiSide = r.plan && r.plan.side;
  if (frames && aiSide) {
    const mix = {};
    let n = 0;
    let idle = 0;
    for (const f of frames) {
      if (f.hub[aiSide]) continue; // both HUBs are live in AUTO / TRANSITION / END GAME
      for (const rb of f.r) {
        if (rb.a !== aiSide) continue;
        n += 1;
        mix[rb.m] = (mix[rb.m] || 0) + 1;
        if (rb.m === 'IDLE') idle += 1;
      }
    }
    if (n > 0) {
      const order = ['DEFEND', 'PUSH', 'COLLECT', 'PASS', 'STOCKPILE', 'SCORE', 'CLIMB', 'IDLE'];
      const parts = order.filter((m) => mix[m]).map((m) => `${INTENT_LABEL[m] || m} ${Math.round((100 * mix[m]) / n)}%`);
      list.push({
        tone: idle ? 'warn' : 'good',
        text: `<b>No idle time while our HUB is inactive.</b> Busy ${Math.round((100 * (n - idle)) / n)}% of that stretch: ${parts.join(' · ')}. Our HUB scores 0 there (Table 6-3), so the AI picks from an ordered ladder — push (if the robot is set to Active) > sweep (load up while there is room) > defend (once full, pressure their scorer) > pass to a teammate with room > block > hold position — and even the last rung is not IDLE. Twenty-five seconds is a sixth of the match.`,
      });
    }
  }

  // Never advise a climb the selected ROBOTs physically cannot make: top-tier ROBOTs this season
  // mostly do not climb, and suggesting "two AUTO L1 + one L2 gets you there" would be nonsense.
  const profiles = ((r.plan && replayRosters()[r.plan.side]) || []).filter(onField);
  const aiRoster = profiles.filter((p) => p.climb && (p.climb.l1 || p.climb.l2 || p.climb.l3));
  const aiMaxClimb = profiles.reduce(
    (m, p) => Math.max(m, p.climb && p.climb.l3 ? 3 : p.climb && p.climb.l2 ? 2 : p.climb && p.climb.l1 ? 1 : 0),
    0,
  );
  if (!aiRoster.length) {
    list.push({ tone: 'info', text: `<b>TRAVERSAL RP is off the table.</b> All three AI robots are set to no climb, so TOWER points stay at 0 and cannot reach ${th.traversal.regional}. That is normal for this season's top teams: leaving the whole 30-second END GAME in the FUEL cycle is usually worth more. To price a climb, set one robot's max climb to L1 or higher and run again.` });
  } else if (r.rpProb.traversal < 0.95) {
    const auto = 2 * POINTS.tower.l1Auto; // §6.5.2: LEVEL 1 in AUTO, two ROBOTs max
    const tip =
      aiMaxClimb >= 3
        ? `The cheapest line is two L1 in AUTO (${auto} points) plus one L3 in END GAME (${POINTS.tower.l3Teleop}).`
        : aiMaxClimb === 2
          ? `The cheapest line is two L1 in AUTO (${auto} points) plus one L2 in END GAME (${POINTS.tower.l2Teleop}), exactly ${auto + POINTS.tower.l2Teleop}.`
          : `With only L1 available it takes two L1 in AUTO (${auto} points) plus two L1 in END GAME (${2 * POINTS.tower.l1Teleop}) to reach ${th.traversal.regional}, which means giving up two robots to the climb and handing away the 30-second FUEL cycle.`;
    list.push({ tone: 'warn', text: `<b>TRAVERSAL RP (TOWER ≥ ${th.traversal.regional}) is at risk.</b> §6.5.2 counts L1 once in AUTO and once in TELEOP. ${tip}` });
  } else {
    list.push({ tone: 'good', text: `<b>TRAVERSAL RP is safe.</b> The plan averages ${fmt(r.avgTower, 0)} TOWER points ≥ ${th.traversal.regional}.` });
  }

  const fouls = (r.events || []).filter((e) => e.kind === 'foul');
  if (fouls.length === 0) {
    list.push({ tone: 'good', text: `<b>No fouls this match.</b> The AI's pickup spots avoid the HUB outlets (G408: catching FUEL the HUB ejects is a foul), and its defenders stay off tower-hugging opponents in the last 30 seconds (G420). A foul hands the opponent 5 or 15 points, so avoiding one is worth points on its own.` });
  } else {
    const byIdx = new Map((r.robotStats || []).map((s) => [s.idx, s]));
    const byReason = new Map();
    const bySide = { red: 0, blue: 0 };
    for (const f of fouls) {
      const key = `${foulClause(f.reason)} ${f.points}`;
      const row = byReason.get(key) || { points: 0, n: 0 };
      row.points += f.points;
      row.n += 1;
      byReason.set(key, row);
      bySide[f.against] = (bySide[f.against] || 0) + f.points;
    }
    // The worst offender by the stat the engine already keeps, so the sentence names a machine.
    const worst = (r.robotStats || [])
      .filter((s) => (s.foulPointsGiven || 0) > 0)
      .sort((a, b) => b.foulPointsGiven - a.foulPointsGiven)[0];
    const who = worst ? foulDoer({ robot: worst.idx, against: worst.alliance, reason: '' }, byIdx) : null;
    list.push({
      tone: 'warn',
      text:
        `<b>${fouls.length} foul${fouls.length === 1 ? '' : 's'} this match: ${bySide.red} points charged to RED, ${bySide.blue} to BLUE.</b> ` +
        (who
          ? `The biggest single concession is <b>${esc(who.seat)} ${esc(who.label)}</b> at ${worst.foulPointsGiven} points over ${worst.fouls} foul${worst.fouls === 1 ? '' : 's'}. `
          : '') +
        `Breakdown: ${[...byReason.entries()].map(([k, v]) => `${esc(k)} ×${v.n}`).join(', ')}. The Numbers tab lists every one with the second it happened.`,
    });
  }

  // Defence stops shots with a body now, so report what it actually took away rather than leaving the
  // reader to infer it from a rate penalty nobody can see.
  const stats = r.robotStats || [];
  const blocked = stats.reduce((a, s) => a + (s.shotsBlocked || 0), 0);
  const blocks = stats.reduce((a, s) => a + (s.blocks || 0), 0);
  if (blocked || blocks) {
    list.push({
      tone: 'good',
      text: `<b>Defence blocked ${blocked} shots.</b> A shot is a straight line from the BUMPER to the HUB mouth, and an opponent body on that line stops it — how much lane a square ROBOT covers depends on how it is turned, from its face-on half-width to its corner-on one plus the ball's radius. The ball drops where it lands and draws no foul. Our side made ${blocks} blocks in all. The way to beat it is to slide along the HUB face to an open lane before shooting, which the AI now does.`,
    });
  }

  if (sc.objective === 'rs') {
    list.push({ tone: 'info', text: `<b>In qualification the goal is ranking points, not wins.</b> Table 10-1 ranks by RS, then average match score (fouls excluded), then average AUTO FUEL, then average TOWER points. So once the win rate is high, another bonus RP is worth more than a wider margin.` });
  } else {
    list.push({ tone: 'info', text: `<b>In the playoffs only the win counts.</b> The objective is set to win rate, so the AI will trade defence for one of the opponent's scoring windows.` });
  }
  list.push({ tone: 'info', text: `<b>Mind the model's limits.</b> The reference robots' <strong>team numbers and names are public knowledge; their performance numbers are estimates</strong>, not measurements, and do not describe what those teams actually did. Put your own scouting speed, capacity, accuracy, and climb time in, and the conclusions will hold for your team.` });

  $('insights').innerHTML = list.map((i) => `<li class="tone-${i.tone}">${i.text}</li>`).join('');
}

// A FOUL is assessed against a ROBOT, so the panel names the machine instead of the wall colour. The
// engine logs `robot` (its index), `against` (the ALLIANCE charged) and the clause on every event.
// `robot` is null for the two fouls no body on the FIELD commits: the HUMAN PLAYER's overfull store
// (G427) and an ALLIANCE that closed the traversal corridors (G419), and those say so outright.
function foulDoer(e, byIdx) {
  const s = e.robot === null || e.robot === undefined ? null : byIdx.get(e.robot);
  if (s) {
    return {
      label: `${s.name} #${s.team}`,
      side: s.alliance,
      seat: `${s.alliance === 'red' ? 'RED' : 'BLUE'} ${s.slot + 1}`,
      robot: true,
    };
  }
  const side = e.against || '';
  const code = String(e.reason).split(' ')[0];
  const label = code === 'G427' ? 'HUMAN PLAYER' : code === 'G419' ? 'the corridor block' : 'the ALLIANCE';
  return { label, side, seat: side === 'red' ? 'RED' : 'BLUE', robot: false };
}

function foulClause(reason) {
  const m = /^([GT]\d{3})\s*/.exec(String(reason));
  return m ? m[1] : '—';
}

function foulCard(reason) {
  const m = /(YELLOW|RED) CARD/.exec(String(reason));
  return m ? m[1] : '';
}

let foulFilter = null;

function filterFoulsByRobot(idx) {
  foulFilter = foulFilter === idx ? null : idx;
  if (state.result) renderFouls(state.result);
}

function renderFouls(r) {
  const byIdx = new Map((r.robotStats || []).map((s) => [s.idx, s]));
  const all = (r.events || []).filter((e) => e.kind === 'foul');
  const fouls = foulFilter === null ? all : all.filter((f) => f.robot === foulFilter);
  const charged = { red: 0, blue: 0 };
  for (const f of fouls) charged[f.against] = (charged[f.against] || 0) + f.points;
  const picked = foulFilter === null ? null : byIdx.get(foulFilter);
  const filterLine =
    foulFilter === null
      ? ''
      : `<button type="button" class="foul-clear" id="foul-filter-btn">Showing only ${esc(picked ? `${picked.name} #${picked.team}` : `ROBOT ${foulFilter + 1}`)} · click to show all</button>`;
  $('foul-note').innerHTML = fouls.length
    ? `<b>${fouls.length} foul${fouls.length === 1 ? '' : 's'}.</b> RED was charged ${charged.red} points and BLUE ${charged.blue} — Table 6-6 gives what a side concedes to its opponent, so the number under a team name is points the OTHER side kept. Click a row to jump the replay to that second. ${filterLine}`
    : `<p>No fouls${foulFilter === null ? '' : ' for that ROBOT'} in the replay MATCH, so the scoreline is all FUEL and TOWER.</p>${filterLine}`;
  $('foul-table').innerHTML = fouls.length
    ? `<thead><tr><th class="mono">Time</th><th>Phase</th><th>Committed by</th><th>Clause</th><th>Severity</th><th>Card</th><th class="mono">Points to</th></tr></thead>` +
      `<tbody>${fouls
        .map((f) => {
          const d = foulDoer(f, byIdx);
          const to = d.side === 'red' ? 'BLUE' : 'RED';
          return `<tr class="jump" data-t="${f.t}" title="Jump the replay to ${fmt(f.t, 1)}s">
          <td class="mono">${fmt(f.t, 1)}s</td><td>${esc(periodAt(f.t))}</td>
          <td><span class="dot ${d.side}"></span>${esc(d.seat)} · ${esc(d.label)}</td>
          <td class="mono">${esc(foulClause(f.reason))}</td>
          <td>${f.points >= POINTS.foul.major ? 'MAJOR' : 'MINOR'}</td>
          <td>${esc(foulCard(f.reason)) || '—'}</td>
          <td class="mono">+${f.points} ${to}</td></tr>`;
        })
        .join('')}</tbody>`
    : `<tbody><tr><td>No foul to show${foulFilter === null ? ' in this MATCH' : ' for that ROBOT'}.</td></tr></tbody>`;
  for (const row of document.querySelectorAll('#foul-table tr.jump')) {
    row.addEventListener('click', () => goToTime(Number(row.dataset.t)));
  }
  const btn = $('foul-filter-btn');
  if (btn) btn.addEventListener('click', () => filterFoulsByRobot(foulFilter));
}

// The batch answer to the same question: not "did we foul" but "which of my six ROBOTs does it, and
// with what". A row of G408 says move its pickup spots off the HUB outlet; a row of G418 says stop
// pinning opponents.
function renderFoulBatch(r) {
  const rows = r.foulByRobot || [];
  const block = $('foul-batch-block');
  if ((r.matches || 1) <= 1 || !rows.length) {
    block.hidden = true;
    $('foul-batch-table').innerHTML = '';
    return;
  }
  block.hidden = false;
  const any = rows.some((v) => v.fouls > 0);
  $('foul-batch-table').innerHTML = `<thead><tr><th>ROBOT</th><th class="mono">Fouls / match</th><th class="mono">Points conceded / match</th><th>Clauses</th><th class="mono">Impaired s / match</th></tr></thead>` +
    `<tbody>${rows
      .filter((v) => v.fouls > 0 || v.points > 0)
      .map(
        (v) => `<tr><td><span class="dot ${v.alliance}"></span>${v.alliance === 'red' ? 'RED' : 'BLUE'} ${v.slot + 1} · ${esc(v.name)} #${v.team}</td>
        <td class="mono">${fmt(v.fouls, 2)}</td><td class="mono">${fmt(v.points, 1)}</td>
        <td class="mono">${any ? esc(Object.entries(v.codes || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${fmt(n, 2)}`).join(' · ') || '—') : '—'}</td>
        <td class="mono">${fmt(v.impairedSec, 1)}</td></tr>`,
      )
      .join('')}</tbody>`;
}

// Chips under the scoreboard, because the Numbers tab is on the other side of the page and a foul worth
// 15 points should not need a tab switch to notice.
function renderFoulStrip(r) {
  const byIdx = new Map((r.robotStats || []).map((s) => [s.idx, s]));
  const fouls = (r.events || []).filter((e) => e.kind === 'foul');
  const acc = new Map();
  for (const f of fouls) {
    const d = foulDoer(f, byIdx);
    const k = `${d.side}:${d.label}`;
    const row = acc.get(k) || { ...d, n: 0, pts: 0, first: f.t };
    row.n += 1;
    row.pts += f.points;
    acc.set(k, row);
  }
  const host = $('foul-strip');
  host.innerHTML = [...acc.values()]
    .sort((a, b) => a.first - b.first)
    .map(
      (v) =>
        `<button type="button" class="foul-chip ${v.side}" data-t="${v.first}" title="${esc(v.label)} · ${esc(foulClause((fouls.find((f) => foulDoer(f, byIdx).label === v.label) || {}).reason || ''))} and ${v.n - 1} more · ${v.pts} points to ${v.side === 'red' ? 'BLUE' : 'RED'}. Jump to ${fmt(v.first, 1)}s.">${esc(v.seat)} ${esc(v.label)} <b>${v.n}</b> · ${v.pts} pts</button>`,
    )
    .join('');
  for (const chip of host.querySelectorAll('button')) {
    chip.addEventListener('click', () => goToTime(Number(chip.dataset.t)));
  }
}

function renderDetail(r) {
  const stats = r.robotStats || [];
  $('robot-table').innerHTML = `
    <thead><tr><th>Alliance</th><th>ROBOT</th><th class="mono">Scored</th><th class="mono">Shot blocked</th><th class="mono">Blocks</th><th class="mono">Wasted</th><th class="mono">Collected</th><th class="mono">Climb</th><th class="mono">Fouls</th><th class="mono">Blocked s</th><th class="mono">Drove in</th></tr></thead>
    <tbody>${stats
      .map(
        (s) => `<tr><td><span class="dot ${s.alliance}"></span>${s.alliance === 'red' ? 'RED' : 'BLUE'}</td><td>${esc(s.name)}</td>
        <td class="mono">${s.fuelScored}</td><td class="mono">${s.shotsBlocked || 0}</td><td class="mono">${s.blocks || 0}</td><td class="mono">${s.fuelWasted}</td><td class="mono">${s.fuelCollected}</td>
        <td class="mono">L${s.climbLevel}</td><td class="mono">${s.fouls ? `<button type="button" class="foul-link" data-idx="${s.idx}" title="Show only this ROBOT's fouls in the table below">${s.fouls} (−${s.foulPointsGiven})</button>` : '0'}</td>
        <td class="mono">${fmt(s.blockedByOpponentSec, 0)}s</td><td class="mono">${s.distanceIn}</td></tr>`,
      )
      .join('')}</tbody>`;
  // Clicking a ROBOT's foul count filters the clause table to it, which is how you find out whether the
  // 2 fouls are the same G408 habit at the same HUB outlet or two unrelated collisions.
  for (const btn of document.querySelectorAll('#robot-table .foul-link')) {
    btn.addEventListener('click', () => filterFoulsByRobot(Number(btn.dataset.idx)));
  }

  const evs = (r.events || []).filter((e) => e.kind === 'climb' || e.kind === 'hubSchedule' || e.kind === 'fault' || e.kind === 'towerAwarded');
  $('event-list').innerHTML = evs.length
    ? evs.slice(0, 80).map((e) => `<li>${fmt(e.t, 1)}s · ${e.kind}${e.reason ? ` · ${esc(e.reason)}` : ''}${e.points ? ` · ${e.points} pts` : ''}${e.level ? ` · L${e.level}` : ''}${e.robot !== undefined && e.robot !== null ? ` · ROBOT ${e.robot + 1}` : ''}</li>`).join('')
    : '<li>None</li>';

  const sch = r.hubSchedule || [];
  $('hub-table').innerHTML = `<thead><tr><th>Period</th><th>Length</th><th>Red HUB</th><th>Blue HUB</th></tr></thead><tbody>${sch
    .map((row) => `<tr><td>${row.period}</td><td class="mono">${periodSeconds(row.period)}s</td><td>${row.red ? '<b style="color:var(--red)">ACTIVE</b>' : 'inactive'}</td><td>${row.blue ? '<b style="color:var(--blue)">ACTIVE</b>' : 'inactive'}</td></tr>`)
    .join('')}</tbody>`;
}

// The three rungs the MATCH is worth, read off the frame the scrubber is on rather than off the whistle.
// Everything in it is already on the anchor: `s` carries the FUEL and TOWER points banked by that instant,
// and the thresholds come from the same `rp` block the final score is graded with, so this line and the
// verdict at the end of the MATCH are one computation.
function rpLadder(s, th) {
  const rung = (name, got, need) => `${got >= need ? '✓' : '·'} ${name} ${got}/${need}`;
  return `${rung('ENERGIZED', s.fuel, th.energized)} ${rung('SUPERCHARGED', s.fuel, th.supercharged)} ${rung('TRAVERSAL', s.tower, th.traversal)}`;
}

const MODE_COLS = ['SCORE', 'COLLECT', 'FEED', 'DEFEND', 'CLIMB'];

// What the score does not say about a MATCH: where the FUEL was lying when a ROBOT took it, how much of what
// its own HUB handed back it got to keep, and what it spent its seconds and its inches on. Every column is
// either an engine counter (`collectFrom`, `fuelReclaimed`, `modeSec`, `modeIn`) or a share of the recorded
// anchors, so this describes the MATCH that is playing rather than a model of one.
function renderFlow(r) {
  const stats = r.robotStats || [];
  const tl = r.timeline || [];
  const host = $('flow-table');
  if (!stats.length) {
    host.innerHTML = '';
    $('flow-note').textContent = 'Run a MATCH to fill this in.';
    return;
  }
  const ft = (inches) => (inches / 12).toFixed(1);
  // NEUTRAL / own ZONE / FEED outlet, in the order the scouting report gives them. A machine that only ever
  // fills the first column is spending its MATCH crossing the BUMPS to get to the middle.
  const mix = (s) => `${s.collectFrom.neutral} / ${s.collectFrom.zone} / ${s.collectFrom.feed}`;
  const rows = stats
    .map((s) => `<tr><td><span class="dot ${s.alliance}"></span>${s.alliance === 'red' ? 'RED' : 'BLUE'}</td><td>${esc(s.name)}</td>
      <td class="mono">${s.fuelCollected}</td><td class="mono">${mix(s)}</td><td class="mono">${s.fuelReclaimed}</td>
      ${MODE_COLS.map((m) => `<td class="mono">${fmt(s.modeSec[m] || 0, 1)}s</td>`).join('')}
      <td class="mono">${ft(s.modeIn.SCORE || 0)}</td><td class="mono">${ft(s.distanceIn)}</td></tr>`)
    .join('');
  host.innerHTML = `<thead><tr><th>Alliance</th><th>ROBOT</th><th class="mono">FUEL taken</th><th class="mono">Taken from: NEUTRAL / ZONE / FEED</th><th class="mono">Own HUB returns kept</th>${MODE_COLS.map((m) => `<th class="mono">${m} s</th>`).join('')}<th class="mono">SCORE ft</th><th class="mono">Drove ft</th></tr></thead><tbody>${rows}</tbody>`;

  const stride = tl.length > 1 ? tl[1].t - tl[0].t : 0.1;
  const open = (side) => tl.reduce((a, f) => a + (f.hub[side] ? stride : 0), 0);
  const line = (side) => {
    const g = stats.filter((s) => s.alliance === side);
    const taken = g.reduce((a, s) => a + s.fuelCollected, 0);
    const from = (k) => g.reduce((a, s) => a + s.collectFrom[k], 0);
    const scored = g.reduce((a, s) => a + s.fuelScored, 0);
    const wasted = g.reduce((a, s) => a + s.fuelWasted, 0);
    const kept = g.reduce((a, s) => a + s.fuelReclaimed, 0);
    const back = r.hubReturned ? r.hubReturned[side] : 0;
    const eff = scored + wasted ? Math.round((scored / (scored + wasted)) * 100) : 0;
    const recl = back ? Math.round((kept / back) * 100) : 0;
    return `${side.toUpperCase()} took ${taken} FUEL (${from('neutral')} in the NEUTRAL ZONE, ${from('zone')} in its own, ${from('feed')} at the FEED outlet) while its HUB was open ${fmt(open(side), 1)}s of the ${fmt(tl.length * stride, 0)}s · ${scored} went into an active HUB against ${wasted} into a dark one, so ${eff}% of what reached the HUB reached a window · its own HUB handed ${back} back onto the FIELD and it took ${kept} of them, ${recl}%`;
  };
  $('flow-note').textContent =
    `${line('red')} · ${line('blue')} · FUEL taken is one piece at the mouth, so the 8 a ROBOT starts with (§6.3.4-C) is not counted as taken. HUB returns are the FUEL that came back out of that ALLIANCE's own HUB (§5.4), and the share it took again is what says whether the HUB was feeding it or feeding the other side. This is the MATCH on the FIELD, not the batch.`;
}

// ---------------------------------------------------------------------------------------------
// Single-MATCH charts (plain canvas, no libraries). Every series is derived in `chartdata.js` from the
// anchors the engine already wrote, so a line on these canvases and the column in the table above it are
// the same number; nothing here reads a model or a stored expectation.
// ---------------------------------------------------------------------------------------------
const MODE_COLOR = {
  COLLECT: '#3f8ecb', STOCKPILE: '#6c7f9c', SCORE: '#f0b429', PASS: '#8fd6bd', PUSH: '#4fb0a5',
  DEFEND: '#c86a5a', CLIMB: '#a56fd6', FEED: '#d6a55f', IDLE: '#222d3c',
};
const SOURCE_COLOR = { neutral: '#7f93b0', zone: '#4faf88', feed: '#f0b429' };
const SIDE_COLOR = { red: '#e0596a', blue: '#4f8fe0' };

function timeX(t, span, padL, padR, w) {
  return padL + (span > 0 ? t / span : 0) * (w - padL - padR);
}

// The shared x-axis: ticks every 30 s, so AUTO (0-15), the four TELEOP shifts and END GAME line up with a
// labelled edge instead of an unlabeled stretch.
function drawTimeAxis(ctx, w, h, padL, padB, span) {
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = AXIS;
  for (let t = 0; t <= span + 0.001; t += 30) {
    const x = timeX(t, span, padL, 8, w);
    ctx.fillText(`${Math.round(t)}s`, x, h - 4);
  }
}

function linesChart(canvas, series, opts) {
  if (!canvas) return;
  const { span, periods = [], markerT = null, hi } = opts;
  const { ctx, w, h } = prepCanvas(canvas);
  const padL = 30;
  const padB = 14;
  const padT = 10;
  const top = Math.max(1, hi ?? Math.max(1, ...series.flatMap((s) => s.y)));
  if (periods.length) {
    for (const p of periods) {
      const x0 = timeX(p.t0, span, padL, 8, w);
      const x1 = timeX(p.t1, span, padL, 8, w);
      ctx.fillStyle = p.p === 'AUTO' ? 'rgba(240,180,41,0.10)' : p.p === 'END GAME' ? 'rgba(165,111,214,0.12)' : 'rgba(255,255,255,0.02)';
      ctx.fillRect(x0, padT, Math.max(1, x1 - x0), h - padB - padT);
      if (w > 380 && x1 - x0 > 26) {
        ctx.fillStyle = AXIS;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = '8px ui-monospace, monospace';
        ctx.fillText(p.p === 'END GAME' ? 'END' : p.p, x0 + 2, padT + 1);
      }
    }
  }
  drawYAxis(ctx, w, h, padL, padB, padT, 0, top, (v) => String(Math.round(v)));
  drawTimeAxis(ctx, w, h, padL, padB, span);
  for (const s of series) {
    ctx.beginPath();
    s.x.forEach((t, i) => {
      const x = timeX(t, span, padL, 8, w);
      const y = h - padB - (s.y[i] / top) * (h - padB - padT);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  if (markerT !== null) trendMarker(ctx, w, h, padL, padB, padT, span, markerT);
}

// The scrubber position, drawn last so it is always on top of the line it is pointing at.
function trendMarker(ctx, w, h, padL, padB, padT, span, markerT) {
  const x = timeX(markerT, span, padL, 8, w);
  ctx.strokeStyle = '#e8eef7';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, padT);
  ctx.lineTo(x + 0.5, h - padB);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Rows of coloured stretches: the HUB windows on one chart, the per-ROBOT intents on another. Same geometry
// both times, because both are "which of these mutually exclusive things was true at this instant".
function bandChart(canvas, rows, opts) {
  if (!canvas) return;
  const { span, colorOf, labelOf } = opts;
  const { ctx, w, h } = prepCanvas(canvas);
  const padL = w > 320 ? 62 : 44;
  const padB = 14;
  const padT = 6;
  const rowH = Math.max(6, (h - padB - padT) / Math.max(1, rows.length));
  ctx.font = '9px ui-monospace, monospace';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const y = padT + i * rowH;
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(padL, y + 1, w - padL - 6, rowH - 3);
    for (const seg of row.segments) {
      const x0 = timeX(seg.t0, span, padL, 6, w);
      const x1 = timeX(seg.t1, span, padL, 6, w);
      ctx.fillStyle = colorOf(seg, row);
      ctx.fillRect(x0, y + 1, Math.max(0.6, x1 - x0), rowH - 3);
    }
    ctx.fillStyle = AXIS;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelOf(row), padL - 4, y + rowH / 2);
  }
  drawTimeAxis(ctx, w, h, padL, padB, span);
}

// One horizontal bar a ROBOT: the FUEL it took, split by where it was lying. The tick past the end is what its
// own HUB handed back onto the FIELD and it took again — a share of a different total, so it is a mark, not a
// fourth segment, and the bar keeps reading as `taken`.
function sourceChart(canvas, rows, max) {
  if (!canvas) return;
  const { ctx, w, h } = prepCanvas(canvas);
  const padL = w > 320 ? 74 : 52;
  const padB = 14;
  const padT = 6;
  const rowH = Math.max(7, (h - padB - padT) / Math.max(1, rows.length));
  const scale = (w - padL - 26) / Math.max(1, max);
  ctx.font = '9px ui-monospace, monospace';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const y = padT + i * rowH;
    let x = padL;
    for (const key of ['neutral', 'zone', 'feed']) {
      const bw = r[key] * scale;
      if (!bw) continue;
      ctx.fillStyle = key === 'zone' ? SIDE_COLOR[r.alliance] : SOURCE_COLOR[key];
      ctx.fillRect(x, y + 1, Math.max(0.6, bw), rowH - 3);
      x += bw;
    }
    ctx.fillStyle = '#cdd8e8';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(r.taken), padL + r.taken * scale + 14, y + rowH / 2);
    if (r.kept) {
      const kx = padL + (r.taken + r.kept) * scale;
      ctx.strokeStyle = SIDE_COLOR[r.alliance];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(kx, y);
      ctx.lineTo(kx, y + rowH);
      ctx.stroke();
    }
    ctx.fillStyle = AXIS;
    ctx.textAlign = 'right';
    ctx.fillText(r.name.length > 10 ? `${r.name.slice(0, 9)}…` : r.name, padL - 4, y + rowH / 2);
  }
  ctx.fillStyle = AXIS;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${Math.round(max)} FUEL`, padL, h - 3);
}

function anchorsOf(r) {
  return r.timeline || (r.recorded && r.recorded.timeline) || [];
}

function renderMatchCharts(r) {
  const tl = anchorsOf(r);
  const stats = r.robotStats || [];
  if (!tl.length || !stats.length) return;
  const span = tl[tl.length - 1].t;
  const periods = periodBands(tl);
  const red = scoreSeries(tl, 'red');
  const blue = scoreSeries(tl, 'blue');
  const hi = Math.max(red.v[red.v.length - 1], blue.v[blue.v.length - 1]);
  state.trend = { span, periods, series: [{ x: red.t, y: red.v, color: SIDE_COLOR.red }, { x: blue.t, y: blue.v, color: SIDE_COLOR.blue }], hi, markerT: null };
  state.trendMarkerSec = -1;
  drawTrend();

  bandChart($('chart-window'), [['red', 'RED'], ['blue', 'BLUE']].map(([side, label]) => ({
    label,
    side,
    segments: windowBands(tl, side).filter((b) => b.on).map((b) => ({ t0: b.t0, t1: b.t1 })),
  })), {
    span,
    colorOf: () => '#4faf88',
    labelOf: (row) => row.label,
  });

  const rows = robotRows(tl);
  bandChart($('chart-roles'), rows.map((row) => ({
    row,
    segments: modeBands(tl, row.pos).map((b) => ({ t0: b.t0, t1: b.t1, m: b.m })),
  })), {
    span,
    colorOf: (seg) => MODE_COLOR[seg.m] || MODE_COLOR.IDLE,
    labelOf: (x) => `#${x.row.i}`,
  });

  const src = sourceRows(stats);
  sourceChart($('chart-sources'), src, Math.max(1, ...src.map((x) => x.taken + x.kept)));
  const openSec = (side) => windowBands(tl, side).filter((b) => b.on).reduce((a, b) => a + (b.t1 - b.t0), 0);
  const top = src.reduce((a, x) => a + x.taken, 0);
  const kept = src.reduce((a, x) => a + x.kept, 0);
  const back = ['red', 'blue'].reduce((a, side) => a + (r.hubReturned ? r.hubReturned[side] : 0), 0);
  $('chart-shape-note').textContent =
    `Top: what each ALLIANCE was worth at each instant, with AUTO shaded gold and END GAME violet, and the white line at the frame the FIELD is showing. `
    + `Second: the stretches in which that ALLIANCE's HUB would take FUEL at all — the AUTO and END GAME windows included, because this is read off the anchors and not off the shift schedule. `
    + `Third: what each ROBOT was told to be doing, in order ${MODE_ORDER.join(' / ')}, one row per ROBOT in build order. `
    + `Bottom: FUEL each ROBOT took, split by where it was lying — NEUTRAL ZONE grey, its own ALLIANCE ZONE in its side's colour, the FEED outlet amber — and the tick past the end of a bar is what its own HUB handed back onto the FIELD and that ROBOT took again. `
    + `This batch of bars is ${top} FUEL taken, ${kept} of it reclaimed out of the ${back} the two HUBs returned.`
    + ` Open HUB seconds: RED ${fmt(openSec('red'), 1)} s, BLUE ${fmt(openSec('blue'), 1)} s of a ${fmt(span, 0)} s MATCH.`;
}

function redrawMatchCharts() {
  if (!state.result) return;
  // The page keeps the anchors in `state.timeline`, not on the result it was handed, so a redraw that only
  // looked at `state.result` would find no record and leave four empty canvases under a tab that had been
  // drawn once already.
  const r = anchorsOf(state.result).length || !state.timeline ? state.result : { ...state.result, timeline: state.timeline };
  renderMatchCharts(r);
  // renderMatchCharts starts with no marker line, and this is the call that fires when the panel is opened —
  // so the line has to go back on the instant the FIELD is already showing. Without it the white line only
  // returns on the next scrub, and opening the tab mid-replay looks like it dropped the replay's own clock.
  trendMarkerAt(state.playT || 0);
}

// Redrawn as the scrubber moves, which is the whole point of the trend chart: where the white line sits against
// the shaded AUTO and END GAME bands is what says whether a MATCH was won in the first 15 seconds or lost there.
function drawTrend() {
  const d = state.trend;
  // Skip while the Numbers panel is hidden: the canvas has no box to draw into there, and the playback loop
  // would repaint it once per frame for nothing. Switching to the panel redraws everything.
  if (!d || $('tab-detail').hidden) return;
  linesChart($('chart-trend'), d.series, { span: d.span, periods: d.periods, hi: d.hi, markerT: d.markerT });
}

function trendMarkerAt(t) {
  if (!state.trend) return;
  const s = Math.round(t);
  if (s === state.trendMarkerSec) return;
  state.trendMarkerSec = s;
  state.trend.markerT = t;
  drawTrend();
}

// ---------------------------------------------------------------------------------------------
// Static reference tables
// ---------------------------------------------------------------------------------------------
function renderRules() {
  $('rules-table').innerHTML = `<thead><tr><th>Source</th><th>Manual text</th><th>Implemented in</th></tr></thead><tbody>${RULES.map(
    (r) => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.text)}</td><td class="mono">${esc(r.engine)}</td></tr>`,
  ).join('')}</tbody>`;

  $('conflict-list').innerHTML = RULE_CONFLICTS.map(
    (c) => `<div class="conflict"><b>${esc(c.subject)}</b><br />${esc(c.ruleText || '')}${c.ruleText ? '<br />' : ''}${esc(c.tableText)}<br />Handled by: ${esc(c.resolution)}</div>`,
  ).join('');

  const consts = [
    ['AUTO', `${TIME.autoSec}s`, 'Table 6-2'],
    ['TRANSITION SHIFT', `${TIME.transitionSec}s`, 'Table 6-2'],
    ['ALLIANCE SHIFT 1–4', `${TIME.shiftSec}s × 4`, 'Table 6-2'],
    ['END GAME', `${TIME.endgameSec}s`, 'Table 6-2'],
    ['FUEL into the active HUB', `${POINTS.fuelActiveHub} pts`, 'Table 6-4'],
    ['TOWER LEVEL 1 (AUTO)', `${POINTS.tower.l1Auto} pts, 2 per alliance max`, 'Table 6-4 / §6.5.2'],
    ['TOWER LEVEL 1 (TELEOP)', `${POINTS.tower.l1Teleop} pts`, 'Table 6-4 (conflicts with §6.5.2)'],
    ['TOWER LEVEL 2 / 3', `${POINTS.tower.l2Teleop} / ${POINTS.tower.l3Teleop} pts`, 'Table 6-4'],
    ['ENERGIZED / SUPERCHARGED / TRAVERSAL', `${POINTS.rpThreshold.energized.regional} / ${POINTS.rpThreshold.supercharged.regional} / ${POINTS.rpThreshold.traversal.regional}`, 'Table 6-5'],
    ['Win / tie RP', `3 / 1`, 'Table 6-4'],
    ['MINOR / MAJOR FOUL', `${POINTS.foul.minor} / ${POINTS.foul.major} pts to the opponent`, 'Table 6-6'],
    ['FUEL staged', `${FUEL.stagedTotal} (DEPOT 24×2, CHUTE 24×2, preload ≤8 per robot, rest in the NEUTRAL ZONE)`, '§6.3.4'],
    ['OUTPOST CHUTE / CORRAL hold', `${FUEL.chuteCapacity} FUEL in the CHUTE, ${FUEL.corralCapacity} in the CORRAL`, '§5.9.2 / §6.3.4'],
    ['A HUMAN PLAYER may hold off the FIELD', '2 FUEL (a full store must be entered onto the FIELD at once)', 'G427'],
    ['Field size', `${FIELD.lengthIn} × ${FIELD.widthIn} in`, '§5.2'],
    ['ROBOT starting size', `perimeter ≤ ${ROBOT_LIMITS.startPerimeterMaxIn} in, height ≤ ${ROBOT_LIMITS.startHeightMaxIn} in`, 'R104'],
    ['TRENCH clearance', `${FIELD.trench.clearHeightIn} in (taller robots can only use the BUMP)`, '§5.6'],
    ['TOWER rung heights', `LOW ${FIELD.tower.rungLowIn} / MID ${FIELD.tower.rungMidIn} / HIGH ${FIELD.tower.rungHighIn} in`, '§5.8'],
  ];
  $('const-table').innerHTML = `<thead><tr><th>Item</th><th>Value</th><th>Source</th></tr></thead><tbody>${consts
    .map(([a, b, c]) => `<tr><td>${a}</td><td class="mono">${b}</td><td class="mono">${c}</td></tr>`)
    .join('')}</tbody>`;

  // Real MATCH scores are the only external yardstick this simulator can be calibrated against, so
  // they are shown next to the engine's own measured throughput instead of being hidden in a note.
  const real = [
    ['Einstein F1 M1', '4065 / 4414 / 1323', '456', '868 / 2910 / 2046', '518'],
    ['Einstein F1 M2', '4065 / 4414 / 1323', '711', '868 / 2910 / 2046', '561'],
    ['Einstein F1 M3', '4065 / 4414 / 1323', '712', '868 / 2046 / 2910', '406'],
    ['Event average, per alliance', '—', '627.5', 'Event high', '842'],
    ['Semifinals SF1 / SF2', '7407 / 5940 / 9470', '443', '868 / 2910 / 2046', '665'],
  ];
  const simRows = [
    ['Engine throughput (greedy vs greedy, neither side defending; scripts/probe.mjs, n=12)', '5.36 FUEL/s per alliance', 'real finals ≈4.7 FUEL/s. One trio (254/1678/1690) on both ALLIANCES, which scored 599.4 as red and 619.7 as blue on the same 12 MATCHes'],
    ['Engine total per alliance (the GREEDY mirror: the hand-written cycling plan on both sides, nobody defending, n=24 ×2 seed sets ×2 trios)', '591.7 (597.9 and 585.5)', 'this is the calibration anchor: 5.6% under the real Einstein average of 627, which is outside the ±2% a mirror is read in and is stated rather than tuned back. A mirror means the same three ROBOTs on both sides — it used to be one trio per side, which made every mirror a roster comparison. Both trios are run separately and pooled. scripts/mirror.mjs'],
    ["The AI's own searched mirror (the same MATCHes)", '575.3 (562.2 and 588.3)', '16 points under the greedy mirror: in a mirror both sides deny each other and the denial cancels, but the search still pays for thinking about it'],
    ['The same plan PINNED to all-SCORE (the search is not consulted, nobody defends)', '638.3 (605.0 and 671.5)', 'what the search spends on DEFEND, given back without changing the policy the ROBOTs actually fly. It sits above the greedy mirror because a pinned car never leaves the HUB face to chase a pile: 46.6 points above it on this build and 46.1 above it on the build before the clamp fix, which is the one figure in this table that the change did not move'],
    ['The AI against greedy (four disjoint seed families, n=96; scripts/ab.mjs)', '67.2% win, 657.3 against 629.5', 'per family 66.7 / 75.0 / 62.5 / 64.6%. Pinning every ROBOT to "always cycle" (noSearch) drops it to 52.1% and 13.4 of margin, so the macro search is worth +15.1 win points while costing 10.3 of its own score: it buys denial with raw FUEL. Taking DEFEND out of the micro policy reads −4.7 win points, and that is the fifth build running in a row this arm has moved — and the first that comes out the other way, because on this geometry keeping a body in the lane wins MATCHes rather than only costing them. Switching the shot dispersion off (sc.shotSpreadIn = 0) is worth +7.8 win points, +1.6 of score and +22.2 of margin: the fan still feeds the machine that only cycles (its own score goes 608.8 against the 629.5 it scores with the fan on) more than it feeds the one that plans'],
    ['Seat test: the same trio on both sides, red minus blue per MATCH (scripts/mirror.mjs)', 'greedy mirror 0.4 ± 6.2 · pinned mirror +28.8 ± 6.9', '96 MATCHes per mode. The calibration anchor is symmetric (0.1 sem), so the score the page is calibrated on carries no seat advantage. The mirror that flies the shipped micro policy still splits 29 points, about 4.2 sem, and scripts/seat.mjs is the tool that localises it. This number has now read +15.2, then +27.7, then +9.7, then +22.5 and now +28.8 across five builds — it moves when the FUEL-drop geometry moves, which is the honest description of what is left here: a seat effect that is not yet localised, not a settled +29. The page previously claimed red and blue were 60 points apart: that was the two sample rosters, and red was not a seat but a weaker set of machines'],
    ['Being the AUTO loser is worth a lot, and how much depends on the trio (scripts/seat.mjs, pinned same-roster mirror, 24 MATCHes per arm)', 'trio 254/1678/1690: red pinned as AUTO winner −47.4 ± 10.8, blue pinned +46.8 ± 11.4 · trio 4414/5940/11019: −39.0 ± 8.7 and +65.0 ± 8.9', 'Table 6-3 makes the AUTO winner sit out SHIFT 1 and SHIFT 3, so it plays SHIFT 2 and SHIFT 4 against a FUEL pool the opponent has already been eating from. Both trios say the same sign in both seatings, and the first trio now says it almost exactly both ways (−47.4 against +46.8), which is what a symmetric rule should look like. The search does not seem to be buying this: it scores 92.4 AUTO FUEL against greedy 100.8 on the probe mirror (n=12), which is the wrong end of the ledger to be arguing from, so the claim is left as the pinned-mirror measurement only'],
    ['The engine serves the two ALLIANCES alternately (measured on the build that fixed it, not re-run since)', 'two identical greedy policies: 598.6 vs 630.5 before, 611.0 vs 615.6 after', 'red ROBOTs are built first, so a plain per-ROBOT pass let red take every contested FUEL and name its piles first. That was worth about 30 points between two identical plans, and a mirror is now symmetric by construction rather than by luck. The per-tick order is not enough on its own: decisions happen every 0.2 s, so the ALLIANCE that decides first has to alternate on that clock, not on the tick. On this build the greedy mirror reads 0.4 ± 6.2 red minus blue, which is the row above and the reason this fix is not re-tested every round'],
    ['What one defender in a shooting lane costs the attacker (scripts/defcal.mjs, both plans pinned so no search is involved, n=48 per arm per trio)', 'factor 0.922 / 0.919 at one defender · 0.802 / 0.825 at two · 0.724 / 0.766 at three', 'the geometric event the analytic model has no representation of. Launches the attacker loses to a body in its lane go 16.5 → 48.3 → 77.8 → 103.3 a MATCH on the first trio and 37.6 → 101.6 → 161.4 → 183.1 on the second, so the marginal defender is worth about as much as the first — fastsim.js now charges defence per defender rather than one factor for the strongest one. A made shot flies to a point inside the opening, which is the segment a defender has to stand in front of, and the two trios still land within 5 points of a percent of each other at every k. The order of the two trios by driver skill has flipped since the last build: the trio with the weaker defenders (0.620 defenseSkill) now costs the attacker 7.8% a car and the better one (0.860) costs 8.1%, so the ×skill term is still unproven rather than merely unmeasured'],
    ['…and what happened when the search was told that number (measured on the build that set defenseEfficacy to 0)', 'win −9.9 pts · score −14.1 · margin −8.9 (n=96, four families)', 'defenseEfficacy went back to 0 and the ablation of it is now a no-op on this build: the noShotSpread-controlled A/B re-ran defenseEfficacyZero at family 90001 and it moved nothing at all (win 0.0, score 0.0), which is what a shipped zero should look like. The mix showed why the told version lost: the AI dark-window DEFEND share rose 16.1% → 26.6% and COLLECT fell 63.3% → 54.9%, so the search bought the defence it could suddenly see. The model prices what a defender takes from the opponent correctly and under-prices what it costs its own side'],
    ['Re-measuring the come-home rung (ARMS=base,noDarkPrep, n=96, four families)', 'win −8.9 pts · score −26.0 · margin −23.5 when it is off', 'darkPrepSec = 4 s is the rule that makes a carrying ROBOT come home before our HUB goes live. On the build before this one the arm read 0.0 / 0.0 / +4.2 / −18.8 win points by family, with the pooled figure carried by a single family; now three of the four families prefer the rule on (base 66.7 / 75.0 / 62.5 / 64.6 against noDarkPrep 70.8 / 54.2 / 66.7 / 41.7) and the pooled read is the strongest it has ever been. The arm has now moved sign twice in three builds, so the pooled figure is a statement about this build, not a settled property of the rule'],
    ['mateSeparation weight, ablated at n=96 (SWEEP="mateSeparation:0")', '0.6 ships; removing it moves win 0.0, score −8.8, margin +1.6', 'prices a candidate pile down for having a partner near it, at the partner\'s body or at the target the partner is already driving at; the penalty dies at 72 in, about two car widths. The build before this one read win +5.2 with score −1.7; this one says taking it away loses 8.8 points of score and wins exactly the same number of MATCHes, and the build before that read +0.5 / +0.5 / +1.7, indistinguishable from nothing. Three samples, three different signs, none of them significant at n=96. It ships because three ROBOTs converging on one pile is a real failure mode the cameras show, not because a 96-MATCH sample priced it. scripts/team.mjs prints the bunching proxies'],
    ['A stricter time rule that lost on the score while winning on the proxy (measured on the build that rejected it, not re-run since)', 'FUEL caught off its own lane at a reopen 37.8% → 14.3%, win −5.7 pts (n=96)', 'gating the dark-window sweep on whether the pickup AND the return fit in the time left did exactly what it looks like it should, and every one of the four families went down or flat (87.5→79.2, 81.3→75.0, 79.2→70.8, 70.8→70.8). Reverted. What the AI does with the clock it already has is fine: on the tail of a live window it leaves 1.5% of frames in an unfinished trip where greedy leaves 2.0%, and is caught holding 14.0 FUEL at a window close where greedy holds 21.4 — scripts/cap.mjs prints both'],
    ['Teamwork weight mateSeparation, ablated at n=96 (SWEEP="mateSeparation:0")', '0.6 ships; removing it moves win +5.2, score −1.7, margin +6.8', 'prices a candidate pile down for having a partner near it, at the partner\'s body or at the target the partner is already driving at; the penalty dies at 72 in, about two car widths. The last build read +0.5 / +0.5 / +1.7 for the same ablation, i.e. indistinguishable from nothing; this one says removing it wins 5.2 more MATCHes out of 96 (1.3 sem, still not significant) while scoring 1.7 LESS. Neither sample prices the weight, and the two samples do not even agree on which side of zero it sits. It ships because three ROBOTs converging on one pile is a real failure mode the cameras show, not because a 96-MATCH sample priced it. scripts/team.mjs prints the bunching proxies'],
    ['The macro search now re-runs inside a SHIFT when the situation changes class (search counts from the build that added it)', '7 searches a MATCH against a steady opponent, 8 against a random one; the win rate it was quoted against is now 67.2%', 'the trigger fires on a ROBOT going down, the FIELD running out of FUEL, an assigned role becoming unexecutable, or the opponent posterior moving to another archetype. Against greedy it essentially never fires, which is the honest statement: a plan made against a steady opponent is not invalidated by anything that happens next. Cost when it does fire is one extra search'],
    ['Same mirror with hard-contact fouls on (sc.contactFouls = true: §7.4.4 G415/G416/G417)', 'AI mirror 583.4 on against 575.3 off (n=48 per arm, both trios)', '8.1 points, inside the ±2% a mirror carries, and in the direction the foul points: the fouls are awarded to the opponent, so both ALLIANCES gain. It read 14.5 points on the build before the clamp fix, which is more than the foul itself is worth on this geometry. The greedy mirror is not re-run with the switch because the hand-written cycling plan never makes a deliberate hit — that is a property of the policy, not a measurement. The card is not priced: a second YELLOW CARD in a phase is a RED CARD, i.e. a DISQUALIFICATION, and that tournament cost is not modelled'],
    ['Foul points are charged to the ROBOT that committed them', 'G418, G419 and G415/G416/G417 used to credit the offending side', 'the engine logged the offender all along and the arithmetic handed it the points. The Numbers tab now lists every foul with its second, its clause and the machine, the batch view averages the same per ROBOT, and the chips under the scoreboard jump the replay to them'],
    ['Intake mouth: a slot across the whole face, reaching 6 in behind the face line', 'sc.intakeReach 5 → 581.5 · 6 → 592.6 · 8 → 601.2 · 12 → 612.9', 'the width is the car and is not a guess; how far BEHIND the face line the rollers still grab is, and the greedy mirror (192 MATCHes, 384 ALLIANCE scores, per point) is what watches it. Twelve inches is worth 20.3 points more than the six that ship and would still leave the anchor 2.2% under the real average, so six is stated as an estimate of what a ball caught against a bumper is and pinned by scripts/golden.mjs rather than asserted as a rule. Back is the default face on every card because a Front slot shares its bumper with a front-mounted Dumper shooter, not because the mirror pays for it (see the intake face row)'],
    ['Chassis, on the pinned all-SCORE mirror (n=24 ×2 seed sets; scripts/lever.mjs)', 'swerve 605.0 · mecanum 541.8 · tank 440.1', 'a square ROBOT has to rotate its shooting face onto the HUB, so turn rate is a cycle-time number: a tank drive costs 164.9 points, 27%. Mecanum sits 63.2 behind a swerve, because the rear mouth is the end that has to arrive first and a mecanum reverse leg runs at 78% of top speed'],
    ['Mechanism, same mirror', 'turret 659.3 · dumper 570.2', 'an 89.1-point gap. It read 84.6 on the build that first gave a launch a landing point: putting the made shots back inside the opening rather than on the prism wall is worth 5.6 points to a turret and 1.1 to a Dumper, so the machine that shoots from wherever it stands gains more than the one that has to park at the face. The turret still slews independently and never has to point the car at the HUB (see Turret or Dumper)'],
    ['Intake face, same mirror (front / back / left / right; scripts/lever.mjs)', 'swerve 612.7 · 605.0 · 603.6 · 608.9 — tank 433.8 · 440.1 · 402.7 · 395.4', 'a swerve strafes and spins at full rate, so the 9.1-point spread across its four faces is small next to what a tank pays: side mouths cost it 37 to 45 points. Front is 7.7 ahead of Back on a swerve this build, where the build before the clamp fix had them 9.0 apart and the one before that equal to within 0.4 — all three are inside each other\'s error bar and none is an argument. What still argues for Back is a Front slot sharing its bumper with a front-mounted Dumper shooter'],
    ['DRIVER level, same mirror (Average is the reference the page is built on)', 'rookie 524.4 · average 605.0 · good 620.3 · elite 638.9', '114.5 points end to end (Table 6-1 DRIVER), and every rung pays on this build: good to elite is 18.6, above the spread between the two seed sets'],
    ['Same mirror with one ROBOT a side (the bench switch: plays: false, a 1v1)', '299.6 against 605.0 for 3v3', 'a lone ROBOT recovers 49.5% of its three-ROBOT ALLIANCE; FUEL staging is unchanged (§6.3.4), and this is not a legal MATCH configuration. The 299.6 is byte-for-byte what the last build measured: with the only other machine on the FIELD sitting at its own HUB, nothing stands in the lane to be flown through, so a launch aimed at the opening instead of the wall costs this arm nothing'],
    ['Loose FUEL on the field (drawn every frame, no sampling)', 'mean 224, min 143', '504 staged = 24/DEPOT + 24/CHUTE + ≤8 preload per ROBOT + the rest midfield (§6.3.4)'],
    ['Roller independent of the shooter: it picks up during SCORE / PASS', '14% of the 97698 ticks the roller runs swallow a FUEL (n=12)', 'those ticks include SCORE and PASS, not just INTAKE. Bulldozing turns the roller off on purpose, or it would collect what it means to push away'],
    ['A launch flies at a landing point, not at the HUB centre (shot dispersion)', 'the one sweep reads 597.7 with every shot aimed at the centre against 592.6 at the 22 in that ships; the AI gives 7.8 win points', 'Every FUEL used to be aimed at the exact centre and one accuracy roll decided whether that counted as made, so a whole hopper drew as a single line into the middle of the HUB and a miss came down on a separate random draw up to 68 in from where the replay had shown it flying. A launch now picks a landing point: inside the 41.7 in opening when the roll says made (§5.4), at or past the 47 in prism footprint on the shooter\'s own half when it says missed, because §5.4 makes the HUB a solid structure with the hole on top. scripts/verify.mjs holds both halves: the continuity walk measures 170 landings, 0 outside one flight step plus a ball width (worst 4.0 in), and with sc.shotSpreadIn = 0 the same walk is outside the bound on 173 of 190 landings, worst 62.6 in. The spread is swept at 192 MATCHes per point (0 → 597.7, 12 → 588.7, 22 → 592.6, 30 → 593.2) — not monotone, and all four inside the mirror\'s own error bar, so 22 in is stated as an estimate and not a value tuned against the anchor'],
    ['…and the made shots in that fan aim at the hole, not at the wall around it', '2148 made shots read inside the 20.85 in opening, 0 outside; before the fix all 2209 read outside, median 25.5 in', 'The first version of the fan pushed EVERY launch out to the HUB\'s square footprint so that a stopped ball would not be drawn stopping inside the structure. The opening (20.85 in) is smaller than that square (23.5 in to a face, 33.2 in to a corner), so the clamp also caught every made shot: a shot that was going in was drawn clipping the outside wall, and the swept segment the DEFEND test uses ran around the middle of the HUB instead of through it. scripts/verify.mjs now holds the two populations apart, and the same walk run against a worktree of the broken build is what prints the 100%. Cost of the fix: the anchor gives back 1.7 points (593.4 → 591.7), the AI gains 2.1 win points and 10 of its own searched mirror, the pinned mirror is unmoved, and the seat split in the pinned mirror has now read +15.2, +27.7, +9.7, +22.5 and +28.8 across five builds without being localised'],
    ['Calibration knob: HUB outlet throughput cap (four outlets, §5.4)', '4.2 FUEL/s', 'backed out from the real average and re-derived after the midfield layout was made symmetric. Re-swept on this build (192 MATCHes each): 4.2 → 592.6, 4.6 → 602.3, 5.0 → 613.2, 5.2 → 614.6, with the red-blue split inside one standard error at every point. So 5.0 would put the anchor 2.2% under the real average — only at the edge of the ±2%, not inside it — and it is not shipped: the cap has no independent measurement, every figure on this page is anchored on it, and moving a calibration knob to erase the cost of a rule change is how a simulator stops meaning anything'],
    ['FUEL scored in AUTO', '≈97 (92.4 red, 100.8 blue, n=12)', 'real finals 111–177, so the engine is still low here, and where it sits has barely moved across the last two geometry fixes (92.4 / 100.7 before)'],
  ];
  $('calib-table').innerHTML =
    `<thead><tr><th>Match / metric</th><th>Red</th><th class="mono">Red score</th><th>Blue</th><th class="mono">Blue score</th></tr></thead>` +
    `<tbody>${real
      .map(([m, rt, rs, bt, bs]) => `<tr><td>${esc(m)}</td><td class="mono">${esc(rt)}</td><td class="mono">${esc(rs)}</td><td class="mono">${esc(bt)}</td><td class="mono">${esc(bs)}</td></tr>`)
      .join('')}</tbody>` +
    `<tbody>${simRows
      .map(([k, v, ref]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td><td colspan="3" class="hint">${esc(ref)}</td></tr>`)
      .join('')}</tbody>`;
}

function renderBench(data) {
  if (!data) return;
  state.bench = data;
  const rows = data.rows || [];
  $('bench-table').innerHTML = `
    <thead><tr><th>Opponent baseline</th><th class="mono">AI win rate</th><th class="mono">AI score</th><th class="mono">Opponent</th><th class="mono">AI expected RS</th><th class="mono">TRAVERSAL</th></tr></thead>
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
        AI vs greedy, same robots: ${h.aWins}W ${h.bWins}L ${h.draws}T, average score ${fmt(h.aScore, 0)} vs ${fmt(h.bScore, 0)} (${h.matches} matches)</caption>`,
    );
  }
  const ci = state.calibration;
  $('agreement').innerHTML = ci
    ? `Calibrated the analytic model against ${ci.samples} full-engine matches at load: coefficient ${fmt(ci.efficiency, 3)}. Residual after calibration red ${fmt(ci.errRedPct, 1)}% / blue ${fmt(ci.errBluePct, 1)}% (before calibration ${fmt(((ci.rawRed - ci.engineRed) / ci.engineRed) * 100, 1)}%). The search uses the calibrated model.`
    : 'Not calibrated yet.';
}

function renderTrain(out) {
  state.trainHistory = out.history || null;
  lineChart($('chart-train'), (out.history || []).map((h) => h.fit), '#ffd94a');
  const changed = Object.keys(out.weights).filter((k) => Math.abs(out.weights[k] - DEFAULT_WEIGHTS[k]) > 1e-6);
  $('weight-table').innerHTML = `<thead><tr><th>Weight</th><th class="mono">Default</th><th class="mono">Trained</th></tr></thead><tbody>${
    (changed.length ? changed : Object.keys(DEFAULT_WEIGHTS).slice(0, 12))
      .map((k) => `<tr><td class="mono">${k}</td><td class="mono">${fmt(DEFAULT_WEIGHTS[k], 3)}</td><td class="mono">${fmt(out.weights[k], 3)}</td></tr>`)
      .join('')
  }</tbody>`;
  const hist = out.history || [];
  // `spread` is the spread of the candidates scored inside one generation. They were measured on the
  // same MATCHes and differ by a few weights, so most of that spread is luck: it is the noise floor
  // of this sample size, and the number that decides whether the fitness line moved at all.
  const spreads = hist.map((h) => h.spread).filter((v) => Number.isFinite(v));
  const noise = spreads.length ? spreads.slice().sort((a, b) => a - b)[Math.floor(spreads.length / 2)] : null;
  const moved = hist.length > 1 ? hist[hist.length - 1].fit - hist[0].fit : 0;
  $('train-result').innerHTML =
    `${hist.length - 1} generations, fitness ${fmt(out.fitness, 3)} (${moved >= 0 ? '+' : ''}${fmt(moved, 3)}). ${changed.length} weights changed.` +
    (noise == null
      ? ''
      : `<br /><b>Selection noise at this sample: ±${fmt(noise, 2)}.</b> Candidates in a generation differ by about that much on identical MATCHes, so a fitness move smaller than it is the seed set, not the weights — ` +
        (Math.abs(moved) < 2 * noise
          ? `this run's ${fmt(moved, 2)} is inside the noise band and should not be adopted.`
          : `this run's ${fmt(moved, 2)} clears it here, but check it on seeds it was not trained on (scripts/train.mjs does that with a holdout gate).`)) +
    `<br /><b>Note</b>: the browser budget is small, so a run like this overfits local noise. The default weights are the validated set.`;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------
// What the run was, so the Tactics tab can label its own blocks with the scope they belong to.
// Every setting a batch reads goes in one flat map, because the delta line compares two batches and
// has to tell "you changed the switch and nothing else" from "these are two different questions".
function batchSnapshot() {
  const sc = scenarioOverride();
  return {
    seed: String(Number($('inp-seed').value) || 20260110),
    side: plannedSide(),
    opponent: opponentPick().kind,
    objective: sc.objective,
    event: sc.event,
    autoWinner: sc.autoWinner,
    towerL1TeleopAllowed: String(sc.towerL1TeleopAllowed),
    faultsEnabled: String(sc.faultsEnabled),
    contactFouls: String(sc.contactFouls),
    humanThrow: JSON.stringify(sc.humanThrowPerSec),
    humanAcc: JSON.stringify(sc.humanAccuracy),
    red: JSON.stringify(state.rosters.red),
    blue: JSON.stringify(state.rosters.blue),
    weights: JSON.stringify(state.weights),
    iterations: String(payload().iterations),
  };
}

function runCtx(matches) {
  const snapshot = batchSnapshot();
  const opp = opponentPick();
  return {
    matches,
    seed: Number(snapshot.seed),
    objective: snapshot.objective,
    event: snapshot.event,
    opponentKind: opp.kind === 'ai' ? null : opp.kind,
    opponentLabel: opp.label,
    aiSide: snapshot.side,
    snapshot,
  };
}

// A MATCH as a file. The frame log is the payload: the positions come from the engine's own recorder, so
// Import replays exactly what the exporting build produced without re-running the engine, the weights or
// the search — which is the point, since the receiving browser may be a different build entirely.
//
// Anchors are written every 2nd tick. The renderer blends between anchors, and at 0.4 s a ROBOT doing
// 150 in/s covers 60 in between two of them, which trips blendFrame's teleport guard and reads as
// jumping; 0.2 s keeps it under the threshold and the file at ~3 MB.
const MATCH_FORMAT = 'xplore-match-v1';
const EXPORT_INTERVAL_SEC = 0.2;

function exportMatch() {
  const res = state.result;
  const tl = state.timeline;
  if (!res || !tl || tl.length < 2) {
    status('Nothing to export yet — run One match or a Monte-Carlo batch first.', 'err');
    return;
  }
  const frames = sampleReplay(tl, EXPORT_INTERVAL_SEC);
  const { timeline, recorded, ...result } = res;
  const file = {
    format: MATCH_FORMAT,
    exportedAt: new Date().toISOString(),
    strideSec: +(frames[1].t - frames[0].t).toFixed(3),
    ctx: state.lastCtx || {},
    inputs: state.lastPayload || null,
    result,
    frames,
  };
  const totals = result.final ? `${Math.round(result.final.red.total)}-${Math.round(result.final.blue.total)}` : 'batch';
  const stamp = file.exportedAt.slice(0, 10);
  const name = `rebuilt-match-${file.ctx.seed || 'x'}-${totals}-${stamp}.json`;
  const text = JSON.stringify(file);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  status(`Exported ${name} (${(text.length / 1048576).toFixed(1)} MB, ${frames.length} anchors at ${file.strideSec} s).`, 'ok');
}

function importMatch(text, label) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    status(`${label} is not readable JSON: ${e.message}`, 'err');
    return;
  }
  if (!data || data.format !== MATCH_FORMAT) {
    status(`${label} is not a saved match (format says ${JSON.stringify((data && data.format) || null)}).`, 'err');
    return;
  }
  if (!data.result || !Array.isArray(data.frames) || data.frames.length < 2) {
    status(`${label} has no frame log in it — export the MATCH, not just the summary.`, 'err');
    return;
  }
  pausePlayback();
  state.timeline = data.frames;
  state.lastCtx = data.ctx || {};
  state.lastPayload = data.inputs || null;
  // renderResult reads the frame log off the result (the IDLE share and the intent mix are computed from
  // it), and Export writes the anchors once, into `frames`, rather than twice. Hand them back.
  data.result.timeline = data.frames;
  $('scrub').max = String(data.frames.length - 1);
  renderResult(data.result, state.lastCtx);
  // An imported MATCH did not come from this browser's batch, so the ladder stops marking a row as on screen.
  state.batchMatch = 0;
  renderNotable();
  setFrame(0);
  const who = data.result.final
    ? `${Math.round(data.result.final.red.total)} / ${Math.round(data.result.final.blue.total)}`
    : `${data.result.matches || '?'} MATCHes`;
  status(`Imported ${(data.ctx && data.ctx.seed) || 'seed ?'} · ${who} · recorded ${data.exportedAt || 'date unknown'}. Setup panels still show your current inputs.`, 'ok');
}

async function runSingle() {
  if (state.busy) return;
  busy(true);
  state.lastRun = 'single';
  const opp = opponentPick();
  status(opp.mode === 'aiVsAi' ? 'Running one match, both sides searching…' : 'Running one match…', 'busy');
  setProgress(true, 0.1, 'AI is searching shift plans');
  try {
    const p = payload({ matches: 1, recordFirst: true, mode: opp.mode, opponentKind: opp.kind, aiSide: plannedSide(), planSnapshot: true });
    const inputs = structuredClone(p);
    const ctx = runCtx(1);
    const res = await ask('mc', p);
    pausePlayback();
    state.lastPayload = inputs;
    state.timeline = res.timeline;
    state.lastCtx = ctx;
    // One MATCH typed into the seed box is not part of any batch, so the ladder stops claiming it is.
    state.batchRows = null;
    state.batchResult = null;
    state.batchInput = null;
    state.batchMatch = 0;
    $('scrub').max = String(Math.max(0, (res.timeline ? res.timeline.length : 1) - 1));
    renderResult(res, state.lastCtx);
    renderNotable();
    setFrame(0);
    startPlayback();
    status('Match done', 'ok');
  } catch (e) {
    taskFailure('Match failed', e);
  } finally {
    busy(false);
    setProgress(false);
  }
}

async function runMonteCarlo() {
  if (state.busy) return;
  const matches = Math.round(Math.max(10, Math.min(MAX_BATCH, Number($('inp-mcmatches').value) || 120)));
  $('inp-mcmatches').value = String(matches);
  const opp = opponentPick();
  busy(true);
  state.lastRun = 'batch';
  status(`Monte Carlo, ${matches} matches${opp.mode === 'aiVsAi' ? ', both sides searching' : ''}…`, 'busy');
  setProgress(true, 0, '0%');
  try {
    const p = payload({ matches, recordFirst: true, mode: opp.mode, opponentKind: opp.kind, aiSide: plannedSide() });
    const inputs = structuredClone(p);
    const ctx = runCtx(matches);
    const res = await ask(
      'mc',
      p,
      (pp) => setProgress(true, pp.done / pp.total, `${pp.done}/${pp.total}`),
    );
    pausePlayback();
    state.lastPayload = inputs;
    state.timeline = res.timeline;
    state.lastCtx = ctx;
    state.batchInput = inputs;
    state.batchRows = res.rows?.length ? res.rows : null;
    state.batchResult = res;
    state.batchMatch = state.batchRows ? 1 : 0;
    $('scrub').max = String(Math.max(0, (res.timeline ? res.timeline.length : 1) - 1));
    renderResult(res, state.lastCtx);
    renderNotable();
    setFrame(0);
    status(`Monte Carlo done (${matches} matches)`, 'ok');
  } catch (e) {
    taskFailure('Batch failed', e);
  } finally {
    busy(false);
    setProgress(false);
  }
}

// Replay one MATCH out of the batch on screen: the engine runs that seed again under the settings the batch used,
// so what loads is the MATCH the distribution counted rather than a similar one. The rows carry their seeds, so
// a thousand MATCHes stay reachable without keeping a thousand frame logs.
async function replayBatchMatch(n) {
  if (state.busy || !state.batchRows || !state.batchInput) return;
  const row = state.batchRows.find((r) => r.n === n);
  if (!row) {
    status(`MATCH ${n} is not in this batch — it ran ${state.batchRows.length}`, 'err');
    return;
  }
  busy(true);
  state.lastRun = 'replay';
  status(`Replaying MATCH ${n} (seed ${row.seed})…`, 'busy');
  setProgress(true, 0.2, '1 MATCH');
  try {
    const res = await ask('mc', { ...state.batchInput, matches: 1, recordFirst: true, seed: row.seed });
    pausePlayback();
    state.lastPayload = { ...state.batchInput, matches: 1, recordFirst: true, seed: row.seed };
    state.timeline = res.timeline;
    state.batchMatch = n;
    // The scope line has to name this as a MATCH out of the batch, or the panel reads as a fresh single run and
    // the reader cannot tell whether what is below is the distribution or one MATCH from it.
    state.lastCtx = { ...state.lastCtx, matches: 1, seed: row.seed, batchMatch: n, batchTotal: state.batchRows.length };
    $('scrub').max = String(Math.max(0, (res.timeline ? res.timeline.length : 1) - 1));
    renderResult(res, state.lastCtx);
    renderNotable();
    setFrame(0);
    status(`MATCH ${n} of the batch · seed ${row.seed} · ${row.ai}-${row.opp}`, 'ok');
  } catch (e) {
    taskFailure('Replay failed', e);
  } finally {
    busy(false);
    setProgress(false);
  }
}

// The MATCHes at the ends of the batch's distributions, each one reachable. Without this, "the AI's best was 712"
// is a number with no way to find out what happened in that MATCH.
function renderNotable() {
  const host = $('match-table');
  const note = $('match-note');
  const inp = $('inp-replay-match');
  const rows = state.batchRows;
  const at = state.batchResult?.at;
  if (!rows?.length || !at) {
    host.innerHTML = '';
    inp.max = '1';
    note.textContent = 'Run the Monte Carlo batch and this lists the MATCHes at the ends of its distributions, each one replayable.';
    return;
  }
  inp.max = String(rows.length);
  const labels = new Map();
  const say = (key, text) => {
    const row = rows[at[key]];
    if (row) labels.set(row.n, [...(labels.get(row.n) || []), text(row)]);
  };
  say('bestAi', (r) => `the AI seat's best score, ${r.ai}`);
  say('worstAi', (r) => `the AI seat's worst score, ${r.ai}`);
  say('bestOpp', (r) => `what the opponent did best, ${r.opp}`);
  say('worstOpp', (r) => `what the opponent did worst, ${r.opp}`);
  say('bestMargin', (r) => `widest AI win, +${r.margin}`);
  say('worstMargin', (r) => `widest AI loss, ${sign(r.margin)}${Math.abs(r.margin)}`);
  say('bestTotal', (r) => `${r.ai + r.opp} points between the two ALLIANCES`);
  say('worstTotal', (r) => `${r.ai + r.opp} points between the two ALLIANCES, the quietest MATCH of the batch`);
  const body = [];
  for (const row of rows) {
    if (!labels.has(row.n)) continue;
    body.push(
      `<tr><td class="mono">${row.n}</td><td class="mono">${row.seed}</td><td class="mono">${row.ai} - ${row.opp}</td>` +
        `<td class="mono">${sign(row.margin)}${Math.abs(row.margin)}</td><td class="mono">${fmt(row.foulsGiven, 0)}</td>` +
        `<td class="hint">${esc(labels.get(row.n).join(' · '))}</td>` +
        `<td><button class="btn" type="button" data-match="${row.n}"${state.batchMatch === row.n ? ' disabled' : ''}>` +
        `${state.batchMatch === row.n ? 'on the FIELD' : 'replay'}</button></td></tr>`,
    );
  }
  host.innerHTML = '<thead><tr><th>MATCH</th><th>seed</th><th>AI - opponent</th><th>margin</th><th>foul points given</th><th>why it stands out</th><th></th></tr></thead><tbody>' + body.join('') + '</tbody>';
  host.querySelectorAll('button[data-match]').forEach((b) => b.addEventListener('click', () => void replayBatchMatch(Number(b.dataset.match))));
  note.textContent = state.batchMatch
    ? `MATCH ${state.batchMatch} of ${rows.length} is on the FIELD, at seed ${rows[state.batchMatch - 1].seed} and the settings this batch ran. Pick any number up to ${rows.length} to load that one instead.`
    : `This batch ran ${rows.length} MATCHes on seeds ${state.batchInput?.seed ?? '—'} + i × 7919. Pick a number to replay one; the engine is deterministic, so what loads is the MATCH the distribution above counted.`;
}

async function runBench() {
  if (state.busy) return;
  busy(true);
  status('Running baselines…', 'busy');
  setProgress(true, 0.05, 'Random / fill-and-fire / greedy');
  try {
    const res = await ask(
      'benchmark',
      { weights: state.weights, matches: 8, iterations: 140 },
      (p) => setProgress(true, 0.4, `Running ${p.stage}`),
    );
    renderBench(res);
    status('Baselines done', 'ok');
  } catch (e) {
    taskFailure('Baselines failed', e);
  } finally {
    busy(false);
    setProgress(false);
  }
}

async function runTrain() {
  if (state.busy) return;
  const budget = Math.max(5, Math.min(120, Number($('inp-train-budget').value) || 30)) * 1000;
  busy(true);
  status('Self-play tuning…', 'busy');
  setProgress(true, 0, '0 generations');
  try {
    const res = await ask(
      'train',
      { weights: state.weights, generations: 40, lambda: 6, matches: 4, iterations: 110, budgetMs: budget, seed: 99, selfPlay: true },
      (p) => setProgress(true, p.gen / p.generations, `Generation ${p.gen} · fitness ${fmt(p.fit, 3)}`),
    );
    renderTrain(res);
    status('Training done (re-verify it)', 'ok');
  } catch (e) {
    taskFailure('Training failed', e);
  } finally {
    busy(false);
    setProgress(false);
  }
}

async function calibrate() {
  if (state.busy) return;
  busy(true);
  status('Calibrating the analytic model…', 'busy');
  try {
    const c = await ask('calibrate', { weights: state.weights, samples: 4 });
    state.calibration = c;
    state.weights = { ...state.weights, modelEfficiency: c.efficiency };
    renderBench(state.bench || { rows: [] });
    status('Ready', 'ok');
  } catch (e) {
    taskFailure('Calibration failed, using default weights', e);
  } finally {
    busy(false);
  }
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
function boot() {
  state.speed = Number($('sel-speed').value);
  renderRoster('red');
  renderRoster('blue');
  renderTeams();
  renderPeriodStrip(null);
  view.setLabels($('chk-tags').checked);
  view.setFocus(state.focus);
  $('chk-tags').addEventListener('change', (e) => {
    view.setLabels(e.target.checked);
    if (state.timeline) drawAt(state.playT);
    else view.drawFrame(null, null);
  });
  // The HUMAN PLAYER's throw rate and accuracy are per-alliance scenario values, so they are read
  // back before a run rather than pushed into a live match.
  for (const side of ['red', 'blue']) {
    const rate = $(`hp-${side}`);
    if (rate) {
      const sync = () => { state.humanThrow[side] = Math.max(0, Number(rate.value) || 0); };
      rate.addEventListener('input', sync);
      sync();
    }
    const acc = $(`hpacc-${side}`);
    if (acc) {
      const sync = () => { state.humanAcc[side] = Math.min(1, Math.max(0, (Number(acc.value) || 0) / 100)); };
      acc.addEventListener('input', sync);
      sync();
    }
  }
  $('hub-strip').className = 'hub-strip none';
  $('hub-strip').innerHTML = '<i class="ar">◀</i><span>Waiting for a match</span><i class="ar">▶</i>';
  renderRules();
  renderBench({ rows: [] });
  view.drawFrame(null, null);

  $('btn-run').addEventListener('click', runSingle);
  $('btn-mc').addEventListener('click', runMonteCarlo);
  $('btn-replay-match').addEventListener('click', () => {
    const last = state.batchRows?.length || 1;
    const n = Math.max(1, Math.min(last, Math.round(Number($('inp-replay-match').value) || 1)));
    $('inp-replay-match').value = String(n);
    void replayBatchMatch(n);
  });
  $('btn-cancel').addEventListener('click', () => {
    if (!state.busy) return;
    $('btn-cancel').disabled = true;
    stopWorker(new DOMException('Task cancelled', 'AbortError'));
  });
  // Changing the seat the AI plans from, or who it plans against, does not re-read the numbers already
  // on screen, and a stale batch labelled with the other question is worse than none: a single match is
  // cheap enough to just re-run, while a batch of 120 only says so and waits to be asked.
  const seatNote = () => {
    const side = plannedSide();
    const opp = opponentPick();
    $('aiside-note').textContent =
      opp.kind === 'ai'
        ? `Both sides search; everything below is read from ${side.toUpperCase()}.`
        : side === 'blue'
          ? `BLUE is the AI now; the red roster plays ${opp.label}.`
          : `RED is the AI; the blue roster plays ${opp.label}.`;
  };
  const reask = () => {
    seatNote();
    if (state.busy) return;
    if (state.lastRun === 'single') runSingle();
    else if (state.result) status(`Planning for ${plannedSide().toUpperCase()} against ${opponentPick().label} — run again to apply`, 'ok');
  };
  seatNote();
  $('sel-aiside').addEventListener('change', reask);
  $('sel-opponent').addEventListener('change', reask);
  $('btn-bench').addEventListener('click', runBench);
  $('btn-bench-recalc').addEventListener('click', runBench);
  $('btn-train').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="train"]').click();
  });
  $('btn-train-run').addEventListener('click', runTrain);
  $('btn-tab-rules').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="rules"]').click();
  });
  $('btn-tab-data').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="data"]').click();
  });
  $('btn-ev-prev').addEventListener('click', () => jumpEvent(-1));
  $('btn-ev-next').addEventListener('click', () => jumpEvent(1));
  $('btn-export').addEventListener('click', exportMatch);
  $('btn-import').addEventListener('click', () => $('inp-import').click());
  $('inp-import').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    status(`Reading ${f.name}…`, 'busy');
    try {
      importMatch(await f.text(), f.name);
    } catch (e) {
      status(`Could not read ${f.name}: ${e.message}`, 'err');
    } finally {
      ev.target.value = '';
    }
  });
  $('btn-play').addEventListener('click', () => {
    if (!state.timeline) return;
    if (state.playing) pausePlayback();
    else startPlayback();
  });
  $('scrub').addEventListener('input', (e) => {
    pausePlayback();
    setFrame(Number(e.target.value));
  });
  $('sel-speed').addEventListener('change', (e) => {
    state.speed = Number(e.target.value);
  });
  $('btn-cinema').addEventListener('click', () => setCinema(!state.cinema));
  $('btn-fs').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    document.body.classList.toggle('fs', on);
    const b = $('btn-fs');
    if (b) b.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
    requestAnimationFrame(relayoutStage);
  });
  // Keyboard, so the replay can be driven without hunting for the buttons: F is true fullscreen, C is
  // the cinema layout, Esc leaves the cinema layout (the browser already owns Esc for fullscreen),
  // space is play/pause, the arrows step a second at a time (5 with Shift) and the brackets jump
  // between fouls, climbs and faults. Text fields keep their own keys.
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || e.target.isContentEditable;
    if (typing || e.defaultPrevented) return;
    // A focused button or disclosure keeps its native Space/Enter action.
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('button, a, summary, [role="button"]')) return;
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      setCinema(!state.cinema);
    } else if (e.key === 'Escape' && state.cinema) {
      setCinema(false);
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      $('btn-play').click();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      stepFrames((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 50 : 10));
    } else if (e.key === '[') {
      e.preventDefault();
      jumpEvent(-1);
    } else if (e.key === ']') {
      e.preventDefault();
      jumpEvent(1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      goToTime(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      goToTime(state.timeline && state.timeline.length ? state.timeline[state.timeline.length - 1].t : 0);
    }
  });
  const tabs = [...document.querySelectorAll('.tab')];
  if (tabs.length) tabs[0].parentElement.setAttribute('role', 'tablist');
  for (const t of tabs) {
    t.id = `tab-button-${t.dataset.tab}`;
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-controls', `tab-${t.dataset.tab}`);
    const panel = $(`tab-${t.dataset.tab}`);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', t.id);
    panel.tabIndex = 0;
    t.addEventListener('click', () => {
      for (const x of tabs) {
        x.classList.toggle('active', x === t);
        x.setAttribute('aria-selected', String(x === t));
        x.tabIndex = x === t ? 0 : -1;
      }
      for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.id !== `tab-${t.dataset.tab}`;
      if (t.dataset.tab === 'insight') redrawInsightCharts();
      // The panel is `hidden` until this line runs, so a chart drawn when the result came back measured zero
      // and kept the fallback width. Redraw on the way in, the same reason the Tactics charts redraw on it.
      if (t.dataset.tab === 'detail') redrawMatchCharts();
    });
    t.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(t);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      event.stopPropagation();
      tabs[next].focus();
      tabs[next].click();
    });
  }
  const relayout = () => relayoutStage();
  window.addEventListener('resize', relayout);
  if (typeof ResizeObserver !== 'undefined') {
    // The canvas must follow its panel, not the window: panel width changes with the grid. In the
    // immersive layouts the canvas is sized from the viewport instead, and letting the observer fire
    // there would fight the fit (one size change re-triggers the observer).
    new ResizeObserver(() => {
      if (!state.cinema && !document.fullscreenElement) relayout();
    }).observe(document.querySelector('.field-panel'));
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
