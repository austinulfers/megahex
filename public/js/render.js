// Canvas renderer: hex map, terrain, buildings, units, overlays, animations.

import { hexToPixel, hexCorner, key, parseKey, DIRS } from '/shared/hex.js';
import { PLAYER_COLORS, CAPTURE_MAX, MAX_HP } from '/shared/constants.js';
import { unitDone } from '/shared/rules.js';
import { mulberry32, hashSeed } from '/shared/rng.js';

export const HEX = 34; // base hex size in world units

// ---------- color helpers ----------

function hexRgb(h) {
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

// f > 0 lightens toward white, f < 0 darkens toward black.
function shade(col, f) {
  const c = hexRgb(col);
  const t = f < 0 ? 0 : 255;
  const k = Math.abs(f);
  const m = (v) => Math.round(v + (t - v) * k);
  return `rgb(${m(c.r)},${m(c.g)},${m(c.b)})`;
}

function mix(a, b, f) {
  const ca = hexRgb(a), cb = hexRgb(b);
  const m = (x, y) => Math.round(x + (y - x) * f);
  return `rgb(${m(ca.r, cb.r)},${m(ca.g, cb.g)},${m(ca.b, cb.b)})`;
}

// ---------- tile sprites (pre-rendered, cached) ----------

const SS = 3; // supersampling factor for crispness when zoomed
const PAD = 8; // world-unit padding so decorations can overhang the hex
const SPR = (HEX + PAD) * 2; // sprite size in world units
const VARIANTS = 3; // texture variants per terrain
const tileSprites = new Map();

const T_STYLE = {
  plains: { top: '#41603a', bot: '#2e452c', line: '#243522' },
  forest: { top: '#2c4a2c', bot: '#1b301d', line: '#152718' },
  mountain: { top: '#615c51', bot: '#423f37', line: '#2f2d27' },
  water: { top: '#1e5480', bot: '#102c44', line: '#0c2236' },
};

// Corner index pairs of the hex edge facing DIRS[i]
// (corner i sits at angle 60i-30°, so the edge facing DIRS[0]=east is corners 0→1, etc.)
const EDGE_CORNERS = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];

function tileHash(q, r) {
  let h = (Math.imul(q, 374761393) + Math.imul(r, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function hexPathAt(g, size) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const c = hexCorner(0, 0, size, i);
    if (i === 0) g.moveTo(c.x, c.y);
    else g.lineTo(c.x, c.y);
  }
  g.closePath();
}

function tileSprite(terrain, variant) {
  const cacheKey = terrain + ':' + variant;
  let spr = tileSprites.get(cacheKey);
  if (spr) return spr;
  spr = document.createElement('canvas');
  spr.width = spr.height = SPR * SS;
  const g = spr.getContext('2d');
  g.scale(SS, SS);
  g.translate(HEX + PAD, HEX + PAD);
  const rng = mulberry32(hashSeed(cacheKey));
  paintTileBase(g, terrain);
  if (terrain === 'plains') paintPlains(g, rng);
  else if (terrain === 'forest') paintForest(g, rng);
  else if (terrain === 'mountain') paintMountain(g, rng);
  else if (terrain === 'water') paintWaterBase(g, rng);
  tileSprites.set(cacheKey, spr);
  return spr;
}

function paintTileBase(g, terrain) {
  const st = T_STYLE[terrain];
  const grad = g.createLinearGradient(0, -HEX, 0, HEX);
  grad.addColorStop(0, st.top);
  grad.addColorStop(1, st.bot);
  hexPathAt(g, HEX - 0.8);
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = st.line;
  g.lineWidth = 1.6;
  g.stroke();
  // Bevel: light along top-left edges, shadow along bottom-right.
  g.lineCap = 'round';
  g.lineWidth = 2.2;
  g.beginPath();
  for (let i = 3; i <= 6; i++) {
    const c = hexCorner(0, 0, HEX - 2.6, i % 6);
    if (i === 3) g.moveTo(c.x, c.y);
    else g.lineTo(c.x, c.y);
  }
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.stroke();
  g.beginPath();
  for (let i = 0; i <= 3; i++) {
    const c = hexCorner(0, 0, HEX - 2.6, i);
    if (i === 0) g.moveTo(c.x, c.y);
    else g.lineTo(c.x, c.y);
  }
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.stroke();
}

function paintPlains(g, rng) {
  g.save();
  hexPathAt(g, HEX - 1.6);
  g.clip();
  // Mottled ground patches.
  for (let i = 0; i < 4; i++) {
    const x = (rng() * 2 - 1) * 16, y = (rng() * 2 - 1) * 13, r = 6 + rng() * 8;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.65, rng() * Math.PI, 0, Math.PI * 2);
    g.fillStyle = rng() < 0.5 ? 'rgba(230,255,190,0.05)' : 'rgba(0,25,0,0.08)';
    g.fill();
  }
  // Grass tufts.
  for (let i = 0; i < 12; i++) {
    const x = (rng() * 2 - 1) * 19;
    const y = (rng() * 2 - 1) * 16 + 3;
    const h = 2.6 + rng() * 2.2;
    g.strokeStyle = rng() < 0.4 ? '#527446' : '#40593a';
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(x - 1.5, y);
    g.quadraticCurveTo(x - 1.3, y - h * 0.7, x - 2.1, y - h);
    g.moveTo(x, y);
    g.quadraticCurveTo(x + 0.1, y - h * 0.8, x + 0.3, y - h - 0.7);
    g.moveTo(x + 1.5, y);
    g.quadraticCurveTo(x + 1.4, y - h * 0.7, x + 2.2, y - h);
    g.stroke();
  }
  // Sparse wildflowers.
  for (let i = 0; i < 3; i++) {
    if (rng() < 0.45) continue;
    const x = (rng() * 2 - 1) * 17, y = (rng() * 2 - 1) * 14;
    g.fillStyle = rng() < 0.5 ? '#d9d284' : '#cfa3bd';
    g.beginPath();
    g.arc(x, y, 1.05, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.beginPath();
    g.arc(x - 0.3, y - 0.3, 0.4, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

function paintTree(g, { x, y, s, tone }) {
  // Ground shadow.
  g.beginPath();
  g.ellipse(x + 0.8, y + s * 0.5, s * 0.85, s * 0.3, 0, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fill();
  // Trunk.
  g.fillStyle = '#4b3625';
  g.fillRect(x - s * 0.11, y - s * 0.05, s * 0.22, s * 0.6);
  // Canopy: three stacked layers, dark/wide at the bottom.
  const cols = tone === 0
    ? ['#1c3f23', '#295331', '#38683d']
    : ['#234728', '#305c35', '#427344'];
  for (let l = 0; l < 3; l++) {
    const w = s * (0.95 - l * 0.24);
    const by = y + s * 0.14 - l * s * 0.36;
    g.beginPath();
    g.moveTo(x, by - s * 0.8);
    g.lineTo(x - w, by);
    g.lineTo(x + w, by);
    g.closePath();
    g.fillStyle = cols[l];
    g.fill();
  }
  // Sun-side highlight.
  g.beginPath();
  g.moveTo(x, y - s * 1.35);
  g.lineTo(x - s * 0.34, y - s * 0.62);
  g.lineTo(x, y - s * 0.62);
  g.closePath();
  g.fillStyle = 'rgba(255,255,230,0.13)';
  g.fill();
}

function paintForest(g, rng) {
  g.save();
  hexPathAt(g, HEX - 1.6);
  g.clip();
  // Underbrush mottling.
  for (let i = 0; i < 4; i++) {
    const x = (rng() * 2 - 1) * 15, y = (rng() * 2 - 1) * 13, r = 5 + rng() * 7;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.6, rng() * Math.PI, 0, Math.PI * 2);
    g.fillStyle = rng() < 0.6 ? 'rgba(0,20,4,0.13)' : 'rgba(190,255,170,0.045)';
    g.fill();
  }
  g.restore();
  const spots = [[-11, 1], [3, -9], [12, 6], [-3, 11], [10, -3], [-14, -6]];
  const n = 4 + Math.floor(rng() * 2);
  const trees = [];
  for (let i = 0; i < n; i++) {
    trees.push({
      x: spots[i][0] + (rng() * 2 - 1) * 2.5,
      y: spots[i][1] + (rng() * 2 - 1) * 2.5,
      s: 6.2 + rng() * 2.6,
      tone: rng() < 0.5 ? 0 : 1,
    });
  }
  trees.sort((a, b) => a.y - b.y); // painter's order
  for (const t of trees) paintTree(g, t);
}

function paintPeak(g, ax, ay, halfW, drop, light, dark, snow) {
  const bl = { x: ax - halfW, y: ay + drop };
  const br = { x: ax + halfW * 1.06, y: ay + drop };
  const mid = { x: ax + halfW * 0.16, y: ay + drop };
  // Shaded right face.
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(mid.x, mid.y);
  g.lineTo(br.x, br.y);
  g.closePath();
  g.fillStyle = dark;
  g.fill();
  // Sunlit left face.
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(bl.x, bl.y);
  g.lineTo(mid.x, mid.y);
  g.closePath();
  g.fillStyle = light;
  g.fill();
  // Silhouette outline.
  g.beginPath();
  g.moveTo(bl.x, bl.y);
  g.lineTo(ax, ay);
  g.lineTo(br.x, br.y);
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 1;
  g.lineJoin = 'round';
  g.stroke();
  if (snow) {
    const f = 0.36;
    const pL = { x: ax + (bl.x - ax) * f, y: ay + (bl.y - ay) * f };
    const pR = { x: ax + (br.x - ax) * (f - 0.05), y: ay + (br.y - ay) * (f - 0.05) };
    const j1 = { x: ax - halfW * 0.14, y: ay + drop * f * 0.66 };
    const j2 = { x: ax + halfW * 0.12, y: ay + drop * f * 0.92 };
    const j3 = { x: ax + halfW * 0.3, y: ay + drop * f * 0.62 };
    // Shaded snow on the right face.
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(pR.x, pR.y);
    g.lineTo(j3.x, j3.y);
    g.lineTo(j2.x, j2.y);
    g.closePath();
    g.fillStyle = '#c6ccd1';
    g.fill();
    // Bright snow cap with a jagged melt line.
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(pL.x, pL.y);
    g.lineTo(j1.x, j1.y);
    g.lineTo(j2.x, j2.y);
    g.closePath();
    g.fillStyle = '#eef1f2';
    g.fill();
  }
}

function paintMountain(g, rng) {
  g.save();
  hexPathAt(g, HEX - 1.5);
  g.clip();
  // Rubble mottling.
  for (let i = 0; i < 5; i++) {
    const x = (rng() * 2 - 1) * 17, y = (rng() * 2 - 1) * 14 + 4, r = 3 + rng() * 5;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.55, rng() * Math.PI, 0, Math.PI * 2);
    g.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,240,0.05)';
    g.fill();
  }
  g.restore();
  const j = (rng() * 2 - 1) * 2;
  paintPeak(g, 9 - j, -2, 9, 12, '#6f6a5e', '#555148', false);
  paintPeak(g, -4 + j, -12, 13.5, 23, '#807a6c', '#5d584e', true);
  // Scree at the base.
  g.fillStyle = '#79746a';
  for (let i = 0; i < 4; i++) {
    const x = -8 + rng() * 18, y = 9 + rng() * 4;
    g.beginPath();
    g.arc(x, y, 0.9 + rng() * 0.7, 0, Math.PI * 2);
    g.fill();
  }
}

function paintWaterBase(g, rng) {
  g.save();
  hexPathAt(g, HEX - 1.4);
  g.clip();
  // Deep-water blotches.
  for (let i = 0; i < 3; i++) {
    const x = (rng() * 2 - 1) * 13, y = (rng() * 2 - 1) * 11 + 4, r = 7 + rng() * 9;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.6, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(5,24,42,0.35)';
    g.fill();
  }
  // Light shafts near the surface.
  for (let i = 0; i < 2; i++) {
    const x = (rng() * 2 - 1) * 12, y = -14 + rng() * 8, r = 6 + rng() * 6;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(120,190,235,0.08)';
    g.fill();
  }
  g.restore();
}

// ---------- unit bodies (vector silhouettes, drawn facing +x) ----------

const OUTLINE = 'rgba(10,12,16,0.85)';

function bodyGrad(ctx, color, y0, y1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, shade(color, 0.28));
  g.addColorStop(0.55, color);
  g.addColorStop(1, shade(color, -0.28));
  return g;
}

function drawUnitBody(ctx, type, color) {
  ctx.lineJoin = 'round';
  switch (type) {
    case 'INFANTRY': {
      // Legs + boots.
      ctx.fillStyle = shade(color, -0.45);
      ctx.fillRect(-3.6, 4, 2.9, 5.6);
      ctx.fillRect(0.9, 4, 2.9, 5.6);
      ctx.fillStyle = '#22252b';
      ctx.fillRect(-3.9, 8.4, 3.5, 1.8);
      ctx.fillRect(0.7, 8.4, 3.5, 1.8);
      // Torso.
      ctx.beginPath();
      ctx.roundRect(-4.6, -3.6, 9.2, 8.6, 2.4);
      ctx.fillStyle = bodyGrad(ctx, color, -3.6, 5);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      // Chest strap.
      ctx.strokeStyle = shade(color, -0.5);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-3.6, -3);
      ctx.lineTo(3, 3.4);
      ctx.stroke();
      // Rifle + stock.
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#2a2d33';
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.moveTo(-5.5, 3.4);
      ctx.lineTo(8.8, -3.4);
      ctx.stroke();
      ctx.strokeStyle = '#584a35';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-5.2, 3.2);
      ctx.lineTo(-2.4, 1.9);
      ctx.stroke();
      // Hand on grip.
      ctx.fillStyle = '#d9b48d';
      ctx.beginPath();
      ctx.arc(3.4, -0.9, 1.3, 0, Math.PI * 2);
      ctx.fill();
      // Head + helmet.
      ctx.beginPath();
      ctx.arc(0, -6.8, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade(color, -0.3);
      ctx.beginPath();
      ctx.arc(0, -7.3, 3.7, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = shade(color, -0.45);
      ctx.fillRect(-4.1, -7.5, 8.2, 1.4);
      break;
    }
    case 'RECON': {
      // Wheels.
      for (const wx of [-7, 7]) {
        ctx.beginPath();
        ctx.arc(wx, 6.5, 4.1, 0, Math.PI * 2);
        ctx.fillStyle = '#23262b';
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(wx, 6.5, 1.7, 0, Math.PI * 2);
        ctx.fillStyle = '#6d7683';
        ctx.fill();
      }
      // Angular scout body with a raised cab.
      ctx.beginPath();
      ctx.moveTo(-12.5, 5.5);
      ctx.lineTo(-12.5, 0.5);
      ctx.lineTo(-8.5, -3);
      ctx.lineTo(-0.5, -3);
      ctx.lineTo(3, -7.5);
      ctx.lineTo(9.5, -7.5);
      ctx.lineTo(12.8, -2);
      ctx.lineTo(12.8, 5.5);
      ctx.closePath();
      ctx.fillStyle = bodyGrad(ctx, color, -7.5, 5.5);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Windshield.
      ctx.beginPath();
      ctx.moveTo(3.8, -6.4);
      ctx.lineTo(8.9, -6.4);
      ctx.lineTo(11.2, -2.6);
      ctx.lineTo(4.6, -2.6);
      ctx.closePath();
      ctx.fillStyle = '#b8dcef';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // Fender line.
      ctx.strokeStyle = shade(color, -0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-12.5, 2.5);
      ctx.lineTo(12.8, 2.5);
      ctx.stroke();
      // Antenna + pennant.
      ctx.strokeStyle = '#2f333a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-9.5, -3);
      ctx.lineTo(-11.5, -11.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-11.5, -11.5);
      ctx.lineTo(-7.6, -10.4);
      ctx.lineTo(-11.1, -9.4);
      ctx.closePath();
      ctx.fillStyle = shade(color, 0.35);
      ctx.fill();
      // Headlight.
      ctx.fillStyle = '#ffe9a8';
      ctx.fillRect(12, 0.2, 1.6, 2.2);
      break;
    }
    case 'TANK': {
      // Treads + road wheels.
      ctx.beginPath();
      ctx.roundRect(-12, 2.5, 24, 8, 4);
      ctx.fillStyle = '#24272d';
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.fillStyle = '#4d545e';
      for (const wx of [-7.5, -2.5, 2.5, 7.5]) {
        ctx.beginPath();
        ctx.arc(wx, 6.5, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
      // Hull.
      ctx.beginPath();
      ctx.roundRect(-10.5, -3.5, 21, 8, 2.5);
      ctx.fillStyle = bodyGrad(ctx, color, -3.5, 4.5);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.strokeStyle = shade(color, 0.3);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-9.5, -3);
      ctx.lineTo(9.5, -3);
      ctx.stroke();
      // Barrel (behind turret) + muzzle brake.
      ctx.fillStyle = shade(color, -0.42);
      ctx.beginPath();
      ctx.roundRect(2.5, -7.6, 12.5, 2.8, 1.2);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.fillStyle = '#1d2025';
      ctx.fillRect(13.4, -8.1, 2.6, 3.8);
      // Turret + hatch.
      ctx.beginPath();
      ctx.roundRect(-7.5, -9.5, 11, 7.5, 3);
      ctx.fillStyle = bodyGrad(ctx, color, -9.5, -2);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.fillStyle = shade(color, 0.4);
      ctx.beginPath();
      ctx.arc(-3.5, -6.5, 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'ARTILLERY': {
      // Treads.
      ctx.beginPath();
      ctx.roundRect(-11, 3.5, 22, 7, 3.5);
      ctx.fillStyle = '#24272d';
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#4d545e';
      for (const wx of [-6.5, -1, 4.5]) {
        ctx.beginPath();
        ctx.arc(wx, 7, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Recoil spade.
      ctx.fillStyle = '#3a3f47';
      ctx.beginPath();
      ctx.moveTo(-11, 4);
      ctx.lineTo(-14.5, 8.5);
      ctx.lineTo(-10, 8.5);
      ctx.closePath();
      ctx.fill();
      // Chassis.
      ctx.beginPath();
      ctx.roundRect(-9.5, -1.5, 19, 7, 2);
      ctx.fillStyle = bodyGrad(ctx, color, -1.5, 5.5);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      // Elevated howitzer barrel.
      ctx.save();
      ctx.translate(-2, -0.5);
      ctx.rotate(-0.5);
      ctx.fillStyle = shade(color, -0.45);
      ctx.beginPath();
      ctx.roundRect(0, -1.6, 17.5, 3.2, 1.4);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.fillStyle = shade(color, -0.2);
      ctx.fillRect(2.2, -1.6, 3.2, 3.2);
      ctx.fillStyle = '#1d2025';
      ctx.fillRect(16, -2.2, 2.6, 4.4);
      ctx.restore();
      // Mount pivot.
      ctx.beginPath();
      ctx.arc(-2, -0.5, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = shade(color, -0.3);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = shade(color, 0.35);
      ctx.beginPath();
      ctx.arc(-2, -0.5, 1.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'TITAN': {
      // Twin tread pods.
      for (const tx of [-13.5, 1.5]) {
        ctx.beginPath();
        ctx.roundRect(tx, 3, 12, 8, 3.5);
        ctx.fillStyle = '#24272d';
        ctx.fill();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#4d545e';
        for (const wx of [tx + 3, tx + 6, tx + 9]) {
          ctx.beginPath();
          ctx.arc(wx, 7, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Main hull.
      ctx.beginPath();
      ctx.roundRect(-12.5, -5.5, 25, 10.5, 3);
      ctx.fillStyle = bodyGrad(ctx, color, -5.5, 5);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.strokeStyle = shade(color, -0.4);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-12.5, -0.5);
      ctx.lineTo(12.5, -0.5);
      ctx.stroke();
      // Superstructure.
      ctx.beginPath();
      ctx.roundRect(-7.5, -13.5, 13, 9, 2);
      ctx.fillStyle = bodyGrad(ctx, color, -13.5, -4.5);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      // Visor.
      ctx.fillStyle = '#9fe8ff';
      ctx.fillRect(1.2, -11.8, 3.4, 2);
      // Twin cannons.
      ctx.fillStyle = shade(color, -0.48);
      ctx.beginPath();
      ctx.roundRect(5, -12.8, 10.5, 2.4, 1.1);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(5, -9, 10.5, 2.4, 1.1);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1d2025';
      ctx.fillRect(14.2, -13.2, 2.4, 3.2);
      ctx.fillRect(14.2, -9.4, 2.4, 3.2);
      // Shoulder pod + antenna.
      ctx.beginPath();
      ctx.roundRect(-11.5, -11.5, 4.5, 6, 1.2);
      ctx.fillStyle = shade(color, -0.35);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.strokeStyle = '#2f333a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-9.2, -11.5);
      ctx.lineTo(-10.8, -17.5);
      ctx.stroke();
      ctx.fillStyle = shade(color, 0.4);
      ctx.beginPath();
      ctx.arc(-10.8, -17.8, 0.9, 0, Math.PI * 2);
      ctx.fill();
      // Reactor core glow.
      ctx.fillStyle = 'rgba(150,230,255,0.25)';
      ctx.beginPath();
      ctx.arc(-1.5, 0.2, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(150,230,255,0.9)';
      ctx.beginPath();
      ctx.arc(-1.5, 0.2, 1.7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: {
      ctx.beginPath();
      ctx.roundRect(-12, -10, 24, 20, 5);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

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
    this.targetFocus = null; // {q,r} hex highlighted from the action menu
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
    const now = performance.now();
    for (const t of this.state.tiles.values()) {
      const p = hexToPixel(t.q, t.r, HEX);
      const spr = tileSprite(t.t, tileHash(t.q, t.r) % VARIANTS);
      ctx.drawImage(spr, p.x - HEX - PAD, p.y - HEX - PAD, SPR, SPR);
      if (t.t === 'water') {
        this.drawShore(ctx, t, p, now);
        this.decoWater(ctx, t, p, now);
      }
    }

    // Fog of war shroud.
    for (const t of this.state.tiles.values()) {
      if (this.isVisible(t.q, t.r)) continue;
      const p = hexToPixel(t.q, t.r, HEX);
      this.hexPath(ctx, p.x, p.y, HEX - 1);
      ctx.fillStyle = '#05080bd0';
      ctx.fill();
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

  // Sand + foam edging where water meets land.
  drawShore(ctx, t, p, now) {
    for (let d = 0; d < 6; d++) {
      const nb = this.state.tiles.get(key(t.q + DIRS[d][0], t.r + DIRS[d][1]));
      if (!nb || nb.t === 'water') continue;
      const [i1, i2] = EDGE_CORNERS[d];
      let a = hexCorner(p.x, p.y, HEX - 1.8, i1);
      let b = hexCorner(p.x, p.y, HEX - 1.8, i2);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = 'rgba(203,186,140,0.5)';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      a = hexCorner(p.x, p.y, HEX - 4.6, i1);
      b = hexCorner(p.x, p.y, HEX - 4.6, i2);
      const foam = 0.2 + 0.13 * Math.sin(now / 750 + t.q + t.r + d);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(214,240,252,${foam.toFixed(3)})`;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
  }

  decoWater(ctx, t, p, now) {
    const ph = now / 950 + (t.q * 7 + t.r * 13) * 0.35;
    ctx.save();
    ctx.translate(p.x, p.y);
    for (let i = -1; i <= 1; i++) {
      const yy = i * 8.5 + Math.sin(ph + i * 1.7) * 1.6;
      const x0 = -12 + i * 2;
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.quadraticCurveTo(x0 + 6, yy - 2.6, x0 + 12, yy);
      ctx.quadraticCurveTo(x0 + 18, yy + 2.6, x0 + 24, yy);
      ctx.strokeStyle = 'rgba(16,52,80,0.75)';
      ctx.lineWidth = 2.1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0, yy - 0.8);
      ctx.quadraticCurveTo(x0 + 6, yy - 3.4, x0 + 12, yy - 0.8);
      ctx.quadraticCurveTo(x0 + 18, yy + 1.8, x0 + 24, yy - 0.8);
      ctx.strokeStyle = 'rgba(125,190,232,0.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    // Twinkling glints.
    const tw = 0.5 + 0.5 * Math.sin(ph * 2.3 + 1);
    ctx.fillStyle = `rgba(190,230,255,${(0.28 * tw).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(8, -10, 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-9, 5, 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
    // Focused attack target (hovered in the action menu): pulsing crosshair.
    if (this.targetFocus) {
      const p = hexToPixel(this.targetFocus.q, this.targetFocus.r, HEX);
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 150);
      this.hexPath(ctx, p.x, p.y, HEX - 2);
      ctx.fillStyle = '#e5484d55';
      ctx.fill();
      ctx.strokeStyle = `rgba(255, 210, 80, ${pulse})`;
      ctx.lineWidth = 4;
      ctx.stroke();
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
    const now = performance.now();
    for (const t of this.state.tiles.values()) {
      if (!t.b) continue;
      const p = hexToPixel(t.q, t.r, HEX);
      const owned = t.b.owner != null;
      const color = owned ? PLAYER_COLORS[t.b.owner] : '#9aa7b5';
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.lineJoin = 'round';

      // Ground shadow.
      ctx.beginPath();
      ctx.ellipse(0, 8.5, 15.5, 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fill();

      if (t.b.type === 'hq') this.drawHQ(ctx, color, t, now);
      else this.drawCity(ctx, color, owned);

      // Capture progress dial.
      if (t.b.cap != null && t.b.cap < CAPTURE_MAX && this.isVisible(t.q, t.r)) {
        const frac = 1 - t.b.cap / CAPTURE_MAX;
        ctx.beginPath();
        ctx.arc(15, -15, 8.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8,10,14,0.8)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(15, -15);
        ctx.arc(15, -15, 6.6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = '#eab308';
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawHQ(ctx, color, t, now) {
    // Keep tower (behind the wall).
    let g = ctx.createLinearGradient(0, -18, 0, -3);
    g.addColorStop(0, '#9aa2ae');
    g.addColorStop(1, '#6f7783');
    ctx.fillStyle = '#7d8591';
    ctx.fillRect(-5.5, -19.4, 3.1, 2.8);
    ctx.fillRect(-1.5, -19.4, 3.1, 2.8);
    ctx.fillRect(2.5, -19.4, 3.1, 2.8);
    ctx.beginPath();
    ctx.roundRect(-5.5, -17.4, 11, 14, 1.2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#242932';
    ctx.fillRect(-1.2, -14.6, 2.4, 4.6);

    // Waving owner flag.
    const wav = Math.sin(now / 240 + (t.q * 3 + t.r * 5)) * 1.5;
    ctx.strokeStyle = '#3a3f46';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(4.2, -19);
    ctx.lineTo(4.2, -30);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(4.2, -30);
    ctx.quadraticCurveTo(9.5, -30.8 + wav * 0.6, 14, -29.2 + wav);
    ctx.lineTo(13.4, -24.6 + wav);
    ctx.quadraticCurveTo(9, -26 + wav * 0.6, 4.2, -25.2);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Main wall with crenellations.
    g = ctx.createLinearGradient(0, -8, 0, 9);
    g.addColorStop(0, '#a2aab6');
    g.addColorStop(1, '#6e7682');
    ctx.fillStyle = '#848c98';
    for (let i = 0; i < 5; i++) ctx.fillRect(-14 + i * 6.1, -9.6, 3.9, 3);
    ctx.beginPath();
    ctx.roundRect(-14, -7.4, 28, 16.4, 1.8);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Owner banner band + star emblem.
    ctx.fillStyle = color;
    ctx.fillRect(-14, -3.4, 28, 4.8);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(-14, -3.4, 28, 1.4);
    this.starPath(ctx, 0, -1, 3.4, 1.6, 5);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // Gate.
    ctx.beginPath();
    ctx.moveTo(-3.2, 9);
    ctx.lineTo(-3.2, 4.6);
    ctx.quadraticCurveTo(0, 1.4, 3.2, 4.6);
    ctx.lineTo(3.2, 9);
    ctx.closePath();
    ctx.fillStyle = '#262b33';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawCity(ctx, color, owned) {
    const wall = owned ? mix(color, '#d3d7dc', 0.62) : '#a8b0ba';
    const wallDark = owned ? mix(color, '#8b929c', 0.55) : '#8b939d';
    const roof = owned ? shade(color, -0.15) : '#5f6873';
    const lit = '#ffd98a';
    const off = '#3d4553';

    // Foundation slab.
    ctx.fillStyle = '#4a505a';
    ctx.beginPath();
    ctx.roundRect(-15, 6.6, 30, 4.2, 1.4);
    ctx.fill();
    ctx.fillStyle = '#5b626d';
    ctx.fillRect(-15, 6.6, 30, 1.2);

    const outline = (x, y, w, h) => {
      ctx.strokeStyle = 'rgba(0,0,0,0.42)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    };

    // Left house with pitched roof.
    ctx.fillStyle = wall;
    ctx.fillRect(-13, -2, 9, 9);
    outline(-13, -2, 9, 9);
    ctx.beginPath();
    ctx.moveTo(-13.9, -2);
    ctx.lineTo(-8.5, -5.6);
    ctx.lineTo(-3.1, -2);
    ctx.closePath();
    ctx.fillStyle = roof;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.fillStyle = lit;
    ctx.fillRect(-11.4, 0, 2, 2.4);
    ctx.fillStyle = off;
    ctx.fillRect(-7.8, 0, 2, 2.4);
    ctx.fillStyle = lit;
    ctx.fillRect(-11.4, 3.6, 2, 2.4);

    // Right annex with flat roof.
    ctx.fillStyle = wallDark;
    ctx.fillRect(8, 0.5, 7, 6.5);
    outline(8, 0.5, 7, 6.5);
    ctx.fillStyle = roof;
    ctx.fillRect(7.5, -1, 8, 1.8);
    ctx.fillStyle = lit;
    ctx.fillRect(9.4, 2.2, 1.9, 2.2);
    ctx.fillStyle = off;
    ctx.fillRect(12.1, 2.2, 1.9, 2.2);

    // Center tower.
    const g = ctx.createLinearGradient(0, -12, 0, 7);
    g.addColorStop(0, wall);
    g.addColorStop(1, wallDark);
    ctx.fillStyle = g;
    ctx.fillRect(-2, -11.5, 9, 18.5);
    outline(-2, -11.5, 9, 18.5);
    ctx.fillStyle = roof;
    ctx.fillRect(-2.7, -13.2, 10.4, 2.2);
    ctx.fillStyle = wallDark;
    ctx.fillRect(0.6, -15, 3.2, 1.8);
    for (let row = 0; row < 3; row++) {
      const wy = -9.4 + row * 3.7;
      ctx.fillStyle = (row + 1) % 3 ? lit : off;
      ctx.fillRect(-0.6, wy, 2, 2.3);
      ctx.fillStyle = row % 2 ? lit : off;
      ctx.fillRect(3, wy, 2, 2.3);
    }
    ctx.fillStyle = '#2c313a';
    ctx.fillRect(1.2, 3.4, 3, 3.6);
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
      const exhausted = u.owner === this.state.turnIdx && unitDone(this.state, u);

      ctx.save();
      ctx.globalAlpha = alpha * (exhausted ? 0.55 : 1);
      ctx.translate(p.x, p.y);
      ctx.lineJoin = 'round';

      // Ground shadow.
      ctx.beginPath();
      ctx.ellipse(0, 9.5, 12.5, 4.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fill();

      // Selection ring.
      if (this.selected === u.id) {
        ctx.beginPath();
        ctx.arc(0, 0, 19, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, 20, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = -(now / 40) % 9;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Body: vector silhouette per unit type (odd-numbered armies face left).
      ctx.save();
      if (u.owner % 2 === 1) ctx.scale(-1, 1);
      drawUnitBody(ctx, u.type, color);
      ctx.restore();

      // HP bar (only when damaged).
      if (u.hp < MAX_HP) {
        const w = 23;
        ctx.beginPath();
        ctx.roundRect(-w / 2 - 1, 10.6, w + 2, 6, 3);
        ctx.fillStyle = 'rgba(8,10,14,0.78)';
        ctx.fill();
        const frac = Math.max(0, u.hp / MAX_HP);
        ctx.beginPath();
        ctx.roundRect(-w / 2, 11.7, w * frac, 3.8, 1.9);
        ctx.fillStyle = u.hp > 6 ? '#22c55e' : u.hp > 3 ? '#eab308' : '#e5484d';
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.beginPath();
        ctx.roundRect(-w / 2, 11.7, w * frac, 1.4, 0.7);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(13, 9.4, 9.5, 8.4, 2.5);
        ctx.fillStyle = 'rgba(8,10,14,0.85)';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 7.5px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(u.hp), 17.7, 13.8);
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
