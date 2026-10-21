// Scouting data in, ROBOT cards out.
//
// The page has always been filled by hand: six cards, thirty-odd fields each, typed from a spreadsheet
// someone else measured. That is the work that stops a team from using a simulator, so this reads the
// CSV a team actually has instead. No network at runtime — the rule this project keeps — so the data
// arrives as a file the user exports from wherever they keep it (a scouting sheet, a Statbotics EPA
// dump, a TBA spreadsheet download) and hands to the page.
//
// What is deliberately NOT here: a mapping from OPR or EPA to a card. Those are per-MATCH point
// aggregates, and a point in this model is either a FUEL in an active HUB or a TOWER level, so an
// alliance-level OPR cannot be split into a drive speed and a cycle rate without guessing which of the
// two the team is actually good at. Columns below are things a stopwatch or a tape measure produces.
// A file that only carries aggregate points will import with a line per column it could not use, which
// is the honest outcome: the machine gets faster or slower, and the reason stays the team's judgement.
//
// Units are the Manual's (inches and seconds, §1.6), so metric columns are accepted under their own
// names and converted here rather than silently read as inches.

// Accepted header names → the card field they write. A header is matched case-insensitively, with
// spaces, hyphens and underscores treated as the same separator, so `Drive Speed`, `drive_speed` and
// `drivespeedips` all land on the one card field.
import { MECHANISMS, INTAKE_SIDES, CHASSIS, DRIVERS, STARTS } from './model.js';

// The allowed values are read from model.js rather than typed out here, so a file cannot validate
// against a list this module invented and the engine does not have.
const CHOICES = {
  mechanism: MECHANISMS,
  intakeSide: INTAKE_SIDES,
  chassis: CHASSIS,
  driver: DRIVERS,
  start: STARTS,
};
const CHOICE_ALIAS = {
  // How teams write these in a spreadsheet, mapped to the model's own keys. Anything else is reported,
  // not guessed: a "hopper" mechanism is a third thing this engine has no physics for.
  fullwidthdumper: 'dumper', dumper: 'dumper', fixed: 'dumper',
  wheels: 'tank', tank: 'tank', tankdrive: 'tank',
  rear: 'back', forwardsame: 'front',
  novice: 'rookie', intermediate: 'average', average: 'average', good: 'good', elite: 'elite',
};

const COLUMNS = [
  ['team', 'team', 'integer', null],
  ['name', 'name', 'text', null],
  ['mechanism', 'mechanism', 'choice:mechanism', null],
  ['chassis', 'chassis', 'choice:chassis', null],
  ['intakeside', 'intakeSide', 'choice:intakeSide', null],
  ['driver', 'driver', 'choice:driver', null],
  ['start', 'start', 'choice:start', null],
  ['drivespeedips', 'driveSpeedIps', 'range:10:400', 'in/s'],
  ['drivespeedmps', 'driveSpeedIps', 'mps', 'm/s × 39.37'],
  ['intakerate', 'intakeRate', 'range:0:40', 'FUEL/s'],
  ['capacity', 'capacity', 'range:0:200', 'FUEL'],
  ['shootrate', 'shootRate', 'range:0:40', 'FUEL/s'],
  ['shootaccuracy', 'shootAccuracy', 'pct', '0-100% or 0-1'],
  ['passrangein', 'passRangeIn', 'range:24:660', 'in'],
  ['passrangeM', 'passRangeIn', 'meters:24:660', 'm × 39.37'],
  ['heightin', 'heightIn', 'range:12:30', 'in'],
  ['heightcm', 'heightIn', 'cm', 'cm ÷ 2.54'],
  ['weightlb', 'weightLb', 'range:60:135', 'lb'],
  ['climbmax', 'climbMax', 'climb', '0-3'],
  ['climbtime', 'climbTime', 'range:0:30', 's'],
  ['autoroutine', 'autoRoutine', 'range:0:120', 'FUEL in AUTO'],
  ['plays', 'plays', 'bool', 'on the field'],
];

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const LOOKUP = new Map(COLUMNS.map((c) => [norm(c[0]), c]));
for (const [alias, target] of [
  ['teamnumber', 'team'], ['teamno', 'team'], ['number', 'team'],
  ['robotname', 'name'], ['robot', 'name'],
  ['speed', 'drivespeedips'], ['drivespeed', 'drivespeedips'], ['maxspeed', 'drivespeedips'],
  ['speedms', 'drivespeedmps'], ['drivespeedms', 'drivespeedmps'],
  ['intake', 'intakerate'], ['intakeratefps', 'intakerate'],
  ['hopper', 'capacity'], ['cargo', 'capacity'],
  ['shooter', 'shootrate'], ['launchrate', 'shootrate'],
  ['accuracy', 'shootaccuracy'], ['aim', 'shootaccuracy'], ['shootaccuracypercent', 'shootaccuracy'],
  ['passrange', 'passrangein'], ['reach', 'passrangein'], ['passrangem', 'passrangem'],
  ['height', 'heightin'], ['robotheight', 'heightin'], ['heightcm', 'heightcm'],
  ['weight', 'weightlb'],
  ['climb', 'climbmax'], ['maxclimb', 'climbmax'], ['climblevel', 'climbmax'],
  ['climbsec', 'climbtime'], ['climbtime', 'climbtime'],
  ['auto', 'autoroutine'], ['autofuel', 'autoroutine'], ['autoscore', 'autoroutine'], ['autonumscore', 'autoroutine'],
  ['bench', 'plays'], ['onthefield', 'plays'],
]) {
  const t = LOOKUP.get(norm(target));
  if (t) LOOKUP.set(norm(alias), t);
}

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'on', 'fielded', 'playing']);
const FALSY = new Set(['0', 'false', 'no', 'n', 'off', 'bench', 'spare']);

export const COLUMN_DOC = COLUMNS.map(([header, field, kind, unit]) => ({ header, field, kind, unit }));

function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delim && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function headerDelim(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const counts = [',', ';', '\t'].map((d) => [d, splitLine(first, d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

const num = (v) => {
  const m = String(v).replace(/[^\d.\-]/g, '');
  // A cell that is all words ("fast", "n/a", "tbd") has nothing left after the digits are stripped, and
  // Number('') is 0 — which would write a 0-inch-per-second robot instead of skipping the column.
  if (m === '' || m === '-' || m === '.') return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
};

// Every numeric column ends up here, so a value that has to be clamped is always *said* — a card that
// quietly absorbed a 120 cm robot as a 30 inch one would be a measurement the user cannot see.
function put(patch, field, value, lo, hi, where, problems) {
  const v = Math.max(lo, Math.min(hi, value));
  if (v !== value) problems.push(`${where}: ${round(value)} is outside the ${lo}-${hi} this model can run; clamped to ${v}`);
  patch[field] = v;
}
const round = (n) => Math.round(n * 100) / 100;

function applyKind(spec, raw, patch, problems, where) {
  const [kind, lo, hi] = spec.split(':');
  switch (spec) {
    case 'choice:mechanism':
    case 'choice:chassis':
    case 'choice:intakeSide':
    case 'choice:driver':
    case 'choice:start': {
      const which = spec.split(':')[1];
      const list = CHOICES[which];
      const key = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
      const byLabel = list.find((o) => norm(o.label) === key);
      const v = byLabel ? byLabel.key : CHOICE_ALIAS[key] && list.some((o) => o.key === CHOICE_ALIAS[key]) ? CHOICE_ALIAS[key] : key;
      if (list.some((o) => o.key === v)) patch[which] = v;
      else problems.push(`${where}: "${raw}" is not a ${which} this engine models (${list.map((o) => o.label).join('/')}); column skipped`);
      return;
    }
    case 'climb': {
      const n = num(raw);
      const lvl = n === null ? (FALSY.has(String(raw).toLowerCase()) ? 0 : null) : Math.round(n);
      if (lvl === null || lvl < 0 || lvl > 3) problems.push(`${where}: climb "${raw}" is not 0-3; column skipped`);
      else patch.climbMax = lvl;
      return;
    }
    case 'bool': {
      const s = String(raw).toLowerCase();
      if (TRUTHY.has(s)) patch.plays = true;
      else if (FALSY.has(s)) patch.plays = false;
      else problems.push(`${where}: "${raw}" is not a yes/no; column skipped`);
      return;
    }
    case 'pct': {
      const n = num(raw);
      if (n === null) { problems.push(`${where}: "${raw}" is not a number; accuracy skipped`); return; }
      put(patch, 'shootAccuracy', n > 1 ? n / 100 : n, 0.05, 0.99, where, problems);
      return;
    }
    case 'mps': {
      const n = num(raw);
      if (n === null) { problems.push(`${where}: "${raw}" is not a number; speed skipped`); return; }
      put(patch, 'driveSpeedIps', n * 39.3701, 10, 400, where, problems);
      return;
    }
    case 'cm': {
      const n = num(raw);
      if (n === null) { problems.push(`${where}: "${raw}" is not a number; height skipped`); return; }
      put(patch, 'heightIn', n / 2.54, 12, 30, where, problems);
      return;
    }
    default: break;
  }
  if (kind === 'range') {
    const n = num(raw);
    if (n === null) { problems.push(`${where}: "${raw}" is not a number; column skipped`); return; }
    put(patch, FIELD_BY_SPEC.get(spec), n, Number(lo), Number(hi), where, problems);
    return;
  }
  if (kind === 'integer') {
    const n = num(raw);
    if (n === null) { problems.push(`${where}: "${raw}" is not a number; column skipped`); return; }
    patch.team = Math.round(n);
    return;
  }
  if (kind === 'text') {
    patch.name = String(raw).slice(0, 40);
    return;
  }
  if (kind === 'meters') {
    const n = num(raw);
    if (n === null) { problems.push(`${where}: "${raw}" is not a number; column skipped`); return; }
    put(patch, 'passRangeIn', n * 39.3701, Number(lo), Number(hi), where, problems);
  }
}

// The card field each spec writes, resolved once so the switch above cannot drift from the table.
const FIELD_BY_SPEC = new Map(COLUMNS.map((c) => [c[2], c[1]]));

export function parseScouting(text) {
  const problems = [];
  const rows = [];
  const clean = String(text || '').replace(/^/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (lines.length < 2) {
    return { rows, problems: ['a CSV needs a header line and at least one robot'], unknown: [] };
  }
  const delim = headerDelim(clean);
  const head = splitLine(lines[0], delim);
  const spec = head.map((h, i) => {
    const found = LOOKUP.get(norm(h));
    if (!found) { problems.push(`column ${i + 1} "${h}" is not a field this model reads`); return null; }
    return { idx: i, ...found };
  });
  const unknown = head.filter((h, i) => !spec[i]);
  for (let r = 1; r < lines.length; r++) {
    const cells = splitLine(lines[r], delim);
    if (cells.length < 2) { problems.push(`row ${r}: one cell only, skipped`); continue; }
    const patch = {};
    for (const col of spec) {
      if (!col) continue;
      const raw = cells[col.idx];
      if (raw === undefined || raw === '') continue;
      applyKind(col[2], raw, patch, problems, `row ${r} (${col[0]})`);
    }
    if (!Object.keys(patch).length) { problems.push(`row ${r}: nothing usable in it, skipped`); continue; }
    rows.push(patch);
  }
  return { rows, problems, unknown };
}

// A CSV row arrives with the same flat names the roster editor and the autosave use, and a card keeps
// `climb` and `auto` as nested objects. Translating here — rather than letting `Object.assign` drop an
// `autoRoutine` key no engine code reads — is what makes an imported AUTO declaration actually declare.
function toCard(patch) {
  const out = { ...patch };
  if ('climbMax' in out || 'climbTime' in out) {
    const climb = { ...(out.climb || {}) };
    if ('climbMax' in out) {
      const n = out.climbMax;
      climb.l1 = n >= 1;
      climb.l2 = n >= 2;
      climb.l3 = n >= 3;
      if (n >= 1 && !climb.timeSec && !('climbTime' in out)) climb.timeSec = 8;
      delete out.climbMax;
    }
    if ('climbTime' in out) {
      climb.timeSec = out.climbTime;
      delete out.climbTime;
    }
    out.climb = climb;
  }
  if ('autoRoutine' in out) {
    out.auto = { ...(out.auto || {}), routineFuel: out.autoRoutine };
    delete out.autoRoutine;
  }
  return out;
}

// Where the rows go: a file of six rows fills both ALLIANCES, three to a side; a file of three fills the
// seat the page is planning for, and a file of one to two fills that seat's first slots and leaves the
// rest of the roster alone. Anything longer is a scouting list, not a MATCH setup: the first three of the
// side being planned get them and the rest is reported, because silently dropping rows a user typed is
// worse than saying which ones were not used.
export function placeRosters(rows, plannedSide, current) {
  const notes = [];
  const next = { red: current.red.map((p) => ({ ...p })), blue: current.blue.map((p) => ({ ...p })) };
  if (!rows.length) return { rosters: next, notes: ['nothing to import'] };
  const order = plannedSide === 'blue' ? ['blue', 'red'] : ['red', 'blue'];
  if (rows.length === 6) {
    rows.slice(0, 3).forEach((patch, i) => Object.assign(next.red[i], toCard(patch)));
    rows.slice(3, 6).forEach((patch, i) => Object.assign(next.blue[i], toCard(patch)));
    notes.push('six rows: three to each ALLIANCE, the planning seat first');
    return { rosters: next, notes };
  }
  const side = order[0];
  const fill = rows.slice(0, 3);
  fill.forEach((patch, i) => Object.assign(next[side][i], toCard(patch)));
  notes.push(`${fill.length} row(s) onto ${side.toUpperCase()}; the other ALLIANCE keeps its cards`);
  if (rows.length > 3) notes.push(`${rows.length - 3} further row(s) were not fielded — a MATCH seats three ROBOTS an ALLIANCE`);
  return { rosters: next, notes };
}
