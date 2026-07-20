// Authoritative game rules engine. Pure logic — no I/O. Used by server,
// and by the client for move-range previews & damage forecasts.

import {
  UNIT_TYPES, TERRAINS, BUILDINGS, DMG_MULT, MAX_HP, CAPTURE_MAX,
  INCOME_PER_BUILDING, START_GOLD, BUILDING_SIGHT,
} from './constants.js';
import { key, parseKey, neighbors, hexDist, hexRange } from './hex.js';
import { generateMap } from './mapgen.js';

export function createGame({ seed, radius, players, fog = false, pattern = 'classic' }) {
  const map = generateMap(seed, radius, players.length, pattern);
  const g = {
    seed,
    radius,
    fog,
    nextUnitId: 1,
    tiles: map.tiles, // Map<key,{q,r,t,b}>
    players: players.map((p, i) => ({
      idx: i,
      name: p.name,
      gold: START_GOLD,
      alive: true,
    })),
    units: new Map(), // id -> unit
    turnIdx: 0,
    round: 1,
    winner: null,
  };

  // Starting units: two infantry adjacent to each HQ.
  for (const hq of map.hqs) {
    let spawned = 0;
    for (const n of neighbors(hq.q, hq.r)) {
      if (spawned >= 2) break;
      const t = g.tiles.get(key(n.q, n.r));
      if (t && TERRAINS[t.t].cost.foot != null && !unitAt(g, n.q, n.r)) {
        spawnUnit(g, 'INFANTRY', hq.owner, n.q, n.r, false);
        spawned++;
      }
    }
  }

  beginTurn(g); // first player income + fresh flags
  return g;
}

export function spawnUnit(g, type, owner, q, r, exhausted = true) {
  const u = {
    id: g.nextUnitId++,
    type,
    owner,
    q,
    r,
    hp: MAX_HP,
    moved: exhausted,
    acted: exhausted,
  };
  g.units.set(u.id, u);
  return u;
}

export function unitAt(g, q, r) {
  for (const u of g.units.values()) if (u.q === q && u.r === r) return u;
  return null;
}

export function tileAt(g, q, r) {
  return g.tiles.get(key(q, r)) || null;
}

function moveCost(unit, tile) {
  const cls = UNIT_TYPES[unit.type].moveClass;
  return TERRAINS[tile.t].cost[cls]; // null = impassable
}

// Dijkstra flood: reachable hexes within movement points.
// May pass through friendly units, never enemies; cannot stop on any unit.
export function movementRange(g, unit) {
  const start = key(unit.q, unit.r);
  const mv = UNIT_TYPES[unit.type].move;
  const best = new Map([[start, 0]]);
  const frontier = [{ k: start, cost: 0 }];
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift();
    if (cur.cost > (best.get(cur.k) ?? Infinity)) continue;
    const { q, r } = parseKey(cur.k);
    for (const n of neighbors(q, r)) {
      const t = g.tiles.get(key(n.q, n.r));
      if (!t) continue;
      const c = moveCost(unit, t);
      if (c == null) continue;
      const total = cur.cost + c;
      if (total > mv) continue;
      const occ = unitAt(g, n.q, n.r);
      if (occ && occ.owner !== unit.owner) continue; // enemies block
      const k = key(n.q, n.r);
      if (total < (best.get(k) ?? Infinity)) {
        best.set(k, total);
        frontier.push({ k, cost: total });
      }
    }
  }
  // Destinations: cannot stop on another unit (may remain in place).
  const dests = new Set();
  for (const k of best.keys()) {
    const { q, r } = parseKey(k);
    const occ = unitAt(g, q, r);
    if (!occ || occ.id === unit.id) dests.add(k);
  }
  return { dests, costs: best };
}

// Shortest path within the computed range (for animation).
export function pathTo(g, unit, destKey) {
  const { costs } = movementRange(g, unit);
  if (!costs.has(destKey)) return null;
  // Walk backwards from dest: predecessor n satisfies
  // cost(n) + entryCost(currentTile) === cost(current).
  let cur = destKey;
  const path = [parseKey(cur)];
  const start = key(unit.q, unit.r);
  let guard = 0;
  while (cur !== start && guard++ < 500) {
    const { q, r } = parseKey(cur);
    const curCost = costs.get(cur);
    const entry = moveCost(unit, g.tiles.get(cur));
    let bestN = null;
    for (const n of neighbors(q, r)) {
      const nk = key(n.q, n.r);
      if (!costs.has(nk)) continue;
      if (entry != null && Math.abs(costs.get(nk) + entry - curCost) < 1e-9) {
        if (bestN == null || costs.get(nk) < costs.get(bestN)) bestN = nk;
      }
    }
    if (!bestN) break;
    cur = bestN;
    path.push(parseKey(cur));
  }
  path.reverse();
  return path;
}

export function defenseStars(g, unit) {
  const t = tileAt(g, unit.q, unit.r);
  if (!t) return 0;
  if (t.b) return BUILDINGS[t.b.type].stars;
  return TERRAINS[t.t].stars;
}

export function calcDamage(g, attacker, defender) {
  const a = UNIT_TYPES[attacker.type];
  const d = UNIT_TYPES[defender.type];
  const mult = DMG_MULT[attacker.type][defender.type];
  const stars = defenseStars(g, defender);
  const raw =
    a.atk * (attacker.hp / MAX_HP) * mult * (1 - 0.08 * d.def - 0.1 * stars);
  if (raw <= 0) return 0;
  return Math.max(1, Math.round(raw));
}

export function attackTargets(g, unit, fromQ = unit.q, fromR = unit.r) {
  const t = UNIT_TYPES[unit.type];
  const out = [];
  for (const other of g.units.values()) {
    if (other.owner === unit.owner) continue;
    const dist = hexDist({ q: fromQ, r: fromR }, other);
    if (dist >= t.rangeMin && dist <= t.rangeMax) out.push(other);
  }
  return out;
}

// True when a unit has spent its movement and has no action left this turn
// (i.e. it should be shown as exhausted, like one that just attacked/captured).
export function unitDone(g, unit) {
  if (!unit.moved) return false; // movement still available
  if (unit.acted) return true; // already used both move and action
  const ut = UNIT_TYPES[unit.type];
  // Remaining attack from current tile (indirect units cannot fire after moving).
  if (!ut.indirect && attackTargets(g, unit).length > 0) return false;
  // Remaining capture on the current tile.
  if (ut.canCapture) {
    const t = tileAt(g, unit.q, unit.r);
    if (t && t.b && t.b.owner !== unit.owner) return false;
  }
  return true; // moved but nothing left to do
}

export function canBuildAt(g, playerIdx, q, r) {
  const t = tileAt(g, q, r);
  if (!t || !t.b) return false;
  if (t.b.owner !== playerIdx) return false;
  if (!(t.b.type === 'hq' || t.b.type === 'city')) return false;
  if (unitAt(g, q, r)) return false;
  return true;
}

export function buildingsOf(g, playerIdx) {
  const out = [];
  for (const t of g.tiles.values()) {
    if (t.b && t.b.owner === playerIdx) out.push(t);
  }
  return out;
}

export function unitsOf(g, playerIdx) {
  return [...g.units.values()].filter((u) => u.owner === playerIdx);
}

function beginTurn(g) {
  const p = g.players[g.turnIdx];
  p.gold += buildingsOf(g, p.idx).length * INCOME_PER_BUILDING;
  for (const u of unitsOf(g, p.idx)) {
    u.moved = false;
    u.acted = false;
  }
}

// If a capturing infantry left the tile or died, reset partial capture.
function normalizeCaptures(g) {
  for (const t of g.tiles.values()) {
    if (t.b && t.b.cap != null) {
      const u = unitAt(g, t.q, t.r);
      if (!u || !UNIT_TYPES[u.type].canCapture || (t.b.owner === u.owner)) {
        t.b.cap = null;
      }
    }
  }
}

function eliminate(g, playerIdx, events) {
  const p = g.players[playerIdx];
  if (!p.alive) return;
  p.alive = false;
  for (const u of [...g.units.values()]) {
    if (u.owner === playerIdx) g.units.delete(u.id);
  }
  for (const t of g.tiles.values()) {
    if (t.b && t.b.owner === playerIdx) {
      t.b.owner = null;
      t.b.cap = null;
      if (t.b.type === 'hq') t.b.type = 'city';
    }
  }
  events.push({ type: 'eliminated', player: playerIdx });
  checkWinner(g, events);
}

function checkWinner(g, events) {
  const alive = g.players.filter((p) => p.alive);
  if (alive.length === 1 && g.winner == null) {
    g.winner = alive[0].idx;
    events.push({ type: 'gameover', winner: g.winner });
  }
}

function checkAttrition(g, events) {
  for (const p of g.players) {
    if (!p.alive) continue;
    if (unitsOf(g, p.idx).length === 0 && buildingsOf(g, p.idx).length === 0) {
      eliminate(g, p.idx, events);
    }
  }
}

// ---------------------------------------------------------------------------
// applyAction: the single entry point for all game mutations.
// Returns { ok, error?, events: [] }
// ---------------------------------------------------------------------------
export function applyAction(g, playerIdx, action) {
  const events = [];
  const fail = (error) => ({ ok: false, error, events: [] });

  if (g.winner != null) return fail('Game is over');
  if (playerIdx !== g.turnIdx && action.kind !== 'resign') {
    return fail('Not your turn');
  }
  const player = g.players[playerIdx];
  if (!player || !player.alive) return fail('You are eliminated');

  switch (action.kind) {
    case 'move': {
      const u = g.units.get(action.unitId);
      if (!u || u.owner !== playerIdx) return fail('Not your unit');
      if (u.moved) return fail('Unit already moved');
      const dk = key(action.q, action.r);
      if (dk === key(u.q, u.r)) return fail('Already there');
      const { dests } = movementRange(g, u);
      if (!dests.has(dk)) return fail('Destination out of range');
      const path = pathTo(g, u, dk) || [{ q: u.q, r: u.r }, { q: action.q, r: action.r }];
      u.q = action.q;
      u.r = action.r;
      u.moved = true;
      // Indirect units cannot move and fire.
      if (UNIT_TYPES[u.type].indirect) u.acted = true;
      normalizeCaptures(g);
      events.push({ type: 'move', unitId: u.id, path });
      break;
    }

    case 'attack': {
      const u = g.units.get(action.unitId);
      if (!u || u.owner !== playerIdx) return fail('Not your unit');
      if (u.acted) return fail('Unit already acted');
      const target = g.units.get(action.targetId);
      if (!target || target.owner === playerIdx) return fail('Invalid target');
      const ut = UNIT_TYPES[u.type];

      // Optional move-then-attack for direct-fire units.
      if (action.moveTo) {
        if (u.moved) return fail('Unit already moved');
        if (ut.indirect) return fail('Indirect units cannot move and fire');
        const dk = key(action.moveTo.q, action.moveTo.r);
        if (dk !== key(u.q, u.r)) {
          const { dests } = movementRange(g, u);
          if (!dests.has(dk)) return fail('Destination out of range');
          const path = pathTo(g, u, dk) || [{ q: u.q, r: u.r }, action.moveTo];
          u.q = action.moveTo.q;
          u.r = action.moveTo.r;
          events.push({ type: 'move', unitId: u.id, path });
        }
        u.moved = true;
        normalizeCaptures(g);
      }

      const dist = hexDist(u, target);
      if (dist < ut.rangeMin || dist > ut.rangeMax) return fail('Target out of range');
      if (ut.indirect && u.moved) return fail('Indirect units cannot move and fire');

      const dmg = calcDamage(g, u, target);
      target.hp -= dmg;
      let counter = 0;
      const died = [];
      if (target.hp <= 0) {
        died.push({ id: target.id, type: target.type, owner: target.owner, q: target.q, r: target.r });
        g.units.delete(target.id);
      } else {
        const tt = UNIT_TYPES[target.type];
        const cd = hexDist(u, target);
        if (!tt.indirect && cd >= tt.rangeMin && cd <= tt.rangeMax) {
          counter = calcDamage(g, target, u);
          u.hp -= counter;
          if (u.hp <= 0) {
            died.push({ id: u.id, type: u.type, owner: u.owner, q: u.q, r: u.r });
            g.units.delete(u.id);
          }
        }
      }
      u.moved = true;
      u.acted = true;
      normalizeCaptures(g);
      events.push({
        type: 'attack',
        attacker: { id: u.id, type: u.type, owner: u.owner, q: u.q, r: u.r },
        defender: {
          id: target.id, type: target.type, owner: target.owner,
          q: target.q, r: target.r, hpAfter: Math.max(0, target.hp),
        },
        dmg,
        counter,
        died,
      });
      checkAttrition(g, events);
      break;
    }

    case 'capture': {
      const u = g.units.get(action.unitId);
      if (!u || u.owner !== playerIdx) return fail('Not your unit');
      if (u.acted) return fail('Unit already acted');
      if (!UNIT_TYPES[u.type].canCapture) return fail('Unit cannot capture');
      const t = tileAt(g, u.q, u.r);
      if (!t || !t.b) return fail('No building here');
      if (t.b.owner === playerIdx) return fail('Already yours');
      if (t.b.cap == null) t.b.cap = CAPTURE_MAX;
      t.b.cap -= u.hp;
      u.moved = true;
      u.acted = true;
      if (t.b.cap <= 0) {
        const prevOwner = t.b.owner;
        const wasHq = t.b.type === 'hq';
        t.b.owner = playerIdx;
        t.b.cap = null;
        if (wasHq) t.b.type = 'city';
        events.push({ type: 'captured', q: t.q, r: t.r, owner: playerIdx, building: t.b.type });
        if (wasHq && prevOwner != null) eliminate(g, prevOwner, events);
      } else {
        events.push({ type: 'capture', q: t.q, r: t.r, cap: t.b.cap });
      }
      break;
    }

    case 'build': {
      const type = UNIT_TYPES[action.unitType] ? action.unitType : null;
      if (!type) return fail('Unknown unit type');
      if (!canBuildAt(g, playerIdx, action.q, action.r)) return fail('Cannot build there');
      const cost = UNIT_TYPES[type].cost;
      if (player.gold < cost) return fail('Not enough gold');
      player.gold -= cost;
      const u = spawnUnit(g, type, playerIdx, action.q, action.r, true);
      events.push({
        type: 'build',
        unit: { id: u.id, type: u.type, owner: u.owner, q: u.q, r: u.r },
      });
      break;
    }

    case 'wait': {
      const u = g.units.get(action.unitId);
      if (!u || u.owner !== playerIdx) return fail('Not your unit');
      u.moved = true;
      u.acted = true;
      break;
    }

    case 'endTurn': {
      let guard = 0;
      do {
        g.turnIdx = (g.turnIdx + 1) % g.players.length;
        if (g.turnIdx === 0) g.round++;
      } while (!g.players[g.turnIdx].alive && guard++ < 8);
      beginTurn(g);
      events.push({ type: 'turn', player: g.turnIdx, round: g.round });
      break;
    }

    case 'resign': {
      eliminate(g, playerIdx, events);
      if (g.winner == null && g.turnIdx === playerIdx) {
        let guard = 0;
        do {
          g.turnIdx = (g.turnIdx + 1) % g.players.length;
          if (g.turnIdx === 0) g.round++;
        } while (!g.players[g.turnIdx].alive && guard++ < 8);
        beginTurn(g);
        events.push({ type: 'turn', player: g.turnIdx, round: g.round });
      }
      break;
    }

    default:
      return fail('Unknown action');
  }

  return { ok: true, events };
}

// ---------------------------------------------------------------------------
// Visibility / fog of war
// ---------------------------------------------------------------------------
export function visibleKeys(g, playerIdx) {
  const vis = new Set();
  for (const u of unitsOf(g, playerIdx)) {
    for (const h of hexRange(u, UNIT_TYPES[u.type].sight)) {
      vis.add(key(h.q, h.r));
    }
  }
  for (const t of buildingsOf(g, playerIdx)) {
    for (const h of hexRange(t, BUILDING_SIGHT)) {
      vis.add(key(h.q, h.r));
    }
  }
  return vis;
}

// Snapshot for one player (applies fog filtering when enabled).
export function toSnapshot(g, forPlayerIdx = null) {
  const fogOn = g.fog && forPlayerIdx != null && g.winner == null;
  const vis = fogOn ? visibleKeys(g, forPlayerIdx) : null;
  const units = [];
  for (const u of g.units.values()) {
    if (fogOn && u.owner !== forPlayerIdx && !vis.has(key(u.q, u.r))) continue;
    units.push({
      id: u.id, type: u.type, owner: u.owner,
      q: u.q, r: u.r, hp: u.hp, moved: u.moved, acted: u.acted,
    });
  }
  const buildings = [];
  for (const t of g.tiles.values()) {
    if (t.b) {
      buildings.push({ q: t.q, r: t.r, type: t.b.type, owner: t.b.owner, cap: t.b.cap });
    }
  }
  return {
    players: g.players.map((p) => ({
      name: p.name, gold: p.gold, alive: p.alive,
    })),
    turnIdx: g.turnIdx,
    round: g.round,
    winner: g.winner,
    fog: g.fog,
    units,
    buildings,
    visible: vis ? [...vis] : null,
  };
}

// Client-side reconstruction: merge a snapshot into a local game shell so
// shared rules (movementRange, calcDamage) work for previews.
export function fromSnapshot(shellTiles, radius, snap) {
  const g = {
    radius,
    fog: snap.fog,
    tiles: shellTiles,
    players: snap.players.map((p, i) => ({ idx: i, ...p })),
    units: new Map(),
    turnIdx: snap.turnIdx,
    round: snap.round,
    winner: snap.winner,
  };
  for (const t of g.tiles.values()) t.b = null;
  for (const b of snap.buildings) {
    const t = g.tiles.get(key(b.q, b.r));
    if (t) t.b = { type: b.type, owner: b.owner, cap: b.cap };
  }
  for (const u of snap.units) g.units.set(u.id, { ...u });
  return g;
}
