// Axial coordinates, pointy-top hexagons.

export const DIRS = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
];

export function key(q, r) {
  return q + ',' + r;
}

export function parseKey(k) {
  const i = k.indexOf(',');
  return { q: parseInt(k.slice(0, i), 10), r: parseInt(k.slice(i + 1), 10) };
}

export function hexDist(a, b) {
  return (
    (Math.abs(a.q - b.q) +
      Math.abs(a.q + a.r - b.q - b.r) +
      Math.abs(a.r - b.r)) / 2
  );
}

export function neighbors(q, r) {
  return DIRS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

// All hexes within `radius` of center (inclusive).
export function hexRange(center, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const lo = Math.max(-radius, -dq - radius);
    const hi = Math.min(radius, -dq + radius);
    for (let dr = lo; dr <= hi; dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

// Ring of hexes exactly `radius` away from center.
export function ring(center, radius) {
  if (radius === 0) return [{ q: center.q, r: center.r }];
  const out = [];
  let q = center.q + DIRS[4][0] * radius;
  let r = center.r + DIRS[4][1] * radius;
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push({ q, r });
      q += DIRS[side][0];
      r += DIRS[side][1];
    }
  }
  return out;
}

function cubeLerp(a, b, t) {
  return {
    q: a.q + (b.q - a.q) * t,
    r: a.r + (b.r - a.r) * t,
    s: a.s + (b.s - a.s) * t,
  };
}

function cubeRound(c) {
  let q = Math.round(c.q);
  let r = Math.round(c.r);
  let s = Math.round(c.s);
  const dq = Math.abs(q - c.q);
  const dr = Math.abs(r - c.r);
  const ds = Math.abs(s - c.s);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  else s = -q - r;
  return { q, r };
}

// Hexes along the line from a to b (inclusive).
export function hexLine(a, b) {
  const n = hexDist(a, b);
  if (n === 0) return [{ q: a.q, r: a.r }];
  const ac = { q: a.q, r: a.r, s: -a.q - a.r };
  const bc = { q: b.q, r: b.r, s: -b.q - b.r };
  const out = [];
  for (let i = 0; i <= n; i++) {
    out.push(cubeRound(cubeLerp(ac, bc, i / n)));
  }
  return out;
}

// Pointy-top layout.
export function hexToPixel(q, r, size) {
  return {
    x: size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    y: size * (3 / 2) * r,
  };
}

export function pixelToHex(x, y, size) {
  const qf = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const rf = ((2 / 3) * y) / size;
  return cubeRound({ q: qf, r: rf, s: -qf - rf });
}

export function hexCorner(cx, cy, size, i) {
  const angle = (Math.PI / 180) * (60 * i - 30);
  return { x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) };
}
