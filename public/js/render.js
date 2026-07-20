// Canvas renderer: hex map, terrain, buildings, units, overlays, animations.

import { hexToPixel, hexCorner, key, parseKey } from '/shared/hex.js';
import { UNIT_TYPES, PLAYER_COLORS, CAPTURE_MAX, MAX_HP } from '/shared/constants.js';

export const HEX = 34; // base hex size in world units

const TERRAIN_FILL = {
  plains: '#31462e',
  forest: '#1f3620',
  mountain: '#4a4740',
  water: '#173a56',
};
const TERRAIN_EDGE = {
  plains: '#3d5639',
  forest: '#2a472b',
  mountain: '#5b584f',
  water: '#1d4a6e',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.state = null; // client game state (from rules.fromSnapshot)
    this.radius = 0;
    this.visible = null; // Set of visible keys or null
    this.youIdx = 0;

    // UI overlays supplied by input layer.
    this.selected = null; // unit id
    this.moveSet = null; // Set of dest keys
    this.attackSet = null; // Set of target hex keys
    this.hover = null; // {q,r}
    this.cursor = null; // {q,r} keyboard cursor
    this.pathPreview = null; // [{q,r}]

    // Animations.
    this.anims = []; // {type, ...., t0, dur}
    this.floaters = []; // damage numbers etc

    this.dpr = window.devicePixelRatio || 1;
    this.resize();
  }

  resize() {
    const { canvas } = this;
    this.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * this.dpr);
    canvas.height = Math.floor(canvas.clientHeight * this.dpr);
  }

  centerOn(q, r) {
    const p = hexToPixel(q, r, HEX);
    this.cam.x = p.x;
    this.cam.y = p.y;
  }

  fitMap() {
    const px = hexToPixel(this.radius, 0, HEX).x * 2.5;
    const zoom = Math.min(
      this.canvas.clientWidth / px,
      this.canvas.clientHeight / px
    );
    this.cam.zoom = Math.max(0.45, Math.min(1.4, zoom));
    this.cam.x = 0;
    this.cam.y = 0;
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.cam.x) * this.cam.zoom + this.canvas.clientWidth / 2,
      y: (y - this.cam.y) * this.cam.zoom + this.canvas.clientHeight / 2,
    };
  }

  screenToWorld(x, y) {
    return {
      x: (x - this.canvas.clientWidth / 2) / this.cam.zoom + this.cam.x,
      y: (y - this.canvas.clientHeight / 2) / this.cam.zoom + this.cam.y,
    };
  }

  // ------- animation queue -------
  addAnim(anim) {
    anim.t0 = performance.now();
    this.anims.push(anim);
  }

  addFloater(q, r, text, color) {
    const p = hexToPixel(q, r, HEX);
    this.floaters.push({ x: p.x, y: p.y, text, color, t0: performance.now(), dur: 1100 });
  }

  // Returns unit's display position (world coords), honoring move animations.
  unitPos(u) {
    for (const a of this.anims) {
      if (a.type === 'move' && a.unitId === u.id) {
        const t = Math.min(1, (performance.now() - a.t0) / a.dur);
        const seg = t * (a.path.length - 1);
        const i = Math.min(a.path.length - 2, Math.floor(seg));
        const f = seg - i;
        const p0 = hexToPixel(a.path[i].q, a.path[i].r, HEX);
        const p1 = hexToPixel(a.path[i + 1].q, a.path[i + 1].r, HEX);
        return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
      }
    }
    return hexToPixel(u.q, u.r, HEX);
  }

  draw() {
    const { ctx, canvas } = this;
    const now = performance.now();
    this.anims = this.anims.filter((a) => now - a.t0 < a.dur);
    this.floaters = this.floaters.filter((f) => now - f.t0 < f.dur);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    if (!this.state) return;

    ctx.save();
    ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
    ctx.scale(this.cam.zoom, this.cam.zoom);
    ctx.translate(-this.cam.x, -this.cam.y);

    this.drawTiles(ctx);
    this.drawOverlays(ctx);
    this.drawBuildings(ctx);
    this.drawUnits(ctx, now);
    this.drawEffects(ctx, now);
    this.drawFloaters(ctx, now);

    ctx.restore();
  }

  hexPath(ctx, cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const c = hexCorner(cx, cy, size, i);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    }
    ctx.closePath();
  }

  isVisible(q, r) {
    return !this.visible || this.visible.has(key(q, r));
  }

  drawTiles(ctx) {
    for (const t of this.state.tiles.values()) {
      const p = hexToPixel(t.q, t.r, HEX);
      const vis = this.isVisible(t.q, t.r);
      this.hexPath(ctx, p.x, p.y, HEX - 1);
      ctx.fillStyle = TERRAIN_FILL[t.t];
      ctx.fill();
      ctx.strokeStyle = TERRAIN_EDGE[t.t];
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Terrain decoration.
      ctx.save();
      ctx.translate(p.x, p.y);
      if (t.t === 'forest') this.decoForest(ctx);
      else if (t.t === 'mountain') this.decoMountain(ctx);
      else if (t.t === 'water') this.decoWater(ctx, t);
      ctx.restore();

      if (!vis) {
        this.hexPath(ctx, p.x, p.y, HEX - 1);
        ctx.fillStyle = '#05080bd0';
        ctx.fill();
      }
    }

    // Hover outline.
    if (this.hover && this.state.tiles.has(key(this.hover.q, this.hover.r))) {
      const p = hexToPixel(this.hover.q, this.hover.r, HEX);
      this.hexPath(ctx, p.x, p.y, HEX - 2);
      ctx.strokeStyle = '#ffffff88';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Keyboard cursor (pulsing gold outline).
    if (this.cursor && this.state.tiles.has(key(this.cursor.q, this.cursor.r))) {
      const p = hexToPixel(this.cursor.q, this.cursor.r, HEX);
      const pulse = 2 + Math.sin(performance.now() / 220) * 0.8;
      this.hexPath(ctx, p.x, p.y, HEX - 2);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = pulse;
      ctx.stroke();
      this.hexPath(ctx, p.x, p.y, HEX - 6);
      ctx.strokeStyle = '#ffd16655';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  decoForest(ctx) {
    ctx.fillStyle = '#2e5c31';
    for (const [dx, dy] of [[-10, 4], [2, -6], [10, 7]]) {
      ctx.beginPath();
      ctx.moveTo(dx, dy - 9);
      ctx.lineTo(dx - 6, dy + 4);
      ctx.lineTo(dx + 6, dy + 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  decoMountain(ctx) {
    ctx.fillStyle = '#6b675c';
    ctx.beginPath();
    ctx.moveTo(-13, 10);
    ctx.lineTo(-2, -11);
    ctx.lineTo(8, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#8b8779';
    ctx.beginPath();
    ctx.moveTo(3, 10);
    ctx.lineTo(11, -4);
    ctx.lineTo(17, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d8d8d2';
    ctx.beginPath();
    ctx.moveTo(-5.5, -4.4);
    ctx.lineTo(-2, -11);
    ctx.lineTo(1.4, -4.4);
    ctx.closePath();
    ctx.fill();
  }

  decoWater(ctx, t) {
    const ph = (performance.now() / 900 + (t.q * 7 + t.r * 13) * 0.35) % (Math.PI * 2);
    ctx.strokeStyle = '#3d7eb0';
    ctx.lineWidth = 1.6;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      const yy = i * 8 + Math.sin(ph + i) * 1.5;
      ctx.moveTo(-12, yy);
      ctx.quadraticCurveTo(-6, yy - 3, 0, yy);
      ctx.quadraticCurveTo(6, yy + 3, 12, yy);
      ctx.stroke();
    }
  }

  drawOverlays(ctx) {
    // Movement range.
    if (this.moveSet) {
      for (const k of this.moveSet) {
        const { q, r } = parseKey(k);
        const p = hexToPixel(q, r, HEX);
        this.hexPath(ctx, p.x, p.y, HEX - 4);
        ctx.fillStyle = '#3b82f640';
        ctx.fill();
        ctx.strokeStyle = '#3b82f6aa';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    // Attack targets.
    if (this.attackSet) {
      for (const k of this.attackSet) {
        const { q, r } = parseKey(k);
        const p = hexToPixel(q, r, HEX);
        this.hexPath(ctx, p.x, p.y, HEX - 4);
        ctx.fillStyle = '#e5484d40';
        ctx.fill();
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    // Path preview.
    if (this.pathPreview && this.pathPreview.length > 1) {
      ctx.beginPath();
      const p0 = hexToPixel(this.pathPreview[0].q, this.pathPreview[0].r, HEX);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < this.pathPreview.length; i++) {
        const p = hexToPixel(this.pathPreview[i].q, this.pathPreview[i].r, HEX);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = '#ffffffcc';
      ctx.lineWidth = 3.5;
      ctx.setLineDash([7, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawBuildings(ctx) {
    for (const t of this.state.tiles.values()) {
      if (!t.b) continue;
      const p = hexToPixel(t.q, t.r, HEX);
      const color = t.b.owner != null ? PLAYER_COLORS[t.b.owner] : '#9aa7b5';
      ctx.save();
      ctx.translate(p.x, p.y);

      if (t.b.type === 'hq') {
        // Star fortress.
        ctx.fillStyle = color;
        ctx.strokeStyle = '#00000088';
        ctx.lineWidth = 1.5;
        this.starPath(ctx, 0, 0, 14, 6.5, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('HQ', 0, 1);
      } else {
        // City: little blocks.
        ctx.fillStyle = color;
        ctx.strokeStyle = '#00000066';
        ctx.lineWidth = 1;
        ctx.fillRect(-12, -4, 9, 12);
        ctx.strokeRect(-12, -4, 9, 12);
        ctx.fillRect(-1, -10, 8, 18);
        ctx.strokeRect(-1, -10, 8, 18);
        ctx.fillRect(8, -2, 6, 10);
        ctx.strokeRect(8, -2, 6, 10);
        ctx.fillStyle = '#ffffffcc';
        for (const [wx, wy] of [[-10, -1], [1, -7], [1, -1], [9.5, 1]]) {
          ctx.fillRect(wx, wy, 2.4, 2.4);
        }
      }

      // Capture progress pie.
      if (t.b.cap != null && t.b.cap < CAPTURE_MAX && this.isVisible(t.q, t.r)) {
        const frac = 1 - t.b.cap / CAPTURE_MAX;
        ctx.beginPath();
        ctx.moveTo(16, -16);
        ctx.arc(16, -16, 8, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.lineTo(16, -16);
        ctx.fillStyle = '#eab308';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(16, -16, 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  starPath(ctx, cx, cy, outer, inner, points) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const rad = i % 2 === 0 ? outer : inner;
      const a = (Math.PI / points) * i - Math.PI / 2;
      const x = cx + rad * Math.cos(a);
      const y = cy + rad * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  drawUnits(ctx, now) {
    const dying = new Map();
    for (const a of this.anims) {
      if (a.type === 'die') dying.set(a.unit.id, a);
    }

    const drawOne = (u, alpha = 1, pos = null) => {
      const p = pos || this.unitPos(u);
      const color = PLAYER_COLORS[u.owner];
      const t = UNIT_TYPES[u.type];
      const exhausted = u.owner === this.state.turnIdx && u.moved && u.acted;

      ctx.save();
      ctx.globalAlpha = alpha * (exhausted ? 0.55 : 1);
      ctx.translate(p.x, p.y);

      // Selection ring.
      if (this.selected === u.id) {
        ctx.beginPath();
        ctx.arc(0, 0, 20, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = -(now / 40) % 9;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Body: colored roundrect w/ symbol.
      ctx.beginPath();
      const w = 24, h = 20, rr = 5;
      ctx.roundRect(-w / 2, -h / 2, w, h, rr);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#000000aa';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.symbol, 0, 0.5);

      // HP pips (only when damaged).
      if (u.hp < MAX_HP) {
        ctx.fillStyle = '#000000aa';
        ctx.fillRect(-13, 11, 26, 5);
        ctx.fillStyle = u.hp > 6 ? '#22c55e' : u.hp > 3 ? '#eab308' : '#e5484d';
        ctx.fillRect(-12, 12, 24 * (u.hp / MAX_HP), 3);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 8px sans-serif';
        ctx.fillText(String(u.hp), 17, 13.5);
      }
      ctx.restore();
    };

    for (const u of this.state.units.values()) {
      if (!this.isVisible(u.q, u.r) && !this.anims.some((a) => a.type === 'move' && a.unitId === u.id)) continue;
      drawOne(u);
    }

    // Death fade-outs (units already removed from state).
    for (const a of dying.values()) {
      const t = (now - a.t0) / a.dur;
      drawOne(a.unit, 1 - t, hexToPixel(a.unit.q, a.unit.r, HEX));
    }
  }

  drawEffects(ctx, now) {
    for (const a of this.anims) {
      const t = (now - a.t0) / a.dur;
      if (a.type === 'shot') {
        // Projectile streak + muzzle flash.
        const p0 = hexToPixel(a.from.q, a.from.r, HEX);
        const p1 = hexToPixel(a.to.q, a.to.r, HEX);
        const x = p0.x + (p1.x - p0.x) * t;
        const y = p0.y + (p1.y - p0.y) * t;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd166';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd16644';
        ctx.fill();
      } else if (a.type === 'boom') {
        const p = hexToPixel(a.q, a.r, HEX);
        const rad = 6 + t * 22;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 120, 40, ${0.55 * (1 - t)})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 220, 120, ${0.7 * (1 - t)})`;
        ctx.fill();
      } else if (a.type === 'flag') {
        const p = hexToPixel(a.q, a.r, HEX);
        const rad = 10 + t * 18;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.strokeStyle = a.color + 'cc';
        ctx.lineWidth = 3 * (1 - t);
        ctx.stroke();
      }
    }
  }

  drawFloaters(ctx, now) {
    for (const f of this.floaters) {
      const t = (now - f.t0) / f.dur;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = f.color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      const y = f.y - 24 - t * 22;
      ctx.strokeText(f.text, f.x, y);
      ctx.fillText(f.text, f.x, y);
      ctx.restore();
    }
  }
}
