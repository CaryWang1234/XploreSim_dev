// Top-down FIELD renderer. Geometry comes straight from GEO (§5) so the picture and the
// simulation can never drift apart.

import { FIELD } from './rules.js';
import { GEO } from './engine.js';

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
};

export class FieldView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.resize();
  }

  resize() {
    // clientWidth is 0 before the first layout pass (or in a hidden tab); fall back to the
    // parent, then to a sane default so the first paint is never zero-sized.
    let cssW = this.canvas.clientWidth;
    if (!cssW && this.canvas.parentElement) cssW = this.canvas.parentElement.clientWidth - 32;
    if (!cssW || cssW < 120) cssW = 900;
    const aspect = FIELD.widthIn / FIELD.lengthIn;
    const cssH = Math.round(cssW * aspect);
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.scale = cssW / GEO.L;
    this.offsetX = 0;
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
    const H = W * (GEO.W / GEO.L);
    ctx.fillStyle = COLORS.carpet;
    ctx.fillRect(0, 0, W, H);

    // NEUTRAL ZONE band
    ctx.fillStyle = COLORS.carpetAlt;
    ctx.fillRect(this.px(GEO.red.band[1]), 0, (GEO.blue.band[0] - GEO.red.band[1]) * s, H);

    // ALLIANCE ZONES
    ctx.fillStyle = 'rgba(224,65,63,0.09)';
    ctx.fillRect(0, 0, GEO.red.allianceZone[1] * s, H);
    ctx.fillStyle = 'rgba(47,125,225,0.09)';
    ctx.fillRect(this.px(GEO.blue.allianceZone[0]), 0, (GEO.L - GEO.blue.allianceZone[0]) * s, H);

    // guardrails + ALLIANCE WALLS
    ctx.strokeStyle = COLORS.structureLight;
    ctx.lineWidth = 2;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(0, 0, 3 * s, H);
    ctx.fillStyle = COLORS.blue;
    ctx.fillRect(W - 3 * s, 0, 3 * s, H);

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
    const H = W * (GEO.W / GEO.L);
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
      ctx.fillStyle = COLORS.fuel;
      const r = Math.max(1.6, 2.6 * s);
      for (const [x, y] of frame.fuel) {
        ctx.beginPath();
        ctx.arc(this.px(x), this.py(y), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ROBOTs
    if (frame && frame.r) {
      for (const r of frame.r) {
        const col = r.a === 'red' ? COLORS.red : COLORS.blue;
        const cx = this.px(r.x);
        const cy = this.py(r.y);
        const rad = Math.max(5, 11 * s);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.globalAlpha = r.d ? 0.35 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#0d1218';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // carried FUEL count
        if (r.c) {
          ctx.fillStyle = '#0d1218';
          ctx.font = `bold ${Math.round(8 * Math.max(1, s))}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(r.c), cx, cy);
        }
        // intent glyph
        if (r.m && r.m !== 'IDLE') {
          ctx.fillStyle = '#fff';
          ctx.font = `${Math.round(7 * Math.max(1, s))}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(r.m[0], cx, cy - rad - 4);
        }
        if (r.k) {
          ctx.strokeStyle = '#ffd94a';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, rad + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    void meta;
  }

  legend() {
    return [
      { c: COLORS.red, t: '红联盟 ROBOT' },
      { c: COLORS.blue, t: '蓝联盟 ROBOT' },
      { c: COLORS.fuel, t: 'FUEL (§5.10.1)' },
      { c: COLORS.structureLight, t: '结构件：HUB / BUMP / TRENCH / DEPOT / TOWER' },
    ];
  }
}
