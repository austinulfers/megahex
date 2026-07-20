// Seeded procedural map generation. Deterministic for a given (seed, radius, players).

import { mulberry32, hashSeed, shuffle, randInt } from './rng.js';
import { key, parseKey, hexRange, ring, hexDist, hexLine, neighbors } from './hex.js';
import { TERRAINS } from './constants.js';

// Returns { radius, tiles: Map<key, {q,r,t,b:null|{type,owner,cap}}>, hqs: [{q,r,owner}] }
export function generateMap(seedStr, radius, numPlayers) {
  const rng = mulberry32(hashSeed(String(seedStr)));
  const center = { q: 0, r: 0 };
  const tiles = new Map();
  for (const h of hexRange(center, radius)) {
    tiles.set(key(h.q, h.r), { q: h.q, r: h.r, t: 'plains', b: null });
  }

  // Terrain blobs.
  const area = tiles.size;
  growBlobs(rng, tiles, radius, 'forest', Math.round(area * 0.16));
  growBlobs(rng, tiles, radius, 'mountain', Math.round(area * 0.09));
  growBlobs(rng, tiles, radius, 'water', Math.round(area * 0.10));

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
  const wanted = Math.max(numPlayers, Math.round(area / 14));
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

function growBlobs(rng, tiles, radius, terrain, targetCount) {
  const keys = [...tiles.keys()];
  let count = 0;
  let guard = 0;
  while (count < targetCount && guard++ < 500) {
    const startKey = keys[Math.floor(rng() * keys.length)];
    const start = tiles.get(startKey);
    if (start.t !== 'plains') continue;
    const blobSize = randInt(rng, 3, 7);
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
