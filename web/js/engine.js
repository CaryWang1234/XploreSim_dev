// REBUILT MATCH engine. The engine owns kinematics, FUEL flow and the manual's rules, and it
// never decides strategy: an injected policy returns only an INTENT per ROBOT while the engine
// executes, adjudicates and scores. Keeping decisions out of the engine means the same engine
// can score a hand-written plan, a naive bot, or the search-based AI without favouring either.

import { TIME, POINTS, FUEL, FIELD, hubActiveTable } from './rules.js';
import { periodAt, defaultScenario } from './model.js';
import { makeRng } from './rng.js';

export const INTENT = {
  IDLE: 'IDLE',
  COLLECT: 'COLLECT',
  STOCKPILE: 'STOCKPILE',
  SCORE: 'SCORE',
  DEFEND: 'DEFEND',
  CLIMB: 'CLIMB',
  FEED: 'FEED',
};

const other = (a) => (a === 'red' ? 'blue' : 'red');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// How much of a ROBOT's intake throughput an opponent in contact takes away, at full defence
// pressure. Defence in this game has to be able to matter: real MATCH scores sit well under an
// undefended simulation, and the four BUMPS/TRENCHES plus one HUB face make a single defender able
// to park itself in the way. Kept below the drive-speed and shoot-rate losses because a ROBOT that
// is merely being shadowed can still sweep FUEL off to the side.
const INTAKE_DEFENCE_LOSS = 0.45;

// Derived arena geometry (§5), mirrored about the CENTER LINE so both ALLIANCES face identical
// distances. X runs red ALLIANCE WALL (0) -> blue ALLIANCE WALL (651.2), Y across (0 -> 317.7).
export const GEO = (() => {
  const L = FIELD.lengthIn;
  const W = FIELD.widthIn;
  const shift = FIELD.hub.centerFromWallIn;
  const bandHalf = FIELD.bump.depthIn / 2;
  const yc = W / 2;
  const corridors = () => {
    const out = [];
    for (const dy of [-60, 60]) out.push({ kind: 'bump', y: yc + dy, half: FIELD.bump.widthIn / 2 });
    for (const y of [FIELD.trench.widthIn / 2, W - FIELD.trench.widthIn / 2]) {
      out.push({ kind: 'trench', y, half: FIELD.trench.widthIn / 2 });
    }
    return out;
  };
  return {
    L,
    W,
    yc,
    centerLineX: L / 2,
    hubExitZoneRadiusIn: 44,
    red: {
      allianceZone: [0, FIELD.allianceZoneDepthIn],
      band: [shift - bandHalf, shift + bandHalf],
      hub: { x: shift, y: yc },
      tower: { x: FIELD.tower.baseDepthIn / 2 + 4, y: yc },
      depot: { x: 13.5, y: 110, w: FIELD.depot.depthIn, h: FIELD.depot.widthIn },
      corral: { x: 40, y: 35, w: 36, h: 38 },
      feed: { x: 24, y: 35 },
      shoot: { x: 118, y: yc },
      corridors: corridors(),
    },
    blue: {
      allianceZone: [L - FIELD.allianceZoneDepthIn, L],
      band: [L - shift - bandHalf, L - shift + bandHalf],
      hub: { x: L - shift, y: yc },
      tower: { x: L - FIELD.tower.baseDepthIn / 2 - 4, y: yc },
      depot: { x: L - 13.5, y: W - 110, w: FIELD.depot.depthIn, h: FIELD.depot.widthIn },
      corral: { x: L - 40, y: W - 35, w: 36, h: 38 },
      feed: { x: L - 24, y: W - 35 },
      shoot: { x: L - 118, y: yc },
      corridors: corridors(),
    },
  };
})();

export function simulateMatch(opts) {
  const { redAlliance, blueAlliance, redPolicy, bluePolicy, scenario, record = false } = opts;
  const sc = scenario;
  const rng = makeRng((sc.seed >>> 0) ^ 0x9e3779b9);
  const tick = sc.chunkSec;
  const steps = Math.round(TIME.matchSec / tick);
  const decideEvery = Math.max(1, Math.round(0.2 / tick));
  const alliances = { red: redAlliance, blue: blueAlliance };
  const policies = { red: redPolicy, blue: bluePolicy };

  // ---- FUEL store: typed arrays. 504+ discrete FUEL objects updated per tick is the hot loop.
  const total = Math.max(FUEL.stagedTotal, sc.fuelTotal);
  const fx = new Float32Array(total);
  const fy = new Float32Array(total);
  const fvx = new Float32Array(total);
  const fvy = new Float32Array(total);
  const ftimer = new Float32Array(total);
  const fscore = new Uint8Array(total);
  const fstate = new Uint8Array(total); // 0 free, 1 chute, 2 corral, 3 held, 4 in flight
  const fholder = new Int16Array(total).fill(-1);
  const fshooter = new Int16Array(total).fill(-1);
  const fhub = new Uint8Array(total); // flight target: 1 red hub, 2 blue hub
  // Only FUEL that is airborne needs per-tick integration, so keep explicit work lists
  // instead of sweeping all 504+ FUEL every tick.
  const flights = new Set();
  const processing = new Set();

  const pools = { red: { depot: FUEL.perDepot, chute: FUEL.perChute, corral: 0 }, blue: { depot: FUEL.perDepot, chute: FUEL.perChute, corral: 0 } };

  let idx = 0;
  const depotJit = () => (rng() - 0.5) * 22;
  // Each DEPOT holds 24 FUEL resting on the carpet inside the DEPOT (§6.3.4-A).
  for (const side of ['red', 'blue']) {
    const d = GEO[side].depot;
    for (let k = 0; k < FUEL.perDepot; k++, idx++) {
      fstate[idx] = 0;
      fx[idx] = d.x + depotJit();
      fy[idx] = d.y + depotJit();
    }
  }
  // Each OUTPOST CHUTE starts with 24 FUEL staged off-FIELD (§6.3.4-B): only a HUMAN PLAYER
  // can enter them onto the FIELD (G425).
  for (const side of ['red', 'blue']) {
    const f = GEO[side].feed;
    for (let k = 0; k < FUEL.perChute; k++, idx++) {
      fstate[idx] = 1;
      fx[idx] = f.x;
      fy[idx] = f.y;
    }
  }

  const robots = [];
  for (const side of ['red', 'blue']) {
    alliances[side].robots.forEach((r, slot) => {
      robots.push({
        ...r,
        alliance: side,
        slot,
        idx: robots.length,
        x: side === 'red' ? 34 + slot * 26 : GEO.L - 34 - slot * 26,
        y: GEO.yc + (slot - 1) * 46,
        vx: 0,
        vy: 0,
        // Last real heading. A stopped ROBOT keeps facing where it was going, so the intake cone
        // stays defined while it is parked on a pile of FUEL.
        hx: side === 'red' ? 1 : -1,
        hy: 0,
        carrying: 0,
        intent: { mode: INTENT.IDLE },
        // `climb` merges the ROBOT's climb capabilities (l1/l2/l3, timeSec, attachTimeSec) with
        // this MATCH's runtime climb state.
        climb: { ...r.climb, level: 0, progress: 0, attaching: false, attachClock: 0, done: false, autoLevel: 0 },
        health: 1,
        disabled: false,
        defensePressure: 0,
        pinTimer: 0,
        g408Timer: 0,
        g408Instances: 0,
        g420Cooldown: 0,
        shootClock: 0,
        aimClock: 0,
        depositClock: 0,
        distance: 0,
        stat: {
          fuelCollected: 0,
          fuelScored: 0,
          fuelWasted: 0,
          fouls: 0,
          foulPointsGiven: 0,
          pins: 0,
          blockedByOpponentSec: 0,
          climbLevel: 0,
          climbPoints: 0,
          activeSec: 0,
          collectTicks: 0,
          intakeTicks: 0,
        },
      });
    });
  }
  // Preload (§6.3.4-C, capped by G303-I): each ROBOT may start supporting up to 8 FUEL.
  for (const rb of robots) {
    const pre = Math.min(FUEL.maxPreloadPerRobot, rb.capacity);
    rb.carrying = pre;
    for (let k = 0; k < pre && idx < total; k++, idx++) {
      fstate[idx] = 3;
      fholder[idx] = rb.idx;
    }
  }
  // Remaining FUEL starts in the NEUTRAL ZONE inside the §6.3.4.1 box straddling the CENTER LINE.
  const box = FUEL.neutralView;
  while (idx < total) {
    fstate[idx] = 0;
    fx[idx] = GEO.centerLineX + (rng() - 0.5) * box.depthIn;
    fy[idx] = GEO.yc + (rng() - 0.5) * box.widthIn;
    idx++;
  }

  if (sc.faultsEnabled) {
    for (const rb of robots) {
      if (rng() > rb.reliability) {
        rb.fault = { at: rng.range(25, TIME.matchSec - 25), hard: rng.chance(0.18), done: false };
      }
    }
  }

  const score = {
    red: { fuel: 0, fuelInactive: 0, towerAuto: 0, towerTeleop: 0, foulPoints: 0 },
    blue: { fuel: 0, fuelInactive: 0, towerAuto: 0, towerTeleop: 0, foulPoints: 0 },
  };
  const autoFuel = { red: 0, blue: 0 };
  const events = [];
  const timeline = [];
  let autoWinner = null;
  let hubSchedule = null;
  let period = 'AUTO';
  const blockState = { red: 0, blue: 0 };
  const feedAcc = { red: 0, blue: 0 };
  // §5.4: a HUB returns FUEL to the NEUTRAL ZONE through four exits, and that return path has a
  // finite throughput. It is what sets the tempo of the whole MATCH: the FIELD only holds 504 FUEL
  // (§6.3.4), so a HUB that recirculates instantly lets an ALLIANCE re-score the same FUEL over and
  // over with nothing to stop it. See hubExitRate in defaultScenario() for the calibration.
  const hubExitRate = sc.hubExitRate ?? defaultScenario().hubExitRate;
  const exitAcc = { red: 0, blue: 0 };

  const log = (t, kind, data) => {
    if (events.length < 3000) events.push({ t: +t.toFixed(2), kind, ...data });
  };
  const hubActive = (side, t) => {
    if (t < TIME.autoSec + TIME.transitionSec) return true;
    if (!hubSchedule) return true;
    const p = periodAt(t);
    const row = hubSchedule.find((r) => r.period === p);
    return row ? row[side] : true;
  };
  const awardFoul = (victimSide, points, reason, t, rb) => {
    score[other(victimSide)].foulPoints += points;
    log(t, 'foul', { against: victimSide, points, reason, robot: rb ? rb.idx : null });
    if (rb) {
      rb.stat.fouls += 1;
      rb.stat.foulPointsGiven += points;
    }
  };

  const usableCorridors = (side, rb) =>
    GEO[side].corridors.filter((c) => (c.kind === 'bump' ? rb.canBump : rb.canTrench));

  // A TOWER is 49.25 in wide with the UPRIGHTS 32.25 in apart (§5.8), so up to three ROBOTS
  // share the face. Giving each ROBOT its own lane keeps them from shoving each other off it
  // (and ALLIANCE partners may not support each other, G414).
  const climbSpotFor = (rb) => ({ x: GEO[rb.alliance].tower.x, y: GEO[rb.alliance].tower.y + (rb.slot - 1) * 17 });

  // Route movement through a legal corridor when a ROBOT has to cross the BUMP/TRENCH band.
  // The corridor choice is committed until the crossing is done: re-deciding it every tick makes
  // a ROBOT dither in Y whenever its goal moves, because candidate corridors sit far apart in Y.
  function navTarget(rb, tx, ty) {
    const band = GEO[rb.alliance].band;
    const outside = rb.x < band[0] || rb.x > band[1];
    const crossing = (rb.x < band[0] && tx > band[1]) || (rb.x > band[1] && tx < band[0]);
    if (!crossing) {
      rb.navCorridor = null;
      return { x: tx, y: ty };
    }
    const cors = usableCorridors(rb.alliance, rb);
    let best = null;
    if (rb.navCorridor != null) best = cors.find((c) => c.y === rb.navCorridor) || null;
    if (!best) {
      best = cors[0];
      let bestCost = Infinity;
      for (const c of cors) {
        const cost = Math.abs(rb.y - c.y) + 0.6 * Math.abs(ty - c.y) + (c.kind === 'trench' ? 0 : 5);
        if (cost < bestCost) {
          bestCost = cost;
          best = c;
        }
      }
      rb.navCorridor = best.y;
    }
    if (outside && Math.abs(rb.y - best.y) > 7) return { x: rb.x, y: best.y };
    if (outside) return { x: rb.x < band[0] ? band[1] + 4 : band[0] - 4, y: best.y };
    return { x: tx, y: ty };
  }

  const solids = [];
  for (const side of ['red', 'blue']) {
    const g = GEO[side];
    solids.push({ x: g.hub.x, y: g.hub.y, hw: FIELD.hub.sizeIn / 2, hh: FIELD.hub.sizeIn / 2 });
    solids.push({ x: g.tower.x, y: g.tower.y, hw: FIELD.tower.baseDepthIn / 2, hh: FIELD.tower.baseWidthIn / 2 });
    for (const c of g.corridors) {
      if (c.kind === 'bump') solids.push({ x: g.hub.x, y: c.y, hw: FIELD.bump.depthIn / 2, hh: c.half, bump: true });
    }
  }
  function obstacleResolve(rb) {
    for (const s of solids) {
      if (s.bump) continue; // a BUMP is driven over, not around (§5.5)
      const dx = rb.x - s.x;
      const dy = rb.y - s.y;
      const ox = s.hw + 12 - Math.abs(dx);
      const oy = s.hh + 12 - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (ox < oy) rb.x += Math.sign(dx || 1) * ox;
        else rb.y += Math.sign(dy || 1) * oy;
      }
    }
    rb.x = clamp(rb.x, 6, GEO.L - 6);
    rb.y = clamp(rb.y, 6, GEO.W - 6);
  }

  const cell = 40;
  const gw = Math.ceil(GEO.L / cell);
  const gh = Math.ceil(GEO.W / cell);
  let grid = new Array(gw * gh).fill(null);
  function rebuildGrid() {
    grid = new Array(gw * gh).fill(null);
    for (let i = 0; i < total; i++) {
      if (fstate[i] !== 0) continue;
      const cx = clamp(Math.floor(fx[i] / cell), 0, gw - 1);
      const cy = clamp(Math.floor(fy[i] / cell), 0, gh - 1);
      const k = cx * gh + cy;
      (grid[k] || (grid[k] = [])).push(i);
    }
  }
  function takeFuelNear(rb, radius, rate, dt, cosCone = -1) {
    // Accumulate fractionally so intakeRate is a true FUEL/s limit rather than 1 FUEL/tick.
    rb.intakeAcc = Math.min(2, (rb.intakeAcc || 0) + rate * dt);
    const budget = Math.floor(rb.intakeAcc);
    if (budget <= 0 || rb.carrying >= rb.capacity) return 0;
    const cap = Math.min(budget, rb.capacity - rb.carrying);
    const rc = clamp(Math.floor(rb.x / cell), 0, gw - 1);
    const ry = clamp(Math.floor(rb.y / cell), 0, gh - 1);
    let got = 0;
    for (let ax = rc - 1; ax <= rc + 1; ax++) {
      for (let ay = ry - 1; ay <= ry + 1; ay++) {
        if (ax < 0 || ay < 0 || ax >= gw || ay >= gh) continue;
        const bucket = grid[ax * gh + ay];
        if (!bucket) continue;
        for (const i of bucket) {
          if (fstate[i] !== 0) continue;
          const dx = fx[i] - rb.x;
          const dy = fy[i] - rb.y;
          if (dx * dx + dy * dy > radius * radius) continue;
          // An intake is a mouth at the front of the ROBOT, not a radial vacuum: FUEL has to pass
          // into the opening. cosCone is the cosine of the forward half-angle, so cosCone <= 0
          // keeps the old omnidirectional behaviour.
          if (cosCone > -1) {
            const d = Math.sqrt(dx * dx + dy * dy);
            // A roller intake is only about a ROBOT-width of mouth, so FUEL already in contact with
            // it is ingested whatever the ROBOT is facing. Without this a ROBOT that parks exactly
            // on a FUEL reads a zero-length bearing and can never pick it up again.
            if (d > 12 && (dx * rb.hx + dy * rb.hy) / d < cosCone) continue;
          }
          fstate[i] = 3;
          fholder[i] = rb.idx;
          rb.carrying += 1;
          got += 1;
          rb.stat.fuelCollected += 1;
          if (got >= cap) {
            rb.intakeAcc -= got;
            rebuildHint();
            return got;
          }
        }
      }
    }
    rb.intakeAcc -= got;
    if (got > 0) rebuildHint();
    return got;
  }

  // FUEL taken out of the grid leaves stale entries behind; flag for a rebuild when it matters.
  let gridDirty = 0;
  const rebuildHint = () => {
    gridDirty += 1;
  };

  function releaseShot(rb) {
    const hub = GEO[rb.alliance].hub;
    const dist = Math.hypot(rb.x - hub.x, rb.y - hub.y);
    let acc = rb.shootAccuracy - rb.accuracyFalloff * Math.max(0, dist - rb.refShootDistanceIn);
    // Defence suppresses a cycle far more than drive speed alone suggests: a bumper in your face
    // slows you down AND costs you shots, which is why real MATCH scores land well under an
    // undefended simulation.
    acc *= 1 - 0.5 * rb.defensePressure;
    acc = clamp(acc, 0.08, 0.99);
    for (let i = 0; i < total; i++) {
      if (fstate[i] === 3 && fholder[i] === rb.idx) {
        fstate[i] = 4;
        fholder[i] = -1;
        fshooter[i] = rb.idx;
        ftimer[i] = 0.55;
        fhub[i] = rb.alliance === 'red' ? 1 : 2;
        fscore[i] = rng() < acc ? 1 : 0;
        fvx[i] = (hub.x - rb.x) / 0.55;
        fvy[i] = (hub.y - rb.y) / 0.55;
        rb.carrying -= 1;
        flights.add(i);
        return i;
      }
    }
    return -1;
  }

  function resolveFlight(i, t) {
    flights.delete(i);
    const target = fhub[i] === 1 ? 'red' : 'blue';
    const hub = GEO[target].hub;
    const dir = target === 'red' ? 1 : -1;
    const rb = fshooter[i] >= 0 ? robots[fshooter[i]] : null;
    if (fscore[i]) {
      if (hubActive(target, t)) {
        score[target].fuel += POINTS.fuelActiveHub;
        if (t < TIME.autoSec + TIME.autoScoreGraceSec) autoFuel[target] += 1;
        if (rb) rb.stat.fuelScored += 1;
      } else {
        score[target].fuelInactive += 1;
        if (rb) rb.stat.fuelWasted += 1;
      }
      // A HUB processes FUEL and redistributes it into the NEUTRAL ZONE via its exits (§5.4),
      // which is why 504 FUEL circulate all MATCH instead of running out. Processing costs time
      // (§6.5 allows for FUEL processing time) and the FUEL is spread across the NEUTRAL ZONE, so
      // camping the exits is neither free nor fast.
      fstate[i] = 6;
      ftimer[i] = FIELD.hub.processingSec;
      fhub[i] = target === 'red' ? 1 : 2;
      processing.add(i);
    } else {
      fstate[i] = 0;
      fx[i] = clamp(hub.x + dir * rng.range(20, 95), 8, GEO.L - 8);
      fy[i] = clamp(hub.y + rng.range(-95, 95), 8, GEO.W - 8);
    }
  }

  function completeClimb(rb, t) {
    const want = Math.min(rb.intent.level || 1, rb.derived.maxClimbLevel);
    const p = periodAt(t);
    if (p === 'AUTO') {
      const l1 = robots.filter((r) => r.alliance === rb.alliance && r.climb.autoLevel >= 1).length;
      if (want >= 1 && l1 < 2) {
        rb.climb.autoLevel = 1;
        score[rb.alliance].towerAuto += POINTS.tower.l1Auto;
        rb.stat.climbLevel = 1;
        rb.stat.climbPoints += POINTS.tower.l1Auto;
        log(t, 'climb', { robot: rb.idx, level: 1, period: 'AUTO' });
      }
    } else {
      const level = Math.max(1, want);
      rb.climb.level = level;
      const pts =
        level === 1
          ? sc.towerL1TeleopAllowed
            ? POINTS.tower.l1Teleop
            : 0
          : level === 2
            ? POINTS.tower.l2Teleop
            : POINTS.tower.l3Teleop;
      score[rb.alliance].towerTeleop += pts;
      rb.stat.climbLevel = level;
      rb.stat.climbPoints += pts;
      log(t, 'climb', { robot: rb.idx, level, period: p });
    }
  }

  const makeObs = (t) => ({
    t,
    period,
    hub: { red: hubActive('red', t), blue: hubActive('blue', t) },
    // After AUTO the FMS relays the ALLIANCE-SHIFT HUB order to every OPERATOR CONSOLE (§6.4.1),
    // so a policy may legitimately plan against the remaining schedule.
    schedule: hubSchedule,
    autoFuel: { ...autoFuel },
    score,
    pools,
    robots,
    geo: GEO,
    fuel: { x: fx, y: fy, state: fstate, total },
    scenario: sc,
  });

  for (const side of ['red', 'blue']) {
    const pol = policies[side];
    if (pol.reset) pol.reset({ scenario: sc, alliance: alliances[side], geo: GEO, side });
    if (pol.onPeriodStart) pol.onPeriodStart('AUTO', makeObs(0));
  }

  for (let step = 0; step < steps; step++) {
    const t = step * tick;
    const p = periodAt(t);
    if (p !== period) {
      period = p;
      if (p === 'TRANSITION') {
        // A ROBOT that climbed in AUTO is eligible to climb again during TELEOP (§6.5.2), so the
        // TOWER runtime state is released here and the ROBOT rejoins play.
        for (const rb of robots) {
          if (rb.climb.autoLevel >= 1) {
            rb.climb.progress = 0;
            rb.climb.attaching = false;
            rb.climb.attachClock = 0;
            rb.climb.done = false;
            rb.climb.level = 0;
            rb.x = GEO[rb.alliance].allianceZone[1] - 55;
            rb.y = GEO.yc + (rb.slot - 1) * 40;
            rb.vx = 0;
            rb.vy = 0;
          }
        }
        // AUTO result sets the HUB order for the ALLIANCE SHIFTS (§6.4.1 / Table 6-3).
        autoWinner =
          sc.autoWinner === 'red' || sc.autoWinner === 'blue'
            ? sc.autoWinner
            : autoFuel.red === autoFuel.blue
              ? rng.chance(0.5)
                ? 'red'
                : 'blue'
              : autoFuel.red > autoFuel.blue
                ? 'red'
                : 'blue';
        hubSchedule = hubActiveTable(autoWinner);
        log(t, 'hubSchedule', { autoWinner, autoFuel: { ...autoFuel } });
      }
      for (const side of ['red', 'blue']) {
        if (policies[side].onPeriodStart) policies[side].onPeriodStart(p, makeObs(t));
      }
      log(t, 'period', { period: p });
    }

    if (step % 5 === 0 || gridDirty > 60) {
      rebuildGrid();
      gridDirty = 0;
    }

    for (const rb of robots) {
      if (rb.fault && !rb.fault.done && t >= rb.fault.at) {
        rb.fault.done = true;
        rb.health = rb.fault.hard ? 0 : 0.55;
        if (rb.fault.hard) rb.disabled = true;
        log(t, 'fault', { robot: rb.idx, hard: rb.fault.hard });
      }
    }

    if (step % decideEvery === 0) {
      for (const side of ['red', 'blue']) {
        const obs = makeObs(t);
        for (const rb of robots) {
          if (rb.alliance !== side || rb.disabled) continue;
          rb.intent = policies[side].decide(rb, obs) || { mode: INTENT.IDLE };
        }
      }
    }

    for (const rb of robots) rb.defensePressure = 0;

    // ---- DEFEND: denial pressure and PIN adjudication (G418) ----
    for (const rb of robots) {
      if (rb.disabled) continue;
      if (rb.g420Cooldown > 0) rb.g420Cooldown -= tick;
      if (rb.intent.mode !== INTENT.DEFEND) {
        rb.pinTimer = Math.max(0, rb.pinTimer - tick * 3);
        continue;
      }
      const tgt = robots[rb.intent.targetRobot];
      if (!tgt || tgt.alliance === rb.alliance || tgt.disabled) continue;
      const d = Math.hypot(rb.x - tgt.x, rb.y - tgt.y);
      if (d >= 34) {
        rb.pinTimer = Math.max(0, rb.pinTimer - tick * 3);
        continue;
      }
      const pressure = clamp(rb.defenseSkill * 0.55 + rb.defensePower * 0.55, 0, 1);
      tgt.defensePressure = Math.max(tgt.defensePressure, pressure);
      tgt.stat.blockedByOpponentSec += tick;
      const zone = GEO[tgt.alliance].allianceZone;
      const insideOwnZone = tgt.x >= zone[0] && tgt.x <= zone[1];
      const speed = Math.hypot(tgt.vx, tgt.vy);
      if (speed < 12 && !insideOwnZone) {
        const prev = rb.pinTimer;
        rb.pinTimer += tick;
        if (prev <= 3 && rb.pinTimer > 3) {
          awardFoul(tgt.alliance, POINTS.foul.minor, 'G418 PIN over 3 s', t, rb);
          rb.stat.pins += 1;
        } else if (rb.pinTimer > 3 && Math.floor((rb.pinTimer - 3) / 3) > Math.floor((prev - 3) / 3)) {
          awardFoul(tgt.alliance, POINTS.foul.major, 'G418 PIN not corrected', t, rb);
          rb.stat.pins += 1;
        }
      } else {
        rb.pinTimer = Math.max(0, rb.pinTimer - tick * 2);
      }
    }

    // ---- G419: two or more ROBOTS isolating traversal (blocking both BUMPS and both TRENCHES)
    for (const side of ['red', 'blue']) {
      const g = GEO[side];
      const opp = other(side);
      const bumpY = new Set();
      const trenchY = new Set();
      let inBandCount = 0;
      let oppFree = 0;
      for (const r of robots) {
        if (r.disabled) continue;
        if (r.alliance === opp) {
          if (r.x < g.band[0] || r.x > g.band[1]) oppFree += 1;
          continue;
        }
        if (r.x < g.band[0] || r.x > g.band[1]) continue;
        inBandCount += 1;
        for (const c of g.corridors) {
          if (Math.abs(r.y - c.y) < c.half + 8) (c.kind === 'bump' ? bumpY : trenchY).add(c.y);
        }
      }
      const isolates = bumpY.size + trenchY.size >= 4 && oppFree === 0 && inBandCount >= 2;
      if (isolates) {
        const prev = blockState[side];
        blockState[side] += tick;
        if (prev <= 3 && blockState[side] > 3) awardFoul(opp, POINTS.foul.major, 'G419 isolating traversal routes', t, null);
        else if (blockState[side] > 3 && Math.floor((blockState[side] - 3) / 3) > Math.floor((prev - 3) / 3)) {
          awardFoul(opp, POINTS.foul.major, 'G419 continued isolation', t, null);
        }
      } else blockState[side] = Math.max(0, blockState[side] - tick * 2);
    }

    const towerProtected = t > TIME.matchSec - TIME.endgameSec;

    for (const rb of robots) {
      if (rb.disabled) continue;
      const intent = rb.intent;
      const g = GEO[rb.alliance];

      let tx = rb.x;
      let ty = rb.y;
      switch (intent.mode) {
        case INTENT.COLLECT:
        case INTENT.STOCKPILE:
          if (intent.target) {
            tx = intent.target.x;
            ty = intent.target.y;
          }
          break;
        case INTENT.SCORE:
          // A turret may nominate its own firing point inside the ALLIANCE ZONE; a full-width
          // shooter is driven to the HUB face because that is the only place it can shoot from.
          tx = intent.target ? intent.target.x : g.shoot.x;
          ty = intent.target ? intent.target.y : g.shoot.y;
          break;
        case INTENT.DEFEND: {
          const tgt = robots[intent.targetRobot];
          if (tgt) {
            tx = tgt.x + tgt.vx * 0.45;
            ty = tgt.y + tgt.vy * 0.45;
          }
          break;
        }
        case INTENT.CLIMB: {
          tx = climbSpotFor(rb).x;
          ty = climbSpotFor(rb).y;
          break;
        }
        case INTENT.FEED:
          tx = g.corral.x;
          ty = g.corral.y;
          break;
        default:
          if (intent.target) {
            tx = intent.target.x;
            ty = intent.target.y;
          }
      }

      const wp = navTarget(rb, tx, ty);
      const dx = wp.x - rb.x;
      const dy = wp.y - rb.y;
      const dist = Math.hypot(dx, dy) || 1;
      let maxSpeed = rb.driveSpeedIps * (rb.health === 0 ? 0 : rb.health) * (1 - 0.7 * rb.defensePressure);
      if (intent.mode === INTENT.CLIMB && dist < 30) maxSpeed *= 0.45;
      if (!rb.canTrench && Math.abs(rb.x - g.band[0]) < FIELD.bump.depthIn + 10) maxSpeed *= 0.72;
      // Closed-loop position control: ROBOTS decelerate into a waypoint instead of overshooting it
      // at full speed, otherwise they oscillate around their goal and never settle.
      const desired = Math.min(maxSpeed, dist * 4.5);
      const maxDelta = rb.accelIps2 * tick;
      rb.vx += clamp((dx / dist) * desired - rb.vx, -maxDelta, maxDelta);
      rb.vy += clamp((dy / dist) * desired - rb.vy, -maxDelta, maxDelta);
      const px = rb.x;
      const py = rb.y;
      rb.x += rb.vx * tick;
      rb.y += rb.vy * tick;
      rb.distance += Math.hypot(rb.x - px, rb.y - py);
      obstacleResolve(rb);

      for (const o of robots) {
        if (o === rb || o.disabled) continue;
        const d = Math.hypot(o.x - rb.x, o.y - rb.y);
        if (d >= 28) continue;
        // A ROBOT anchored to the TOWER is not shoved around, and ALLIANCE partners may not
        // support each other to climb (G414).
        const anchored = (r) => r.climb.attaching || r.climb.progress > 0 || r.climb.done;
        if (anchored(rb) || anchored(o)) continue;
        const push = ((28 - d) / 2) * 0.55;
        const ux = (rb.x - o.x) / (d || 1);
        const uy = (rb.y - o.y) / (d || 1);
        const w = rb.weightLb / (rb.weightLb + o.weightLb);
        rb.x += ux * push * w;
        rb.y += uy * push * w;
        o.x -= ux * push * (1 - w);
        o.y -= uy * push * (1 - w);
      }

      // ---- G420 TOWER protection (last 30 s of the MATCH) ----
      if (towerProtected && rb.g420Cooldown <= 0) {
        for (const o of robots) {
          if (o.alliance === rb.alliance || o.disabled) continue;
          const og = GEO[o.alliance];
          if (Math.hypot(o.x - og.tower.x, o.y - og.tower.y) < 42 && Math.hypot(o.x - rb.x, o.y - rb.y) < 30) {
            awardFoul(rb.alliance, POINTS.foul.major, 'G420 TOWER protection contact', t, rb);
            rb.g420Cooldown = 6;
            if (o.climb.level < 3) {
              score[o.alliance].towerTeleop += POINTS.tower.l3Teleop;
              o.climb.level = 3;
              log(t, 'towerAwarded', { robot: o.idx, reason: 'G420' });
            }
            break;
          }
        }
      }

      // Heading for the directional intake. A ROBOT that is actually driving faces its velocity;
      // once it settles onto a pile it keeps the heading it arrived with, which is exactly where a
      // front-mounted intake is pointing.
      {
        const sp = Math.hypot(rb.vx, rb.vy);
        if (sp > 18) {
          rb.hx = rb.vx / sp;
          rb.hy = rb.vy / sp;
        }
      }

      // ---- actions ----
      switch (intent.mode) {
        case INTENT.COLLECT:
        case INTENT.STOCKPILE: {
          rb.stat.collectTicks += 1;
          // A roller intake cannot swallow FUEL at a full sprint — teams slow down to sweep — so the
          // usable rate falls off with ground speed instead of being the same at a crawl and at
          // 14 ft/s. This is the single biggest gap between a 1-D kinematic cycle and a real one.
          const sweep = 1 - 0.6 * clamp((Math.hypot(rb.vx, rb.vy) - 55) / 90, 0, 1);
          // Defence has to touch the intake as well, or it accomplishes nothing: an opponent with
          // its BUMPERS in your intake mouth stops you sweeping FUEL at all. Drive speed, shoot rate
          // and accuracy are already scaled by defencePressure; leaving intake untouched made
          // defending strictly self-harming (measure: 1 defender cost 200 own points and did not
          // reduce the opponent's score at all).
          const press = 1 - INTAKE_DEFENCE_LOSS * rb.defensePressure;
          if (takeFuelNear(rb, 14, rb.intakeRate * (rb.health || 0) * sweep * press, tick, 0.6) > 0) rb.stat.intakeTicks += 1;
          // G408: FUEL released by a HUB may not be caught or redirected beyond MOMENTARY CONTROL.
          let nearExit = false;
          for (const side of ['red', 'blue']) {
            const h = GEO[side].hub;
            const ex = h.x + (side === 'red' ? FIELD.hub.sizeIn / 2 : -FIELD.hub.sizeIn / 2);
            if (Math.hypot(rb.x - ex, rb.y - h.y) < GEO.hubExitZoneRadiusIn) nearExit = true;
          }
          if (nearExit && rb.carrying < rb.capacity) {
            const prev = rb.g408Timer;
            rb.g408Timer += tick;
            if (prev <= 3 && rb.g408Timer > 3) {
              awardFoul(rb.alliance, POINTS.foul.minor, 'G408 catching FUEL at a HUB exit', t, rb);
              rb.g408Instances += 1;
            } else if (rb.g408Timer > 6 && Math.floor((rb.g408Timer - 6) / 3) > Math.floor((prev - 6) / 3)) {
              awardFoul(rb.alliance, POINTS.foul.major, 'G408 strategic FUEL catching', t, rb);
              rb.g408Instances += 1;
            }
          } else rb.g408Timer = Math.max(0, rb.g408Timer - tick * 1.5);
          break;
        }
        case INTENT.SCORE: {
          const inZone = rb.x >= g.allianceZone[0] && rb.x <= g.allianceZone[1];
          // G407: FUEL may only be launched at your own HUB with BUMPERS at least partly inside
          // your ALLIANCE ZONE, so the engine only produces shots from inside the zone. On top of
          // that, a full-width shooter has to be lined up at the HUB face, while a turret tracks
          // the HUB and can fire from anywhere in the zone — that is the whole point of the turret.
          const aligned = rb.mechanism === 'turret' || Math.hypot(rb.x - g.shoot.x, rb.y - g.shoot.y) < 46;
          // Aiming cost a kinematic cycle model ignores: a full-width shooter has to line up and
          // settle at the HUB face before its load goes out, while a turret only has to slew.
          const aimSec = rb.mechanism === 'turret' ? 0.15 : 0.7;
          if (inZone && aligned && rb.carrying > 0) {
            rb.aimClock = (rb.aimClock || 0) + tick;
            if (rb.aimClock < aimSec) break;
            rb.shootClock += tick;
            const interval = 1 / Math.max(0.4, rb.shootRate * (rb.health || 0) * (1 - 0.5 * rb.defensePressure));
            while (rb.shootClock >= interval && rb.carrying > 0) {
              rb.shootClock -= interval;
              releaseShot(rb);
            }
          } else {
            rb.shootClock = 0;
            rb.aimClock = 0;
          }
          break;
        }
        case INTENT.FEED: {
          const c = g.corral;
          const inside = Math.abs(rb.x - c.x) < c.w / 2 + 16 && Math.abs(rb.y - c.y) < c.h / 2 + 16;
          if (inside && rb.carrying > 0) {
            rb.depositClock += tick;
            const interval = 1 / Math.max(0.4, rb.intakeRate * 0.7);
            while (rb.depositClock >= interval && rb.carrying > 0) {
              rb.depositClock -= interval;
              if (pools[rb.alliance].corral + pools[rb.alliance].chute >= FUEL.chuteCapacity + 30) {
                awardFoul(rb.alliance, POINTS.foul.minor, 'G427 off-FIELD FUEL store overfilled', t, rb);
                break;
              }
              for (let i = 0; i < total; i++) {
                if (fstate[i] === 3 && fholder[i] === rb.idx) {
                  fstate[i] = 2;
                  fholder[i] = -1;
                  pools[rb.alliance].corral += 1;
                  rb.carrying -= 1;
                  break;
                }
              }
            }
          }
          break;
        }
        case INTENT.CLIMB: {
          const spot = climbSpotFor(rb);
          if (Math.hypot(rb.x - spot.x, rb.y - spot.y) < 44) {
            if (!rb.climb.attaching) {
              rb.climb.attaching = true;
              rb.climb.attachClock = 0;
            }
            rb.climb.attachClock += tick;
            if (rb.climb.attachClock >= rb.climb.attachTimeSec) {
              rb.climb.progress = Math.min(1, rb.climb.progress + tick / Math.max(2, rb.climb.timeSec));
              if (rb.climb.progress >= 1 && !rb.climb.done) {
                rb.climb.done = true;
                completeClimb(rb, t);
              }
            }
          } else {
            rb.climb.attaching = false;
            rb.climb.attachClock = 0;
          }
          break;
        }
        default:
          // Opportunistic "bulldozing" pick-up on the way somewhere (G408 blue box exempts
          // inadvertent contact from being CONTROL). A climbing or defending ROBOT is not intaking.
          if (
            rb.carrying < rb.capacity &&
            Math.hypot(rb.vx, rb.vy) > 30 &&
            !rb.climb.attaching &&
            intent.mode !== INTENT.DEFEND &&
            intent.mode !== INTENT.CLIMB
          ) {
            takeFuelNear(rb, 14, rb.intakeRate * 0.35, tick, 0.5);
          }
      }
      rb.stat.activeSec += tick;
    }

    // ---- HUMAN PLAYER feeding from CHUTE / CORRAL onto the FIELD (G425, G427) ----
    for (const side of ['red', 'blue']) {
      const g = GEO[side];
      const pool = pools[side];
      feedAcc[side] += sc.humanFeedRate * tick;
      while (feedAcc[side] >= 1 && (pool.chute > 0 || pool.corral > 0)) {
        feedAcc[side] -= 1;
        const from = pool.chute > 0 ? 1 : 2;
        pool[from === 1 ? 'chute' : 'corral'] -= 1;
        for (let i = 0; i < total; i++) {
          if (fstate[i] === from) {
            fstate[i] = 0;
            fx[i] = g.feed.x + rng.range(-6, 6);
            fy[i] = clamp(g.feed.y + rng.range(-16, 16), 8, GEO.W - 8);
            break;
          }
        }
      }
    }

    // ---- flight resolution, including the 3 s assessment grace (§6.5-A/B) ----
    for (const i of flights) {
      ftimer[i] -= tick;
      fx[i] += fvx[i] * tick;
      fy[i] += fvy[i] * tick;
      if (ftimer[i] <= 0) resolveFlight(i, t);
    }
    // ---- HUB processing: scored FUEL reappears in the NEUTRAL ZONE (§5.4) ----
    for (const side of ['red', 'blue']) exitAcc[side] = Math.min(2, exitAcc[side] + hubExitRate * tick);
    for (const i of processing) {
      ftimer[i] -= tick;
      if (ftimer[i] > 0) continue;
      const target = fhub[i] === 1 ? 'red' : 'blue';
      // The exit rate, not the point award, is the real ceiling on a MATCH: FUEL that cannot get
      // back onto the FIELD yet stays inside the HUB, which is what starves a cycle late in a game.
      if (exitAcc[target] < 1) continue;
      exitAcc[target] -= 1;
      const hub = GEO[target].hub;
      const dir = target === 'red' ? 1 : -1;
      fstate[i] = 0;
      fx[i] = clamp(hub.x + dir * (FIELD.hub.sizeIn / 2 + rng.range(15, 165)), 8, GEO.L - 8);
      fy[i] = clamp(hub.y + rng.range(-150, 150), 8, GEO.W - 8);
      processing.delete(i);
    }

    if (record && step % 5 === 0) {
      timeline.push({
        t: +t.toFixed(2),
        p: period,
        hub: { red: hubActive('red', t), blue: hubActive('blue', t) },
        fuel: sampleFuel(),
        r: robots.map((r) => ({
          i: r.idx,
          a: r.alliance,
          x: +r.x.toFixed(1),
          y: +r.y.toFixed(1),
          c: r.carrying,
          m: r.intent.mode,
          k: r.climb.level,
          d: r.disabled ? 1 : 0,
        })),
        s: {
          red: totals('red'),
          blue: totals('blue'),
        },
      });
    }
  }

  // §6.5-B/D: assessment of FUEL and TELEOP TOWER points continues for up to 3 s after the
  // ARENA timer shows 0:00, so flights still airborne at 0:00 are drained here.
  for (let i = 0; i < total; i++) if (fstate[i] === 4) resolveFlight(i, TIME.matchSec);

  // The sampling stride above can leave the last frame short of the whistle, and the drain just
  // added points after it. Pin a final frame at the whistle so the replay ends on the real score.
  if (record) {
    timeline.push({
      t: TIME.matchSec,
      p: period,
      hub: { red: hubActive('red', TIME.matchSec), blue: hubActive('blue', TIME.matchSec) },
      fuel: sampleFuel(),
      r: robots.map((r) => ({
        i: r.idx,
        a: r.alliance,
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        c: r.carrying,
        m: r.intent.mode,
        k: r.climb.level,
        d: r.disabled ? 1 : 0,
      })),
      s: {
        red: totals('red'),
        blue: totals('blue'),
      },
    });
  }

  function totals(side) {
    const s = score[side];
    return {
      fuel: s.fuel,
      tower: s.towerAuto + s.towerTeleop,
      fouls: s.foulPoints,
      total: s.fuel + s.towerAuto + s.towerTeleop + s.foulPoints,
    };
  }
  function sampleFuel() {
    const pts = [];
    for (let i = 0; i < total; i += 4) if (fstate[i] === 0) pts.push([fx[i] | 0, fy[i] | 0]);
    return pts;
  }

  const result = {
    final: {},
    autoFuel: { ...autoFuel },
    autoWinner,
    hubSchedule,
    events,
    timeline: record ? timeline : null,
    scenario: sc,
    robotStats: robots.map((r) => ({
      idx: r.idx,
      alliance: r.alliance,
      team: r.team,
      name: r.name,
      ...r.stat,
      distanceIn: Math.round(r.distance),
      health: r.health,
      pins: r.pins || r.stat.pins,
    })),
  };
  for (const side of ['red', 'blue']) {
    const s = score[side];
    result.final[side] = {
      fuel: s.fuel,
      fuelInactive: s.fuelInactive,
      towerAuto: s.towerAuto,
      towerTeleop: s.towerTeleop,
      towerTotal: s.towerAuto + s.towerTeleop,
      foulPoints: s.foulPoints,
      total: totals(side).total,
    };
  }
  const th = POINTS.rpThreshold;
  for (const side of ['red', 'blue']) {
    const f = result.final[side];
    const energizedReq = sc.event === 'districtChamp' ? th.energized.districtChamp : th.energized.regional;
    const rp = {
      energized: f.fuel >= energizedReq ? 1 : 0,
      supercharged: f.fuel >= th.supercharged.regional ? 1 : 0,
      traversal: f.towerTotal >= th.traversal.regional ? 1 : 0,
      thresholds: { energized: energizedReq, supercharged: th.supercharged.regional, traversal: th.traversal.regional },
      result: 0,
    };
    const opp = result.final[other(side)].total;
    if (f.total === opp) rp.result = POINTS.rp.tie;
    else if (f.total > opp) rp.result = POINTS.rp.win;
    rp.total = rp.energized + rp.supercharged + rp.traversal + rp.result;
    f.rp = rp;
  }
  const redTotal = result.final.red.total;
  const blueTotal = result.final.blue.total;
  result.winner = redTotal === blueTotal ? 'tie' : redTotal > blueTotal ? 'red' : 'blue';
  return result;
}
