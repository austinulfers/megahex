// Seeded procedural map generation. Deterministic for a given (seed, radius, players).

import { mulberry32, hashSeed, shuffle, randInt, pick } from './rng.js';
import { key, parseKey, hexRange, ring, hexDist, hexLine, neighbors } from './hex.js';
import { TERRAINS, MAP_PATTERNS } from './constants.js';

// Returns { radius, tiles: Map<key, {q,r,t,b:null|{type,owner,cap}}>, hqs: [{q,r,owner}] }
export function generateMap(seedStr, radius, numPlayers, pattern = 'classic') {
  const rng = mulberry32(hashSeed(String(seedStr)));
  const center = { q: 0, r: 0 };
  const tiles = new Map();
  for (const h of hexRange(center, radius)) {
    tiles.set(key(h.q, h.r), { q: h.q, r: h.r, t: 'plains', b: null });
  }

  paintTerrain(rng, tiles, radius, MAP_PATTERNS[pattern] ? pattern : 'classic');

  // HQ spots evenly around a ring, jittered start angle.
  const hqRing = ring(center, Math.max(2, radius - 2));
  const offset = randInt(rng, 0, hqRing.length - 1);
  const hqs = [];
  for (let p = 0; p < numPlayers; p++) {
    const idx = (offset + Math.floor((p * hqRing.length) / numPlayers)) % hqRing.length;
    const spot = hqRing[idx];
    hqs.push({ q: spot.q, r: spot.r, owner: p });
  }

  // Clear terrain at & around HQs, place HQ buildings.
  for (const hq of hqs) {
    for (const n of [hq, ...neighbors(hq.q, hq.r)]) {
      const t = tiles.get(key(n.q, n.r));
      if (t) t.t = 'plains';
    }
    const t = tiles.get(key(hq.q, hq.r));
    t.b = { type: 'hq', owner: hq.owner, cap: null };
  }

  // Two starter cities near each HQ.
  for (const hq of hqs) {
    let placed = 0;
    for (const c of shuffle(rng, ring(hq, 2).concat(ring(hq, 1)))) {
      if (placed >= 2) break;
      const t = tiles.get(key(c.q, c.r));
      if (t && !t.b && t.t !== 'water') {
        t.t = 'plains';
        t.b = { type: 'city', owner: null, cap: null };
        placed++;
      }
    }
  }

  // Scattered neutral cities (~1 per 14 tiles), spaced apart.
  const wanted = Math.max(numPlayers, Math.round(tiles.size / 14));
  const candidates = shuffle(rng, [...tiles.values()]);
  let placed = 0;
  for (const t of candidates) {
    if (placed >= wanted) break;
    if (t.b || t.t === 'water' || t.t === 'mountain') continue;
    const tooClose = [...tiles.values()].some(
      (o) => o.b && hexDist(o, t) < 3
    );
    if (tooClose) continue;
    t.b = { type: 'city', owner: null, cap: null };
    placed++;
  }

  ensureConnectivity(tiles, hqs);

  return { radius, tiles, hqs };
}

// Pattern-specific terrain painting. Runs before HQ/city placement, which
// clears landing zones, and before ensureConnectivity, which carves corridors
// through anything that separates the HQs.
function paintTerrain(rng, tiles, radius, pattern) {
  const area = tiles.size;
  const center = { q: 0, r: 0 };
  switch (pattern) {
    case 'archipelago':
      // Island clusters: big water bodies, light forest, few peaks.
      growBlobs(rng, tiles, radius, 'water', Math.round(area * 0.30), 5, 11);
      growBlobs(rng, tiles, radius, 'forest', Math.round(area * 0.12));
      growBlobs(rng, tiles, radius, 'mountain', Math.round(area * 0.04));
      break;
    case 'highlands':
      // Rugged interior: dense mountains and forest, almost no water.
      growBlobs(rng, tiles, radius, 'mountain', Math.round(area * 0.20), 4, 9);
      growBlobs(rng, tiles, radius, 'forest', Math.round(area * 0.20));
      growBlobs(rng, tiles, radius, 'water', Math.round(area * 0.04));
      break;
    case 'rivers': {
      // Winding waterways crossing the map, wooded banks.
      const count = 1 + (radius >= 7 ? 1 : 0) + (radius >= 9 ? 1 : 0);
      for (let i = 0; i < count; i++) carveRiver(rng, tiles, radius);
      growBlobs(rng, tiles, radius, 'forest', Math.round(area * 0.14));
      growBlobs(rng, tiles, radius, 'mountain', Math.round(area * 0.06));
      break;
    }
    case 'crater': {
      // Central lake ringed by mountains; battle happens on the outer band.
      const lakeR = Math.min(radius - 2, Math.max(1, Math.round(radius * 0.4)));
      for (const h of hexRange(center, lakeR)) {
        tiles.get(key(h.q, h.r)).t = 'water';
      }
      for (const h of ring(center, lakeR + 1)) {
        const t = tiles.get(key(h.q, h.r));
        if (t) t.t = 'mountain';
      }
      growBlobs(rng, tiles, radius, 'forest', Math.round(area * 0.12));
      growBlobs(rng, tiles, radius, 'water', Math.round(area * 0.04));
      break;
    }
    default: // classic
      growBlobs(rng, tiles, radius, 'forest', Math.round(area * 0.16));
      growBlobs(rng, tiles, radius, 'mountain', Math.round(area * 0.09));
      growBlobs(rng, tiles, radius, 'water', Math.round(area * 0.10));
  }
}

// Water line from one map edge to roughly the opposite edge, bent through a
// random interior waypoint so it winds instead of running straight.
function carveRiver(rng, tiles, radius) {
  const center = { q: 0, r: 0 };
  const rim = ring(center, radius);
  const i = randInt(rng, 0, rim.length - 1);
  const j = (i + Math.floor(rim.length / 2) + randInt(rng, -radius, radius) + rim.length) % rim.length;
  const mid = pick(rng, hexRange(center, Math.max(1, radius - 2)));
  const points = [rim[i], mid, rim[j]];
  for (let s = 0; s < points.length - 1; s++) {
    for (const h of hexLine(points[s], points[s + 1])) {
      const t = tiles.get(key(h.q, h.r));
      if (t) t.t = 'water';
    }
  }
}

function growBlobs(rng, tiles, radius, terrain, targetCount, minBlob = 3, maxBlob = 7) {
  const keys = [...tiles.keys()];
  let count = 0;
  let guard = 0;
  while (count < targetCount && guard++ < 500) {
    const startKey = keys[Math.floor(rng() * keys.length)];
    const start = tiles.get(startKey);
    if (start.t !== 'plains') continue;
    const blobSize = randInt(rng, minBlob, maxBlob);
    let frontier = [start];
    for (let i = 0; i < blobSize && frontier.length; i++) {
      const idx = Math.floor(rng() * frontier.length);
      const cell = frontier.splice(idx, 1)[0];
      if (cell.t !== 'plains') continue;
      cell.t = terrain;
      count++;
      for (const n of neighbors(cell.q, cell.r)) {
        const t = tiles.get(key(n.q, n.r));
        if (t && t.t === 'plains') frontier.push(t);
      }
    }
  }
}

// Guarantee every HQ can reach every other HQ over tread-passable terrain
// (tread is the most restrictive ground class we must guarantee for tanks).
function ensureConnectivity(tiles, hqs) {
  const passable = (t) => TERRAINS[t.t].cost.tread != null;
  const reach = (from) => {
    const seen = new Set([key(from.q, from.r)]);
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop();
      for (const n of neighbors(cur.q, cur.r)) {
        const k = key(n.q, n.r);
        if (seen.has(k)) continue;
        const t = tiles.get(k);
        if (t && passable(t)) {
          seen.add(k);
          stack.push(t);
        }
      }
    }
    return seen;
  };

  for (let i = 1; i < hqs.length; i++) {
    const seen = reach(hqs[0]);
    if (!seen.has(key(hqs[i].q, hqs[i].r))) {
      // Carve a plains corridor along the hex line.
      for (const h of hexLine(hqs[0], hqs[i])) {
        const t = tiles.get(key(h.q, h.r));
        if (t && !passable(t)) t.t = 'plains';
      }
    }
  }
}

// Serialize tiles for the wire: [{q,r,t}] plus buildings separately in game state.
export function tilesToWire(tiles) {
  return [...tiles.values()].map((t) => ({ q: t.q, r: t.r, t: t.t }));
}

export function wireToTiles(arr) {
  const tiles = new Map();
  for (const t of arr) {
    tiles.set(key(t.q, t.r), { q: t.q, r: t.r, t: t.t, b: null });
  }
  return tiles;
}
