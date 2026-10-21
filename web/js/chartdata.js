// Everything the single-MATCH charts draw, derived from what the engine already recorded. No counter here is
// new: an anchor carries `s` (the running ledger), `hub` (whether that ALLIANCE's HUB accepts FUEL at that
// instant) and per-ROBOT `m`/`c`, and the frames are written every tick (`RECORD_EVERY_TICKS = 1`). So a chart
// and the table beside it are one computation over one record, and nothing in this file can move a fingerprint.

export const MODE_ORDER = ['COLLECT', 'STOCKPILE', 'SCORE', 'PASS', 'PUSH', 'DEFEND', 'CLIMB', 'FEED', 'IDLE'];

export function strideOf(tl) {
  return tl.length > 1 ? tl[1].t - tl[0].t : 0.1;
}

// A MATCH is 1601 anchors and a chart is a few hundred pixels wide, so every series is thinned to at most
// `cap` points. The last point is always kept: a series that stops short of the whistle draws a score that
// never reaches the number the scoreboard shows.
export function sampleIdx(n, cap = 240) {
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (cap - 1));
  const out = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  out.push(n - 1);
  return out;
}

export function scoreSeries(tl, side) {
  const idx = sampleIdx(tl.length);
  const t = [];
  const v = [];
  for (const i of idx) {
    t.push(tl[i].t);
    v.push(tl[i].s ? tl[i].s[side].total : 0);
  }
  return { t, v };
}

// Where the period changes, so the trend chart can shade AUTO / TELEOP / END GAME instead of leaving the reader
// to infer them from a bend in the line.
export function periodBands(tl) {
  const out = [];
  for (let i = 0; i < tl.length; i++) {
    const p = tl[i].p;
    const last = out[out.length - 1];
    if (last && last.p === p) last.t1 = tl[i].t;
    else out.push({ p, t0: tl[i].t, t1: tl[i].t });
  }
  return out;
}

// The same HUB window read the other way: not how many seconds it was open (the note under the flow table
// counts those) but when. `hub[side]` is the engine's own `hubActive(side, t)`, so a gap in this band is a gap
// in which that ALLIANCE's HUB would not take FUEL — the AUTO and END GAME windows included, because this is
// read off the anchors and not off the shift schedule.
export function windowBands(tl, side) {
  const stride = strideOf(tl);
  const out = [];
  for (let i = 0; i < tl.length; i++) {
    const on = !!tl[i].hub[side];
    const last = out[out.length - 1];
    if (last && last.on === on) last.t1 = tl[i].t + stride;
    else out.push({ on, t0: last ? last.t1 : 0, t1: tl[i].t + stride });
  }
  return out;
}

export function robotRows(tl) {
  if (!tl.length) return [];
  return tl[0].r.map((x, pos) => ({ pos, i: x.i, alliance: x.a }));
}

// What each ROBOT was told to be doing, anchor by anchor. The engine re-decides every 0.2 s (`decideEvery`), so
// a segment shorter than that is the same decision held; segments are merged on the mode, not on the anchor, so
// one flicker of IDLE between two drives does not read as a role change.
export function modeBands(tl, pos) {
  const stride = strideOf(tl);
  const out = [];
  for (let i = 0; i < tl.length; i++) {
    const row = tl[i].r[pos];
    const m = row ? row.m : 'IDLE';
    const last = out[out.length - 1];
    if (last && last.m === m) last.t1 = tl[i].t + stride;
    else out.push({ m, t0: last ? last.t1 : 0, t1: tl[i].t + stride });
  }
  return out;
}

// Per-ROBOT FUEL by where it was lying when the mouth closed. `stats.collectFrom` is an engine counter, and
// `taken` is the same number the flow table prints, so the bar and the column agree by construction.
export function sourceRows(stats) {
  return stats.map((s) => ({
    name: s.name,
    alliance: s.alliance,
    neutral: s.collectFrom.neutral,
    zone: s.collectFrom.zone,
    feed: s.collectFrom.feed,
    kept: s.fuelReclaimed,
    taken: s.fuelCollected,
  }));
}
