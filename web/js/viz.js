// Top-down FIELD renderer. Geometry comes straight from GEO (§5) so the picture and the
// simulation can never drift apart.

import { FIELD } from './rules.js';
import { GEO } from './engine.js';
import { INTAKE_SIDE_OF } from './model.js';

const COLORS = {
  red: '#e0413f',
  blue: '#2f7de1',
  carpet: '#1b2330',
  carpetAlt: '#212b3a',
  structure: '#39465c',
  structureLight: '#4b5b76',
  fuel: '#f0d264',
  text: '#dfe7f3',
  dim: '#8ea0bb',
  offField: '#0d1218',
};

// The OUTPOST sits outside the ALLIANCE WALL, and the HUMAN PLAYER works from it, so the view is
// wider than the FIELD by this much on each end (§5.9.2: the OUTPOST AREA is a 71 x 134 in volume).
// Everything in engine coordinates still runs 0..GEO.L across the carpet; only the pixels shift.
const PAD_IN = 34;
const VIEW_L = GEO.L + 2 * PAD_IN;

// Two letters, not one: a single letter made COLLECT and CLIMB both "C", and PASS and PUSH both "P",
// which is exactly the pair a tactical replay needs to tell apart.
const INTENT_GLYPH = {
  COLLECT: 'Co',
  STOCKPILE: 'St',
  SCORE: 'Sc',
  PASS: 'Pa',
  PUSH: 'Pu',
  DEFEND: 'Df',
  CLIMB: 'Cl',
  FEED: 'Fd',
};

// All three ROBOTs of an ALLIANCE are the same colour: that is the tactically important fact on a
// FIELD, and the DRIVER STATION is read off the team number drawn over each ROBOT instead.

function fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

// The same path without the fill, so a ROBOT body can be filled and then stroked along one outline
// instead of tracing it twice and letting the two disagree about the corner radius.
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export class FieldView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.labels = true;
    this.focus = new Set();
    this.resize();
  }

  // The renderer only carries what the recording carries, and a recording is per-ROBOT position —
  // the team number is roster state, so the app hands it over here instead of bloating every frame.
  setRoster(rosters) {
    this.rosters = rosters;
  }

  // Two presentation options the panel owns. `labels` is the team plate over each ROBOT (off is for a
  // clean read of FUEL flow), and `focus` is a set of ROBOT indices to watch — everything else is
  // dimmed, which is what makes one or two cars followable in a six-ROBOT scrum.
  setLabels(on) {
    this.labels = !!on;
  }

  setFocus(set) {
    this.focus = set;
  }

  resize(box) {
    // Measure the PANEL, not the canvas: resize() writes an inline pixel width, so the canvas's own
    // clientWidth would report the previous fit and the FIELD could never grow back.
    const host = this.canvas.parentElement;
    let availW = host && host.clientWidth ? host.clientWidth - 34 : 0;
    if (!availW) availW = this.canvas.clientWidth;
    if (!availW || availW < 120) availW = 900;
    // A `box` is how the FULLSCREEN / cinema layouts ask for the FIELD to fit a definite area: the
    // canvas is letterboxed inside it, keeping the FIELD's aspect instead of deriving height from
    // width. Without a box this is the old document-flow behaviour (height follows width).
    const availH = box && box.h ? Math.min(box.h, availW * (GEO.W / VIEW_L)) : Math.round((availW * GEO.W) / VIEW_L);
    const limitW = box && box.w ? Math.min(availW, box.w) : availW;
    const scale = Math.min(limitW / VIEW_L, availH / GEO.W);
    const cssW = Math.max(120, Math.round(VIEW_L * scale));
    const cssH = Math.round(GEO.W * scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.scale = cssW / VIEW_L;
    this.offsetX = PAD_IN * this.scale;
    this.offsetY = 0;
  }

  px(x) {
    return this.offsetX + x * this.scale;
  }

  py(y) {
    return this.offsetY + y * this.scale;
  }

  drawStatic(ctx) {
    const s = this.scale;
    const W = this.canvas.clientWidth;
    const H = W * (GEO.W / VIEW_L);
    // Off-field first: the two ALLIANCE WALLs do not close the picture, because the OUTPOST and the
    // HUMAN PLAYER working it sit behind them (§5.9.2).
    ctx.fillStyle = COLORS.offField;
    ctx.fillRect(0, 0, W, H);
    const frect = (x, y, w, h, fill) => {
      ctx.fillStyle = fill;
      ctx.fillRect(this.px(x), this.py(y), w * s, h * s);
    };
    frect(0, 0, GEO.L, GEO.W, COLORS.carpet);

    // NEUTRAL ZONE band
    frect(GEO.red.band[1], 0, GEO.blue.band[0] - GEO.red.band[1], GEO.W, COLORS.carpetAlt);

    // ALLIANCE ZONES
    frect(0, 0, GEO.red.allianceZone[1], GEO.W, 'rgba(224,65,63,0.09)');
    frect(GEO.blue.allianceZone[0], 0, GEO.L - GEO.blue.allianceZone[0], GEO.W, 'rgba(47,125,225,0.09)');

    // The OUTPOST footprint in each off-field strip: a 71 in wide volume at the guardrail corner
    // (§5.9.2), with the CHUTE running from the ALLIANCE WALL out to where the HP stands.
    for (const side of ['red', 'blue']) {
      const g = GEO[side];
      const x0 = side === 'red' ? -PAD_IN : GEO.L;
      const y0 = side === 'red' ? 0 : GEO.W - 71;
      frect(x0, y0, PAD_IN, 71, side === 'red' ? 'rgba(224,65,63,0.14)' : 'rgba(47,125,225,0.14)');
      ctx.strokeStyle = 'rgba(223,231,243,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.px(x0) + 0.5, this.py(y0) + 0.5, PAD_IN * s - 1, 71 * s - 1);
    }

    // guardrails + ALLIANCE WALLS
    ctx.strokeStyle = COLORS.structureLight;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.px(0) + 0.5, this.py(0) + 0.5, GEO.L * s - 1, GEO.W * s - 1);
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(this.px(0), 0, 3 * s, H);
    ctx.fillStyle = COLORS.blue;
    ctx.fillRect(this.px(GEO.L) - 3 * s, 0, 3 * s, H);

    const rect = (x, y, w, h, fill, stroke) => {
      ctx.fillStyle = fill;
      ctx.fillRect(this.px(x - w / 2), this.py(y - h / 2), w * s, h * s);
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(this.px(x - w / 2), this.py(y - h / 2), w * s, h * s);
      }
    };

    // BUMPS (§5.5): 73 x 44.4 in
    for (const side of ['red', 'blue']) {
      const g = GEO[side];
      ctx.fillStyle = side === 'red' ? 'rgba(224,65,63,0.5)' : 'rgba(47,125,225,0.5)';
      for (const c of g.corridors) {
        if (c.kind !== 'bump') continue;
        rect(g.hub.x, c.y, FIELD.bump.depthIn, FIELD.bump.widthIn, side === 'red' ? 'rgba(224,65,63,0.45)' : 'rgba(47,125,225,0.45)', COLORS.structureLight);
      }
    }
    // TRENCHES (§5.6)
    for (const side of ['red', 'blue']) {
      const g = GEO[side];
      for (const c of g.corridors) {
        if (c.kind !== 'trench') continue;
        const x0 = side === 'red' ? GEO.red.band[0] : GEO.blue.band[0];
        rect(x0 + FIELD.trench.depthIn / 2, c.y, FIELD.trench.depthIn, FIELD.trench.widthIn, 'rgba(120,140,170,0.35)', COLORS.structureLight);
      }
    }
    // DEPOTS (§5.7)
    for (const side of ['red', 'blue']) {
      const d = GEO[side].depot;
      rect(d.x, d.y, d.w, d.h, 'rgba(240,210,100,0.14)', COLORS.structureLight);
    }
    // OUTPOST / CORRAL (§5.9.2)
    for (const side of ['red', 'blue']) {
      const c = GEO[side].corral;
      rect(c.x, c.y, c.w, c.h, 'rgba(160,190,220,0.16)', COLORS.structureLight);
    }
    // TOWER bases (§5.8)
    for (const side of ['red', 'blue']) {
      const t = GEO[side].tower;
      rect(t.x, t.y, FIELD.tower.baseDepthIn, FIELD.tower.baseWidthIn, side === 'red' ? 'rgba(224,65,63,0.3)' : 'rgba(47,125,225,0.3)', COLORS.structureLight);
    }

    // CENTER LINE and zone lines
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(223,231,243,0.5)';
    ctx.beginPath();
    ctx.moveTo(this.px(GEO.centerLineX), 0);
    ctx.lineTo(this.px(GEO.centerLineX), H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(223,231,243,0.25)';
    ctx.beginPath();
    ctx.moveTo(this.px(GEO.red.allianceZone[1]), 0);
    ctx.lineTo(this.px(GEO.red.allianceZone[1]), H);
    ctx.moveTo(this.px(GEO.blue.allianceZone[0]), 0);
    ctx.lineTo(this.px(GEO.blue.allianceZone[0]), H);
    ctx.stroke();

    // HUBs (§5.4) with active/inactive state
    for (const side of ['red', 'blue']) {
      const h = GEO[side].hub;
      rect(h.x, h.y, FIELD.hub.sizeIn, FIELD.hub.sizeIn, side === 'red' ? 'rgba(224,65,63,0.35)' : 'rgba(47,125,225,0.35)', COLORS.structureLight);
    }
  }

  drawFrame(frame, meta) {
    const ctx = this.ctx;
    const s = this.scale;
    const W = this.canvas.clientWidth;
    const H = W * (GEO.W / VIEW_L);
    this.drawStatic(ctx);

    // HUB active state (Table 6-3)
    for (const side of ['red', 'blue']) {
      const h = GEO[side].hub;
      const active = frame ? frame.hub[side] : true;
      ctx.beginPath();
      ctx.arc(this.px(h.x), this.py(h.y), FIELD.hub.openingHexIn * 0.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = active ? (side === 'red' ? 'rgba(224,65,63,0.85)' : 'rgba(47,125,225,0.85)') : 'rgba(90,100,120,0.5)';
      ctx.fill();
      ctx.font = `${Math.round(9 * Math.max(1, s))}px ui-monospace, monospace`;
      ctx.fillStyle = active ? '#fff' : COLORS.dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(active ? 'ACTIVE' : 'OFF', this.px(h.x), this.py(h.y));
    }

    // FUEL
    if (frame && frame.fuel) {
      const r = Math.max(1.6, 2.6 * s);
      // A ball in flight carries [i, x, y, 4, aim, timerLeft, shooterIdx]. The stream is drawn per
      // shooter rather than per ball: sorted by how much flight is left, the balls line up oldest
      // first, which is the order they left the mechanism, so one stroke through them IS the path the
      // shooter traced while it was firing. Standing still, every ball is on the same line to the HUB
      // and the stroke is straight; firing on the move, the stroke bows through the positions the
      // shooter had already left. One line per shooter instead of one dashed ray per ball is also
      // what keeps a 13 BPS turret readable — thirteen rays from one car is just a yellow blob.
      const streams = new Map();
      for (const f of frame.fuel) {
        if (f[3] !== 4) continue;
        // HUMAN PLAYER throws have no shooter ROBOT (index -1), so they are keyed off the HUB they are
        // aimed at and stay one stream of their own instead of merging into a car's.
        const key = f[6] >= 0 ? f[6] : -1 - f[4];
        if (!streams.has(key)) streams.set(key, []);
        streams.get(key).push(f);
      }
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const balls of streams.values()) {
        if (balls.length < 2) continue;
        balls.sort((p, q) => (p[5] || 0) - (q[5] || 0));
        ctx.strokeStyle = 'rgba(255, 217, 74, 0.42)';
        ctx.lineWidth = Math.max(1, 1.4 * s);
        ctx.beginPath();
        ctx.moveTo(this.px(balls[0][1]), this.py(balls[0][2]));
        for (let k = 1; k < balls.length; k++) ctx.lineTo(this.px(balls[k][1]), this.py(balls[k][2]));
        ctx.stroke();
      }
      ctx.restore();
      for (const f of frame.fuel) {
        const x = f[1];
        const y = f[2];
        const cx = this.px(x);
        const cy = this.py(y);
        if (f[3] === 4) {
          ctx.fillStyle = 'rgba(255, 217, 74, 0.22)';
          ctx.beginPath();
          ctx.arc(cx, cy, r * 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff6cf';
          ctx.beginPath();
          ctx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.fillStyle = COLORS.fuel;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // HUMAN PLAYERs: one per ALLIANCE, standing at its OUTPOST behind the ALLIANCE WALL. The CHUTE
    // DOOR is drawn on its pivot so the replay shows the two plays apart — a door held shut while the
    // HP throws at the HUB (§6.1), or swung ~90° to send the CHUTE's 24 FUEL down onto the FIELD
    // (§5.9.2, G425-A). The ring lights on any action that is not HOLD. Drawn as a head over a
    // shoulder bar, never as a seventh car: it is not on the FIELD and no ROBOT can touch it (G421).
    for (const side of ['red', 'blue']) {
      const g = GEO[side];
      const hp = frame && frame.hp ? frame.hp[side] : null;
      const col = side === 'red' ? COLORS.red : COLORS.blue;
      const dir = side === 'red' ? 1 : -1;
      const hx = this.px(g.human.x);
      const hy = this.py(g.human.y);
      const rad = Math.max(3.5, 6 * s);

      // CHUTE DOOR: an HDPE arm on a pivot in the OUTPOST. Closed it bars the tunnel (across Y); open
      // it lies along the tunnel, which is what lets FUEL past. The pivot sits just outside the
      // ALLIANCE WALL, so both positions are drawn where the CHUTE actually is.
      const pivX = this.px(side === 'red' ? -4 : GEO.L + 4);
      const pivY = this.py(g.human.y);
      const arm = 10 * s;
      const th = (Math.PI / 2) * (1 - (hp ? hp.d : 0));
      ctx.strokeStyle = hp && hp.d ? COLORS.fuel : COLORS.structureLight;
      ctx.lineWidth = Math.max(1.5, 2.5 * s);
      ctx.beginPath();
      ctx.moveTo(pivX, pivY);
      ctx.lineTo(pivX + dir * Math.cos(th) * arm, pivY + dir * Math.sin(th) * arm);
      ctx.stroke();
      if (hp && hp.d) {
        // Open the door is the dump: show the direction the FUEL is about to be delivered in.
        ctx.strokeStyle = 'rgba(240,210,100,0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pivX, pivY);
        ctx.lineTo(this.px(g.dump.x), this.py(g.dump.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const active = !!(hp && hp.a !== 'HOLD');
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(hx, hy, rad * 0.5, 0, Math.PI * 2);
      ctx.fill();
      fillRoundRect(ctx, hx - rad * 0.78, hy + rad * 0.28, rad * 1.56, rad * 0.95, rad * 0.3);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#0d1218';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hx, hy, rad * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      if (active) {
        ctx.strokeStyle = COLORS.fuel;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hx, hy + rad * 0.2, rad * 1.25, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (this.labels) {
        // Two characters, not the whole word: the OUTPOST strip is only PAD_IN wide, so "THROW"
        // would spill over the ALLIANCE WALL onto the carpet at narrow window sizes. Same shorthand
        // the ROBOT intent glyphs use.
        const fpx = Math.max(7, Math.round(7 * Math.max(1, s)));
        ctx.font = `${fpx}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = COLORS.text;
        // The number is the FUEL the HP still has to throw at the OUTPOST: the CHUTE stock, what a
        // ROBOT has pushed into the CORRAL, and the one or two already in hand. Showing the hand alone
        // (capped at 2) said almost nothing about whether a dump was still possible.
        const stock = hp ? hp.h + (hp.c || 0) + (hp.r || 0) : 0;
        ctx.fillText(`HP${stock}`, hx, hy + rad * 2.4);
        if (hp) {
          ctx.fillStyle = hp.a === 'HOLD' ? COLORS.dim : COLORS.fuel;
          ctx.fillText(hp.a === 'SCORE' ? 'Th' : hp.a === 'DUMP' ? 'Dp' : '—', hx, hy - rad * 2.4);
        }
      }
    }

    // ROBOTs. A ROBOT is a SQUARE: R104 caps the perimeter at 110 in and the engine reads that as a
    // square of perimeterIn/4 on a side, so the picture is a rounded square turned to the recorded
    // heading. The heading is information, not decoration — a DUMPER's shooter faces one side only
    // and it cannot score until that side is turned to the HUB, so a replay you cannot read the
    // facing of cannot explain why a car stood still for a second and a half with a full hopper.
    if (frame && frame.r) {
      // A recorded frame is ordered by ROBOT index, so counting per ALLIANCE recovers the DRIVER
      // STATION (1/2/3) without storing it in every one of the ~1600 frames.
      const seen = { red: 0, blue: 0 };
      for (const r of frame.r) {
        const slot = seen[r.a]++;
        const col = r.a === 'red' ? COLORS.red : COLORS.blue;
        const cx = this.px(r.x);
        const cy = this.py(r.y);
        const prof = this.rosters && this.rosters[r.a] ? this.rosters[r.a][slot] : null;
        const half = Math.max(4, (((prof && prof.perimeterIn) || 110) / 8) * s);
        const heading = typeof r.h === 'number' ? r.h : 0;
        const dumper = !!prof && prof.mechanism === 'dumper';
        // Focus: with one or two ROBOTs selected everything else is dimmed, and only the selection
        // carries a plate, so a six-ROBOT scrum still reads as two cars and a blur.
        const focused = !this.focus || this.focus.size === 0 || this.focus.has(r.i);
        const dim = focused ? 1 : 0.22;

        ctx.save();
        ctx.globalAlpha = (r.d ? 0.42 : 1) * dim;
        ctx.translate(cx, cy);
        ctx.rotate(heading);
        ctx.fillStyle = col;
        roundRectPath(ctx, -half, -half, half * 2, half * 2, half * 0.34);
        ctx.fill();
        ctx.strokeStyle = '#0d1218';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // The intake mouth, on whichever face the card says. Placed by rotating to the mouth's own
        // bearing rather than by a lookup per face, so the picture and the engine's mouth band are the
        // same computation and cannot drift apart. It spans the whole edge because that is what the
        // engine tests: a slot bumper to bumper, not a narrow opening. Drawn before the shooter plate
        // so that a Front mouth on a Dumper visibly loses the argument over that bumper.
        const mouthDeg = INTAKE_SIDE_OF(prof && prof.intakeSide).deg;
        if (mouthDeg) ctx.rotate((mouthDeg * Math.PI) / 180);
        ctx.fillStyle = '#7fe3c0';
        roundRectPath(ctx, half * 0.66, -half * 0.94, half * 0.26, half * 1.88, half * 0.1);
        ctx.fill();
        if (mouthDeg) ctx.rotate((-mouthDeg * Math.PI) / 180);
        if (dumper) {
          // The one side that can score, drawn as a bright plate across the front edge. A TURRET gets
          // no plate: its shooter turns independently of the drive, so its body facing means nothing.
          ctx.fillStyle = '#fff6cf';
          roundRectPath(ctx, half * 0.5, -half * 0.66, half * 0.42, half * 1.32, half * 0.16);
          ctx.fill();
        }
        ctx.restore();

        ctx.globalAlpha = dim;
        const hub = r.a === 'red' ? GEO.red.hub : GEO.blue.hub;
        if (!dumper) {
          // Turret: a ring over the body with a barrel that tracks the HUB on its own, so a car
          // driving one way and shooting another is visible as the two directions disagreeing.
          const to = Math.atan2(this.py(hub.y) - cy, this.px(hub.x) - cx);
          ctx.strokeStyle = 'rgba(13,18,24,0.75)';
          ctx.lineWidth = Math.max(2, 2.6 * s);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(to) * half * 1.12, cy + Math.sin(to) * half * 1.12);
          ctx.stroke();
          ctx.strokeStyle = '#eef4ff';
          ctx.lineWidth = Math.max(1, 1.3 * s);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(to) * half * 0.3, cy + Math.sin(to) * half * 0.3);
          ctx.lineTo(cx + Math.cos(to) * half * 1.12, cy + Math.sin(to) * half * 1.12);
          ctx.stroke();
        }
        // carried FUEL count
        if (r.c) {
          ctx.fillStyle = dumper ? '#0d1218' : '#eef4ff';
          ctx.font = `bold ${Math.round(8 * Math.max(1, s))}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(r.c), cx, cy);
        }
        const tag = prof && prof.team ? String(prof.team) : `${r.a === 'red' ? 'R' : 'B'}${slot + 1}`;
        if (this.labels && focused) {
          const fpx = Math.max(8, Math.round(9 * Math.max(1, s)));
          ctx.font = `bold ${fpx}px ui-monospace, monospace`;
          const tw = ctx.measureText(tag).width;
          const bh = fpx + 4;
          // Team number over the ROBOT, on an opaque plate: the FIELD is dense around the HUB and a bare
          // label there is unreadable against carpet, FUEL and other ROBOTs.
          ctx.fillStyle = 'rgba(9,14,21,0.86)';
          fillRoundRect(ctx, cx - tw / 2 - 3, cy - half * 1.42 - bh - 3, tw + 6, bh, 3);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.strokeRect(cx - tw / 2 - 3.5, cy - half * 1.42 - bh - 3.5, tw + 7, bh + 1);
          ctx.fillStyle = '#eef4ff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag, cx, cy - half * 1.42 - 3 - bh / 2);
        }
        // intent glyph, below the ROBOT so the number keeps the space above it. A "+" means the
        // rollers are also running: the intake is a separate mechanism from the shooter, so SCORE
        // and PASS sweep FUEL at the same time.
        if (r.m && r.m !== 'IDLE') {
          const glyph = INTENT_GLYPH[r.m] || r.m[0];
          ctx.fillStyle = r.sweep ? COLORS.fuel : COLORS.text;
          ctx.font = `${Math.round(7 * Math.max(1, s))}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(r.sweep ? `${glyph}+` : glyph, cx, cy + half * 1.42 + 6);
        }
        if (r.k) {
          ctx.strokeStyle = '#ffd94a';
          ctx.lineWidth = 2;
          roundRectPath(ctx, cx - half - 3, cy - half - 3, (half + 3) * 2, (half + 3) * 2, half * 0.4);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    void meta;
  }

  legend() {
    return [
      { c: COLORS.red, t: 'Red alliance ROBOT' },
      { c: COLORS.blue, t: 'Blue alliance ROBOT' },
      { c: COLORS.fuel, t: 'FUEL (§5.10.1)' },
      { c: COLORS.structureLight, t: 'Structures: HUB / BUMP / TRENCH / DEPOT / TOWER' },
      { c: COLORS.dim, t: 'HUMAN PLAYER in each OUTPOST, behind the ALLIANCE WALL and out of every ROBOT\'s reach (G421). The label above it is the play, Th = throw / Dp = dump, and the number below is the FUEL it still has to throw (CHUTE + CORRAL + hand)' },
      { c: COLORS.fuel, t: 'CHUTE DOOR: grey and shut while the HP throws, yellow and swung open to dump the CHUTE onto the FIELD (§5.9.2, G425-A)' },
      { c: COLORS.structureLight, t: 'CORRAL: the slot at the base of the OUTPOST wall where a full ROBOT pushes FUEL for the HP to throw (§5.9.2, G425-B, one layer of 36 FUEL)' },
      { c: COLORS.text, t: 'Letters are the intent (Co sweep / St hold / Sc score / Pa pass / Pu push / Fd deliver / Df defend / Cl climb)' },
      { c: COLORS.fuel, t: 'A + on the intent letter (Sc+) means the roller is sweeping while it shoots or passes' },
      { c: '#fff6cf', t: 'The pale edge on a square ROBOT is a DUMPER\'s shooting face: only that side can score, so the car has to turn it to the HUB. A TURRET has no face — the barrel drawn over it tracks the HUB while the body drives wherever it likes' },
      { c: '#7fe3c0', t: 'The teal bar is the intake mouth, on whichever face the ROBOT card says. The car sweeps a pile by leading with that bar, so a rear intake backs into it and a side intake strafes — a tank drive cannot strafe, and then it only picks up what the side brushes past' },
      { c: COLORS.fuel, t: 'A FUEL stream in flight is one line per shooter through the balls it has in the air, oldest first: straight when it fired standing still, curved when it fired on the move' },
    ];
  }
}
