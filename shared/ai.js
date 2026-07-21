// AI opponent decision engine. Pure logic on the shared rules state —
// returns ONE action at a time so the server can pace/animate each step.
// Deterministic for a given game state (stable unit-id ordering).

import { UNIT_TYPES, TERRAINS } from './constants.js';
import { key, parseKey, neighbors, hexDist } from './hex.js';
import {
  movementRange, attackTargets, calcDamage, canBuildAt, tileAt, unitAt,
  unitsOf, buildingsOf, unitDone,
} from './rules.js';

// Unit value used to weigh trades (roughly build cost / 100).
function unitValue(u) {
  return UNIT_TYPES[u.type].cost / 100;
}

// ---------------------------------------------------------------------------
// Movement goals: multi-source Dijkstra over the map from a set of goal hexes,
// weighted by the unit's terrain costs. Returns Map<key, distance>.
// ---------------------------------------------------------------------------
function distanceField(g, moveClass, goalKeys) {
  const dist = new Map();
  const frontier = [];
  for (const k of goalKeys) {
    dist.set(k, 0);
    frontier.push({ k, cost: 0 });
  }
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift();
    if (cur.cost > (dist.get(cur.k) ?? Infinity)) continue;
    const { q, r } = parseKey(cur.k);
    for (const n of neighbors(q, r)) {
      const nk = key(n.q, n.r);
      const t = g.tiles.get(nk);
      if (!t) continue;
      const c = TERRAINS[t.t].cost[moveClass];
      if (c == null) continue;
      const total = cur.cost + c;
      if (total < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, total);
        frontier.push({ k: nk, cost: total });
      }
    }
  }
  return dist;
}

function capturableBuildingKeys(g, idx) {
  const out = [];
  for (const t of g.tiles.values()) {
    if (t.b && t.b.owner !== idx) out.push(key(t.q, t.r));
  }
  return out;
}

function enemyTargetKeys(g, idx) {
  const out = [];
  for (const u of g.units.values()) {
    if (u.owner !== idx) out.push(key(u.q, u.r));
  }
  for (const t of g.tiles.values()) {
    if (t.b && t.b.owner != null && t.b.owner !== idx) out.push(key(t.q, t.r));
  }
  return out;
}

// Best move+attack combo for a unit. Considers staying put and every
// reachable destination (direct-fire only). Returns {score, moveTo?, targetId}
// or null.
function bestAttack(g, u) {
  const ut = UNIT_TYPES[u.type];
  if (u.acted) return null;
  const options = [];

  const evalFrom = (fq, fr, moved) => {
    if (ut.indirect && moved) return; // artillery can't move & fire
    for (const target of attackTargets(g, u, fq, fr)) {
      // Damage math uses attacker hp only, so position change is safe to
      // evaluate without mutating state.
      const dmg = Math.min(calcDamage(g, u, target), target.hp);
      const kills = dmg >= target.hp;
      let counter = 0;
      if (!kills) {
        const tt = UNIT_TYPES[target.type];
        const d = hexDist({ q: fq, r: fr }, target);
        if (!tt.indirect && d >= tt.rangeMin && d <= tt.rangeMax) {
          const meThere = { ...u, q: fq, r: fr }; // defense stars at attack spot
          counter = Math.min(
            calcDamage(g, { ...target, hp: target.hp - dmg }, meThere),
            u.hp
          );
        }
      }
      let score = dmg * unitValue(target) - counter * unitValue(u) * 0.8;
      if (kills) score += 4 + unitValue(target);
      if (counter >= u.hp) score -= 12; // dying on the counter is bad
      if (score <= 0) continue;
      options.push({
        score,
        targetId: target.id,
        moveTo: moved ? { q: fq, r: fr } : null,
      });
    }
  };

  evalFrom(u.q, u.r, false);
  if (!u.moved && !ut.indirect) {
    const { dests } = movementRange(g, u);
    for (const dk of dests) {
      if (dk === key(u.q, u.r)) continue;
      const { q, r } = parseKey(dk);
      evalFrom(q, r, true);
    }
  }
  if (!options.length) return null;
  options.sort((a, b) => b.score - a.score);
  return options[0];
}

// Pick the reachable destination that makes the most progress toward the
// unit's strategic goal. Returns {q,r} or null if no improvement.
function bestAdvance(g, u, field) {
  const ut = UNIT_TYPES[u.type];
  const startK = key(u.q, u.r);
  const here = field.get(startK) ?? Infinity;
  const { dests } = movementRange(g, u);
  let best = null;
  let bestScore = -Infinity;
  for (const dk of dests) {
    if (dk === startK) continue;
    let d = field.get(dk);
    if (d == null) continue;
    // Indirect units want to sit inside firing range, not adjacent.
    if (ut.indirect && d < ut.rangeMin) d = ut.rangeMin + (ut.rangeMin - d);
    const t = g.tiles.get(dk);
    const stars = t.b ? 0 : TERRAINS[t.t].stars; // slight cover preference
    const score = -d + stars * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = dk;
    }
  }
  if (best == null) return null;
  const effHere = ut.indirect && here < ut.rangeMin ? ut.rangeMin + (ut.rangeMin - here) : here;
  if (-effHere >= bestScore) return null; // staying is at least as good
  return parseKey(best);
}

// ---------------------------------------------------------------------------
// Build phase: what to deploy with available gold.
// ---------------------------------------------------------------------------
function chooseUnitType(g, idx) {
  const p = g.players[idx];
  const mine = unitsOf(g, idx);
  const count = (t) => mine.filter((u) => u.type === t).length;
  const infantry = count('INFANTRY');
  const buildings = buildingsOf(g, idx).length;

  // Always keep a capture force.
  if (infantry < 2 && p.gold >= UNIT_TYPES.INFANTRY.cost) return 'INFANTRY';
  if (p.gold >= UNIT_TYPES.TITAN.cost && g.round >= 6) return 'TITAN';
  if (p.gold >= UNIT_TYPES.TANK.cost) {
    // Alternate tanks and artillery for a mixed force.
    return count('TANK') > count('ARTILLERY') && p.gold >= UNIT_TYPES.ARTILLERY.cost
      ? 'ARTILLERY'
      : 'TANK';
  }
  if (p.gold >= UNIT_TYPES.RECON.cost && count('RECON') < 1) return 'RECON';
  if (p.gold >= UNIT_TYPES.INFANTRY.cost && infantry < buildings + 1) return 'INFANTRY';
  return null;
}

function buildAction(g, idx) {
  const type = chooseUnitType(g, idx);
  if (!type) return null;
  // Prefer building at spots closest to the front (nearest enemy target).
  const spots = buildingsOf(g, idx)
    .filter((t) => canBuildAt(g, idx, t.q, t.r))
    .sort((a, b) => key(a.q, a.r) < key(b.q, b.r) ? -1 : 1);
  if (!spots.length) return null;
  const goals = enemyTargetKeys(g, idx);
  let spot = spots[0];
  if (goals.length) {
    let bestD = Infinity;
    for (const s of spots) {
      const d = Math.min(...goals.map((k) => hexDist(s, parseKey(k))));
      if (d < bestD) { bestD = d; spot = s; }
    }
  }
  return { kind: 'build', unitType: type, q: spot.q, r: spot.r };
}

// ---------------------------------------------------------------------------
// nextAiAction: the server calls this repeatedly until it returns endTurn.
// ---------------------------------------------------------------------------
export function nextAiAction(g, idx) {
  if (g.winner != null || g.turnIdx !== idx) return null;

  const units = unitsOf(g, idx).sort((a, b) => a.id - b.id);

  // Cache distance fields per move class (goals differ for capturers).
  const fields = new Map();
  const fieldFor = (u) => {
    const canCap = UNIT_TYPES[u.type].canCapture;
    const cls = UNIT_TYPES[u.type].moveClass;
    const cacheKey = cls + (canCap ? ':cap' : ':war');
    if (!fields.has(cacheKey)) {
      const goals = canCap ? capturableBuildingKeys(g, idx) : enemyTargetKeys(g, idx);
      fields.set(cacheKey, goals.length ? distanceField(g, cls, goals) : new Map());
    }
    return fields.get(cacheKey);
  };

  for (const u of units) {
    if (unitDone(g, u)) continue;
    const ut = UNIT_TYPES[u.type];

    // 1. Standing on an enemy/neutral building? Capture.
    if (!u.acted && ut.canCapture) {
      const t = tileAt(g, u.q, u.r);
      if (t && t.b && t.b.owner !== idx) {
        return { kind: 'capture', unitId: u.id };
      }
    }

    // 2. Worthwhile attack (incl. move+attack)?
    const atk = bestAttack(g, u);
    if (atk) {
      const action = { kind: 'attack', unitId: u.id, targetId: atk.targetId };
      if (atk.moveTo) action.moveTo = atk.moveTo;
      return action;
    }

    // 3. Advance toward goal.
    if (!u.moved) {
      // Capture units: if a capturable building is reachable this turn, take it.
      if (ut.canCapture) {
        const { dests } = movementRange(g, u);
        let grab = null;
        for (const dk of dests) {
          const t = g.tiles.get(dk);
          if (t && t.b && t.b.owner !== idx && dk !== key(u.q, u.r)) {
            if (!grab || (t.b.type === 'hq')) grab = t;
          }
        }
        if (grab) return { kind: 'move', unitId: u.id, q: grab.q, r: grab.r };
      }
      const dest = bestAdvance(g, u, fieldFor(u));
      if (dest) return { kind: 'move', unitId: u.id, q: dest.q, r: dest.r };
    }

    // 4. Nothing useful: mark done so we don't loop on this unit.
    if (!u.acted) return { kind: 'wait', unitId: u.id };
  }

  // All units handled: build, then end turn.
  const b = buildAction(g, idx);
  if (b) return b;
  return { kind: 'endTurn' };
}
