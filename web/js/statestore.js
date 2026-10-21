// The page's setup as text: one localStorage write and one shareable link, both the same bytes.
//
// Two things this fixes. Nothing was saved before: a teammate who spent twenty minutes filling in
// measured numbers for six ROBOTs lost them to a refresh, and there was no way to hand the same setup
// to anyone else except the per-MATCH replay file, which carries a MATCH rather than a question. The
// link and the autosave are the same object through the same codec, so a link cannot restore something
// the autosave would not.
//
// It touches no DOM and reads no storage — `ui.js` owns the storage and the inputs, and this owns what
// bytes mean — which is what lets `scripts/runtime.test.mjs` attack the decoder directly. Everything
// that comes back out of a link or a stale localStorage entry is treated as hostile input: unknown keys
// dropped, numbers checked and clamped to a range a card can actually be built with, enums matched to
// the editor's own choices or the field dropped, weights pushed through `clampWeights` so a link cannot
// smuggle a vector past the bounds `ai.js` declares. A decoder that half-trusted its input would be a
// way to crash the engine from a URL.
//
// A card is stored as a preset index plus the fields the editor can change, so six reference robots cost
// a few hundred bytes and a Custom card costs its own differences. Storing the whole profile instead
// would carry `ref` and `source` strings nobody edits and double the link.

import { DEFAULT_PROFILE, SAMPLES, MECHANISMS, INTAKE_SIDES, CHASSIS, STARTS, DRIVERS } from './model.js';
import { WEIGHT_KEYS, WEIGHT_BOUNDS, clampWeights, DEFAULT_WEIGHTS } from './ai.js';

export const SETUP_VERSION = 'xplore-setup-v1';
export const STORAGE_KEY = 'xplore-sim-setup-v1';
export const HASH_PREFIX = '#s=';
// A link anyone can paste has to survive being pasted into a chat app. Long rosters compress poorly,
// so a setup that cannot fit is refused with a message rather than silently truncated.
export const MAX_LINK_CHARS = 16384;

// The keys `renderRoster` writes, mapped to the range it will accept. The bounds are the editor's own
// `min`/`max` where it has them and a physical envelope otherwise; nothing here is a rule limit — R104
// and friends are checked where they are modelled, not in a transport layer.
const NUMERIC = {
  turnRateDegPerSec: [30, 1200],
  driveSpeedIps: [10, 400],
  intakeRate: [0, 40],
  capacity: [0, 200],
  shootRate: [0, 40],
  shootAccuracy: [0.05, 0.99],
  passRangeIn: [24, 660],
  heightIn: [12, 30],
  weightLb: [60, 135],
  refShootDistanceIn: [12, 200],
  accuracyFalloff: [0, 0.02],
};
const CHOICE = {
  // The four lists the roster editor builds by hand (CROSS/PASS/PUSH/FEED_OPTIONS in ui.js) and the five
  // that come from model.js. `scripts/check_web.mjs` holds the two halves in step with each other,
  // because a value the select cannot show is a card the reader cannot see.
  cross: ['auto', 'both', 'bump', 'trench', 'none'],
  passMode: ['off', 'auto', 'eager'],
  pushMode: ['off', 'passive', 'active'],
  feedMode: ['off', 'auto'],
  mechanism: MECHANISMS.map((m) => m.key),
  chassis: CHASSIS.map((c) => c.key),
  intakeSide: INTAKE_SIDES.map((s) => s.key),
  start: STARTS.map((s) => s.key),
  driver: DRIVERS.map((d) => d.key),
};
const CLIMB_LEVELS = [0, 1, 2, 3];
const BOOLEAN = ['plays', 'canBump', 'canTrench'];

// What a card may hold at all: every field DEFAULT_PROFILE declares, plus the four names the roster
// editor's selects write — `cross`, `climbMax`, `climbTime`, `attachTimeSec` — which are unpacked below
// into `climb` and the canBump/canTrench pair rather than stored under those keys.
const PROFILE_KEYS = new Set([...Object.keys(DEFAULT_PROFILE()), 'cross', 'climbMax', 'climbTime', 'attachTimeSec', 'autoRoutine']);

const SCENARIO_KEYS = ['objective', 'event', 'autoWinner', 'towerL1TeleopAllowed', 'faultsEnabled', 'contactFouls'];
const SCENARIO_CHOICE = {
  objective: ['rs', 'rp'],
  event: ['regional', 'districtChamp'],
  autoWinner: ['auto', 'even', 'red', 'blue'],
};

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// A card as a preset plus its differences. `-1` is Custom, which has no preset to diff against.
export function packProfile(prof) {
  const idx = SAMPLES.findIndex((s) => s.team === prof.team && s.name === prof.name);
  const base = idx >= 0 ? SAMPLES[idx] : DEFAULT_PROFILE();
  const diff = {};
  for (const key of [...Object.keys(NUMERIC), ...Object.keys(CHOICE), ...BOOLEAN]) {
    if (key === 'canBump' || key === 'canTrench') {
      if (prof[key] !== base[key]) diff[key] = prof[key] === null ? null : !!prof[key];
      continue;
    }
    if (prof[key] !== undefined && prof[key] !== base[key]) diff[key] = prof[key];
  }
  // The climb select writes a level and a time; the profile stores three booleans.
  const level = prof.climb?.l3 ? 3 : prof.climb?.l2 ? 2 : prof.climb?.l1 ? 1 : 0;
  if (level !== climbLevelOf(base)) diff.climbMax = level;
  if ((prof.climb?.timeSec ?? 0) !== (base.climb?.timeSec ?? 0)) diff.climbTime = prof.climb?.timeSec ?? 0;
  // The declared AUTO lives inside the nested `auto` block, so it travels as its own flat name; null is
  // the difference between "simulate the 20 seconds" and "this machine scores N in AUTO", and a diff that
  // dropped it would silently turn a declared routine back into a simulated one.
  const routine = prof.auto?.routineFuel ?? null;
  if (routine !== (base.auto?.routineFuel ?? null)) diff.autoRoutine = routine;
  if (prof.team !== base.team) diff.team = prof.team;
  if (prof.name !== base.name) diff.name = prof.name;
  return idx >= 0 ? { p: idx, d: diff } : { p: -1, d: { ...stripProvenance(base), ...diff } };
}

export function unpackProfile(row, problems) {
  const idx = Number.isInteger(row?.p) && row.p >= 0 && row.p < SAMPLES.length ? row.p : -1;
  const base = idx >= 0 ? SAMPLES[idx] : DEFAULT_PROFILE();
  const out = JSON.parse(JSON.stringify(base));
  const d = row?.d && typeof row.d === 'object' ? row.d : {};
  if (row?.p === -1) {
    // A Custom card carries its own whole profile, so provenance strings from a preset must not ride
    // along and label a hand-typed card as someone else's reference robot. And it is copied key by key
    // through the whitelist rather than `Object.assign`d: `__proto__` is an own enumerable property of
    // a parsed JSON object, and assigning it is a prototype write — a link would be a way to reach into
    // the page's object graph from someone's clipboard.
    const fresh = JSON.parse(JSON.stringify(base));
    for (const [k, v] of Object.entries(d)) {
      if (k === 'ref' || k === 'source') continue;
      if (!PROFILE_KEYS.has(k)) {
        problems.push(`a Custom card carries "${k}", which no card field is called; dropped`);
        continue;
      }
      fresh[k] = v;
    }
    Object.assign(out, fresh);
  }
  for (const [key, range] of Object.entries(NUMERIC)) {
    if (!(key in d)) continue;
    const v = Number(d[key]);
    if (!isFiniteNumber(v)) {
      problems.push(`${key}="${d[key]}" is not a number; kept the ${idx >= 0 ? 'preset' : 'default'} value`);
      continue;
    }
    if (v < range[0] || v > range[1]) {
      out[key] = Math.min(range[1], Math.max(range[0], v));
      problems.push(`${key} ${v} is outside ${range[0]}–${range[1]}; clamped to ${out[key]}`);
    } else out[key] = v;
  }
  for (const [key, allowed] of Object.entries(CHOICE)) {
    if (!(key in d)) continue;
    if (typeof d[key] === 'string' && allowed.includes(d[key])) {
      if (key === 'cross') applyCross(out, d[key]);
      else out[key] = d[key];
    } else problems.push(`${key}="${d[key]}" is not a choice the editor offers; kept ${out[key] ?? 'the default'}`);
  }
  for (const key of BOOLEAN) {
    if (!(key in d)) continue;
    if (key === 'canBump' || key === 'canTrench') {
      if (d[key] === null || typeof d[key] === 'boolean') out[key] = d[key];
      else problems.push(`${key} must be true, false or null; kept ${out[key]}`);
    } else if (typeof d[key] === 'boolean') out[key] = d[key];
    else problems.push(`${key}="${d[key]}" is not a yes/no; kept ${out[key]}`);
  }
  if ('climbMax' in d) {
    const lvl = CLIMB_LEVELS.includes(Number(d.climbMax)) ? Number(d.climbMax) : -1;
    if (lvl < 0) problems.push(`climbMax ${d.climbMax} is not 0-3; kept ${climbLevelOf(out)}`);
    else {
      out.climb = { ...(out.climb || {}), l1: lvl >= 1, l2: lvl >= 2, l3: lvl >= 3 };
    }
  }
  if ('climbTime' in d) {
    const t = Number(d.climbTime);
    if (isFiniteNumber(t) && t >= 0 && t <= 30) out.climb = { ...(out.climb || {}), timeSec: t };
    else problems.push(`climbTime ${d.climbTime} is outside 0-30 s; kept ${out.climb?.timeSec ?? 0}`);
  }
  if ('autoRoutine' in d) {
    const v = d.autoRoutine;
    if (v === null) out.auto = { ...(out.auto || {}), routineFuel: null };
    else if (isFiniteNumber(Number(v)) && Number(v) >= 0 && Number(v) <= 120) out.auto = { ...(out.auto || {}), routineFuel: Math.round(Number(v)) };
    else problems.push(`autoRoutine ${JSON.stringify(v)} is neither null nor 0-120; that card's AUTO stays simulated`);
  }
  if (typeof d.attachTimeSec === 'number' && isFiniteNumber(d.attachTimeSec)) out.climb = { ...(out.climb || {}), attachTimeSec: d.attachTimeSec };
  if (Number.isInteger(d.team) && d.team >= 0 && d.team <= 99999) out.team = d.team;
  if (typeof d.name === 'string' && d.name.length <= 40) out.name = d.name;
  // A preset row is only ever read through the named fields above, so anything else in it is dropped
  // here rather than at the assignment. Say which: a link that lost a switch is worth a sentence, and
  // `__proto__` reaching this list is the case the loop exists for — it is an own enumerable property of
  // a JSON.parse'd object, and copying it key by key would be a prototype write.
  const unknown = Object.keys(d).filter((k) => !PROFILE_KEYS.has(k) && k !== 'ref' && k !== 'source');
  if (unknown.length && row?.p !== -1) problems.push(`a card carries field(s) ${unknown.map((k) => `"${k}"`).join(', ')} that no card has; dropped`);
  return out;
}

const climbLevelOf = (prof) => (prof?.climb?.l3 ? 3 : prof?.climb?.l2 ? 2 : prof?.climb?.l1 ? 1 : 0);
const stripProvenance = ({ ref, source, ...rest }) => rest;
function applyCross(out, v) {
  out.canBump = v === 'auto' ? null : v === 'both' || v === 'bump';
  out.canTrench = v === 'auto' ? null : v === 'both' || v === 'trench';
}

export function buildSetup({ rosters, weights, scenario, seed, matches, iterations, side, opponent }) {
  const problems = [];
  const sc = scenario && typeof scenario === 'object' ? scenario : {};
  const cleanScenario = {};
  for (const key of SCENARIO_KEYS) {
    if (SCENARIO_CHOICE[key]) {
      if (typeof sc[key] === 'string' && SCENARIO_CHOICE[key].includes(sc[key])) cleanScenario[key] = sc[key];
      else problems.push(`scenario ${key}="${sc[key]}" is not an option the page offers; left at its default`);
    } else if (typeof sc[key] === 'boolean') cleanScenario[key] = sc[key];
  }
  const hp = (obj, key, max) => {
    const v = Number(obj?.[key]);
    if (!isFiniteNumber(v)) return null;
    return Math.max(0, Math.min(max, v));
  };
  return {
    v: SETUP_VERSION,
    red: [packProfile(rosters.red[0]), packProfile(rosters.red[1]), packProfile(rosters.red[2])],
    blue: [packProfile(rosters.blue[0]), packProfile(rosters.blue[1]), packProfile(rosters.blue[2])],
    weights: Object.fromEntries(WEIGHT_KEYS.map((k) => [k, Number.isFinite(weights?.[k]) ? weights[k] : DEFAULT_WEIGHTS[k]])),
    scenario: cleanScenario,
    humanThrow: { red: hp(sc.humanThrowPerSec, 'red', 8), blue: hp(sc.humanThrowPerSec, 'blue', 8) },
    humanAccuracy: { red: hp(sc.humanAccuracy, 'red', 100), blue: hp(sc.humanAccuracy, 'blue', 100) },
    seed: Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? seed : null,
    matches: Number.isInteger(matches) && matches >= 1 ? matches : null,
    iterations: Number.isInteger(iterations) && iterations >= 1 ? iterations : null,
    side: side === 'blue' ? 'blue' : 'red',
    opponent: typeof opponent === 'string' && /^[a-z0-9_-]{1,24}$/.test(opponent) ? opponent : null,
    problems,
  };
}

// The decode path: bytes in, a setup out, or nothing. Every field is re-validated here rather than
// trusted from `buildSetup`, because the bytes may be years old, hand-edited, or someone's guess.
export function readSetup(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object') return { setup: null, problems: ['the stored setup is not an object'] };
  if (obj.v !== SETUP_VERSION) return { setup: null, problems: [`stored setup is version ${String(obj.v)}, this page writes ${SETUP_VERSION}`] };
  const sides = {};
  for (const side of ['red', 'blue']) {
    const rows = Array.isArray(obj[side]) ? obj[side] : [];
    if (rows.length !== 3) {
      problems.push(`${side} has ${rows.length} ROBOTS; a MATCH needs three`);
      continue;
    }
    const profiles = rows.map((r) => unpackProfile(r, problems));
    if (profiles.filter((p) => p.plays !== false).length < 1) problems.push(`${side} benched all three ROBOTS`);
    sides[side] = profiles;
  }
  if (!sides.red) sides.red = SAMPLES.slice(0, 3).map((p) => JSON.parse(JSON.stringify(p)));
  if (!sides.blue) sides.blue = SAMPLES.slice(3, 6).map((p) => JSON.parse(JSON.stringify(p)));
  const raw = obj.weights && typeof obj.weights === 'object' ? obj.weights : {};
  const weights = { ...DEFAULT_WEIGHTS };
  for (const key of WEIGHT_KEYS) {
    if (!isFiniteNumber(raw[key])) continue;
    const b = WEIGHT_BOUNDS[key];
    if (b && (raw[key] < b[0] || raw[key] > b[1])) problems.push(`weight ${key} ${raw[key]} is outside ${b[0]}–${b[1]}`);
    weights[key] = raw[key];
  }
  const sc = obj.scenario && typeof obj.scenario === 'object' ? obj.scenario : {};
  const scenario = {};
  for (const key of SCENARIO_KEYS) {
    if (SCENARIO_CHOICE[key]) {
      if (typeof sc[key] === 'string' && SCENARIO_CHOICE[key].includes(sc[key])) scenario[key] = sc[key];
      else if (sc[key] !== undefined) problems.push(`scenario ${key}="${sc[key]}" is not an option; dropped`);
    } else if (typeof sc[key] === 'boolean') scenario[key] = sc[key];
    // A switch that arrives as "true" rather than true is the link writer's guess about a value this
    // page never stores that way. Silently keeping the page's current setting would let a link that
    // means "fouls on" run with fouls off.
    else if (sc[key] !== undefined) problems.push(`scenario ${key}="${sc[key]}" is not a yes/no; dropped`);
  }
  const num = (v, lo, hi) => (isFiniteNumber(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);
  const rangeOf = (src, max) => ({
    red: num(src?.red, 0, max),
    blue: num(src?.blue, 0, max),
  });
  return {
    setup: {
      v: SETUP_VERSION,
      rosters: sides,
      weights: clampWeights(weights),
      scenario,
      humanThrow: rangeOf(obj.humanThrow, 8),
      humanAccuracy: rangeOf(obj.humanAccuracy, 100),
      seed: num(obj.seed, 0, 4294967295),
      matches: num(obj.matches, 1, 1200),
      iterations: num(obj.iterations, 40, 600),
      side: obj.side === 'blue' ? 'blue' : 'red',
      opponent: typeof obj.opponent === 'string' && /^[a-z0-9_-]{1,24}$/.test(obj.opponent) ? obj.opponent : null,
    },
    problems,
  };
}

// ---- bytes -----------------------------------------------------------------------------------
// Pure base64url over UTF-8, no `btoa`/`Buffer`, so the same codec runs in the page and in the Node
// test. `+`/`/` become `-`/`_` and padding is dropped because this goes in a URL fragment.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '';
  }
  return out;
}

export function decode(text) {
  const clean = String(text || '').replace(/^#s=/, '');
  if (!clean) return { obj: null, error: 'empty' };
  let bits = '';
  for (const ch of clean) {
    const i = B64.indexOf(ch);
    if (i < 0) return { obj: null, error: `${JSON.stringify(ch)} is not base64url` };
    bits += i.toString(2).padStart(6, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  let json;
  try {
    json = new TextDecoder().decode(bytes);
  } catch (e) {
    return { obj: null, error: 'the bytes are not UTF-8' };
  }
  try {
    return { obj: JSON.parse(json), error: null };
  } catch (e) {
    return { obj: null, error: 'it is not JSON inside the link' };
  }
}

export function toLink(setup) {
  const text = encode(setup);
  if (text.length > MAX_LINK_CHARS) return { link: null, chars: text.length, error: `this setup needs ${text.length} characters of link, over the ${MAX_LINK_CHARS} this page will write` };
  return { link: HASH_PREFIX + text, chars: text.length, error: null };
}

// A setup is a question, not a result: two setups that differ only in fields the engine never reads are
// the same thing to save twice. Used to keep the autosave from writing on every keystroke that changed
// nothing.
export function sameSetup(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
