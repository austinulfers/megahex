import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../shared/mapgen.js';
import {
  createGame, applyAction, movementRange, calcDamage, toSnapshot,
  unitAt, tileAt, spawnUnit, canBuildAt,
} from '../shared/rules.js';
import { key, hexDist, hexRange, ring, hexLine, pixelToHex, hexToPixel } from '../shared/hex.js';
import { UNIT_TYPES, CAPTURE_MAX, START_GOLD, INCOME_PER_BUILDING, TERRAINS } from '../shared/constants.js';
import { nextAiAction } from '../shared/ai.js';

function newGame(opts = {}) {
  return createGame({
    seed: opts.seed ?? 'test-seed',
    radius: opts.radius ?? 5,
    fog: opts.fog ?? false,
    players: (opts.names ?? ['Alice', 'Bob']).map((name) => ({ name })),
  });
}

// Place a fresh unit on a guaranteed-plains tile for deterministic tests.
function forcePlains(g, q, r) {
  const t = g.tiles.get(key(q, r));
  t.t = 'plains';
  t.b = null;
  return t;
}

test('hex math: distance, range, ring, line, pixel roundtrip', () => {
  assert.equal(hexDist({ q: 0, r: 0 }, { q: 3, r: -1 }), 3);
  assert.equal(hexRange({ q: 0, r: 0 }, 2).length, 19);
  assert.equal(ring({ q: 0, r: 0 }, 3).length, 18);
  const line = hexLine({ q: 0, r: 0 }, { q: 3, r: 0 });
  assert.equal(line.length, 4);
  const px = hexToPixel(4, -2, 24);
  const back = pixelToHex(px.x, px.y, 24);
  assert.deepEqual({ q: back.q, r: back.r }, { q: 4, r: -2 });
});

test('mapgen: deterministic, correct HQ count, HQs connected', () => {
  const a = generateMap('seed-1', 6, 3);
  const b = generateMap('seed-1', 6, 3);
  assert.deepEqual(
    [...a.tiles.values()].map((t) => t.t),
    [...b.tiles.values()].map((t) => t.t)
  );
  assert.equal(a.hqs.length, 3);
  // Every HQ tile has an hq building owned by the right player.
  for (const hq of a.hqs) {
    const t = a.tiles.get(key(hq.q, hq.r));
    assert.equal(t.b.type, 'hq');
    assert.equal(t.b.owner, hq.owner);
  }
  // Different seeds should (almost surely) differ.
  const c = generateMap('seed-2', 6, 3);
  const same = [...a.tiles.values()].every(
    (t, i) => t.t === [...c.tiles.values()][i].t
  );
  assert.equal(same, false);
});

test('mapgen: patterns are deterministic, distinct, and keep HQs connected', () => {
  const patterns = ['classic', 'archipelago', 'highlands', 'rivers', 'crater'];
  const terrainSig = (m) => [...m.tiles.values()].map((t) => t.t).join('');
  const sigs = new Set();
  for (const p of patterns) {
    const a = generateMap('pat-seed', 7, 2, p);
    const b = generateMap('pat-seed', 7, 2, p);
    assert.equal(terrainSig(a), terrainSig(b), `${p} deterministic`);
    sigs.add(terrainSig(a));
    // HQs mutually reachable over tread-passable terrain.
    const passable = (t) => TERRAINS[t.t].cost.tread != null;
    const seen = new Set([key(a.hqs[0].q, a.hqs[0].r)]);
    const stack = [a.hqs[0]];
    while (stack.length) {
      const cur = stack.pop();
      for (const n of [
        { q: cur.q + 1, r: cur.r }, { q: cur.q + 1, r: cur.r - 1 }, { q: cur.q, r: cur.r - 1 },
        { q: cur.q - 1, r: cur.r }, { q: cur.q - 1, r: cur.r + 1 }, { q: cur.q, r: cur.r + 1 },
      ]) {
        const k = key(n.q, n.r);
        if (seen.has(k)) continue;
        const t = a.tiles.get(k);
        if (t && passable(t)) {
          seen.add(k);
          stack.push(n);
        }
      }
    }
    for (const hq of a.hqs) {
      assert.ok(seen.has(key(hq.q, hq.r)), `${p}: HQs connected`);
    }
  }
  assert.equal(sigs.size, patterns.length, 'each pattern yields distinct terrain');
  // Unknown pattern falls back to classic.
  assert.equal(
    terrainSig(generateMap('pat-seed', 7, 2, 'nope')),
    terrainSig(generateMap('pat-seed', 7, 2, 'classic'))
  );
});

test('mapgen: no unreachable land — all foot-passable tiles form one landmass', () => {
  const patterns = ['classic', 'archipelago', 'highlands', 'rivers', 'crater'];
  const footOk = (t) => TERRAINS[t.t].cost.foot != null;
  for (const p of patterns) {
    for (const seed of ['land-a', 'land-b', 'land-c', 'land-d', 'land-e']) {
      for (const radius of [5, 7, 9]) {
        const m = generateMap(seed, radius, 2, p);
        const land = [...m.tiles.values()].filter(footOk);
        // Flood from any land tile; must reach all land.
        const seen = new Set([key(land[0].q, land[0].r)]);
        const stack = [land[0]];
        while (stack.length) {
          const cur = stack.pop();
          for (const n of [
            { q: cur.q + 1, r: cur.r }, { q: cur.q + 1, r: cur.r - 1 }, { q: cur.q, r: cur.r - 1 },
            { q: cur.q - 1, r: cur.r }, { q: cur.q - 1, r: cur.r + 1 }, { q: cur.q, r: cur.r + 1 },
          ]) {
            const k = key(n.q, n.r);
            if (seen.has(k)) continue;
            const t = m.tiles.get(k);
            if (t && footOk(t)) {
              seen.add(k);
              stack.push(t);
            }
          }
        }
        assert.equal(seen.size, land.length, `${p}/${seed}/r${radius}: single landmass`);
      }
    }
  }
});

test('createGame: starting state', () => {
  const g = newGame();
  assert.equal(g.players.length, 2);
  // P0 got first-turn income on top of start gold.
  const p0Buildings = [...g.tiles.values()].filter((t) => t.b?.owner === 0).length;
  assert.equal(g.players[0].gold, START_GOLD + p0Buildings * INCOME_PER_BUILDING);
  assert.equal(g.players[1].gold, START_GOLD);
  // Two starting infantry each.
  const mine = [...g.units.values()].filter((u) => u.owner === 0);
  const theirs = [...g.units.values()].filter((u) => u.owner === 1);
  assert.equal(mine.length, 2);
  assert.equal(theirs.length, 2);
  assert.ok(mine.every((u) => !u.moved && !u.acted));
});

test('movement: range respects terrain costs and blocking', () => {
  const g = newGame();
  // Build a controlled pocket at origin.
  for (const h of hexRange({ q: 0, r: 0 }, 2)) forcePlains(g, h.q, h.r);
  for (const u of [...g.units.values()]) g.units.delete(u.id);
  const inf = spawnUnit(g, 'INFANTRY', 0, 0, 0, false);
  const { dests } = movementRange(g, inf);
  // Infantry move 3 on open plains: all hexes within 3 (that exist) reachable.
  assert.ok(dests.has(key(3, 0)) || dests.has(key(0, 3)) || dests.has(key(-3, 0)));
  assert.ok(!dests.has(key(4, 0)));

  // Water blocks.
  g.tiles.get(key(1, 0)).t = 'water';
  const r2 = movementRange(g, inf);
  assert.ok(!r2.dests.has(key(1, 0)));

  // Enemy blocks pass-through; friendly does not.
  forcePlains(g, 1, 0);
  const enemy = spawnUnit(g, 'INFANTRY', 1, 0, 1, false);
  const r3 = movementRange(g, inf);
  assert.ok(!r3.dests.has(key(0, 1))); // can't stop on enemy
  const friend = spawnUnit(g, 'INFANTRY', 0, 1, 0, false);
  const r4 = movementRange(g, inf);
  assert.ok(!r4.dests.has(key(1, 0))); // can't stop on friend
  assert.ok(r4.dests.has(key(2, 0))); // but can pass through
});

test('move action: applies, exhausts move, rejects invalid', () => {
  const g = newGame();
  for (const h of hexRange({ q: 0, r: 0 }, 3)) forcePlains(g, h.q, h.r);
  for (const u of [...g.units.values()]) g.units.delete(u.id);
  const inf = spawnUnit(g, 'INFANTRY', 0, 0, 0, false);

  const bad = applyAction(g, 1, { kind: 'move', unitId: inf.id, q: 1, r: 0 });
  assert.equal(bad.ok, false); // not their turn

  const far = applyAction(g, 0, { kind: 'move', unitId: inf.id, q: 5, r: 0 });
  assert.equal(far.ok, false);

  const ok = applyAction(g, 0, { kind: 'move', unitId: inf.id, q: 2, r: 0 });
  assert.equal(ok.ok, true);
  assert.equal(unitAt(g, 2, 0).id, inf.id);
  assert.equal(ok.events[0].type, 'move');
  assert.ok(ok.events[0].path.length >= 2);

  const again = applyAction(g, 0, { kind: 'move', unitId: inf.id, q: 1, r: 0 });
  assert.equal(again.ok, false); // already moved
});

test('combat: damage formula, counterattack, kill', () => {
  const g = newGame();
  for (const h of hexRange({ q: 0, r: 0 }, 3)) forcePlains(g, h.q, h.r);
  for (const u of [...g.units.values()]) g.units.delete(u.id);
  const tank = spawnUnit(g, 'TANK', 0, 0, 0, false);
  const inf = spawnUnit(g, 'INFANTRY', 1, 1, 0, false);

  // tank vs infantry on plains: 6 * 1.0 * 1.2 * (1 - .08) = 6.62 -> 7
  assert.equal(calcDamage(g, tank, inf), 7);
  // infantry (10hp) vs tank: 4 * 1.0 * 0.5 * (1 - .24) = 1.52 -> 2
  assert.equal(calcDamage(g, inf, tank), 2);

  const res = applyAction(g, 0, { kind: 'attack', unitId: tank.id, targetId: inf.id });
  assert.equal(res.ok, true);
  const ev = res.events.find((e) => e.type === 'attack');
  assert.equal(ev.dmg, 7);
  assert.equal(inf.hp, 3);
  // Counter from 3hp infantry: 4 * 0.3 * 0.5 * 0.76 = 0.456 -> 1 (min 1)
  assert.equal(ev.counter, 1);
  assert.equal(tank.hp, 9);

  // Finish it: tank already acted, use another tank.
  const tank2 = spawnUnit(g, 'TANK', 0, 2, 0, false);
  const res2 = applyAction(g, 0, { kind: 'attack', unitId: tank2.id, targetId: inf.id });
  assert.equal(res2.ok, true);
  assert.equal(g.units.has(inf.id), false);
  assert.equal(res2.events.find((e) => e.type === 'attack').died.length, 1);
});

test('combat: artillery cannot move-and-fire, no counter received at range', () => {
  const g = newGame();
  for (const h of hexRange({ q: 0, r: 0 }, 4)) forcePlains(g, h.q, h.r);
  for (const u of [...g.units.values()]) g.units.delete(u.id);
  const arty = spawnUnit(g, 'ARTILLERY', 0, 0, 0, false);
  const tank = spawnUnit(g, 'TANK', 1, 2, 0, false);

  // Move-and-fire rejected.
  const mf = applyAction(g, 0, {
    kind: 'attack', unitId: arty.id, targetId: tank.id, moveTo: { q: 1, r: 0 },
  });
  assert.equal(mf.ok, false);

  // Stationary fire at range 2 works, no counter (tank range 1).
  const res = applyAction(g, 0, { kind: 'attack', unitId: arty.id, targetId: tank.id });
  assert.equal(res.ok, true);
  const ev = res.events.find((e) => e.type === 'attack');
  assert.equal(ev.counter, 0);
  assert.equal(arty.hp, 10);

  // Adjacent attacker out of artillery's min range.
  const arty2 = spawnUnit(g, 'ARTILLERY', 0, 1, 0, false);
  const adj = applyAction(g, 0, { kind: 'attack', unitId: arty2.id, targetId: tank.id });
  assert.equal(adj.ok, false);
});

test('capture: chips capture points, flips building, resets when unit leaves', () => {
  const g = newGame();
  for (const h of hexRange({ q: 0, r: 0 }, 3)) forcePlains(g, h.q, h.r);
  for (const u of [...g.units.values()]) g.units.delete(u.id);
  const t = g.tiles.get(key(0, 0));
  t.b = { type: 'city', owner: null, cap: null };
  const inf = spawnUnit(g, 'INFANTRY', 0, 0, 0, false);
  inf.hp = 8;

  const c1 = applyAction(g, 0, { kind: 'capture', unitId: inf.id });
  assert.equal(c1.ok, true);
  assert.equal(t.b.cap, CAPTURE_MAX - 8);
  assert.equal(t.b.owner, null);

  // Next turn cycle back to P0.
  applyAction(g, 0, { kind: 'endTurn' });
  applyAction(g, 1, { kind: 'endTurn' });

  const c2 = applyAction(g, 0, { kind: 'capture', unitId: inf.id });
  assert.equal(c2.ok, true);
  assert.equal(t.b.cap, CAPTURE_MAX - 16);

  // Leave: capture progress resets.
  applyAction(g, 0, { kind: 'endTurn' });
  applyAction(g, 1, { kind: 'endTurn' });
  applyAction(g, 0, { kind: 'move', unitId: inf.id, q: 1, r: 0 });
  assert.equal(t.b.cap, null);

  // Full capture flips ownership.
  applyAction(g, 0, { kind: 'endTurn' });
  applyAction(g, 1, { kind: 'endTurn' });
  applyAction(g, 0, { kind: 'move', unitId: inf.id, q: 0, r: 0 });
  inf.hp = 10;
  inf.acted = false;
  applyAction(g, 0, { kind: 'capture', unitId: inf.id });
  applyAction(g, 0, { kind: 'endTurn' });
  applyAction(g, 1, { kind: 'endTurn' });
  const c3 = applyAction(g, 0, { kind: 'capture', unitId: inf.id });
  assert.equal(c3.ok, true);
  assert.equal(t.b.owner, 0);
  assert.ok(c3.events.some((e) => e.type === 'captured'));
});

test('endTurn auto-captures with unexhausted units on capturable tiles', () => {
  const g = newGame();
  for (const h of hexRange({ q: 0, r: 0 }, 3)) forcePlains(g, h.q, h.r);
  for (const u of [...g.units.values()]) g.units.delete(u.id);
  const t = g.tiles.get(key(0, 0));
  t.b = { type: 'city', owner: null, cap: null };
  const inf = spawnUnit(g, 'INFANTRY', 0, 0, 0, false);
  inf.hp = 8;

  // End turn without an explicit capture: unit auto-captures.
  const e1 = applyAction(g, 0, { kind: 'endTurn' });
  assert.equal(e1.ok, true);
  assert.ok(e1.events.some((e) => e.type === 'capture'));
  assert.equal(t.b.cap, CAPTURE_MAX - 8);

  applyAction(g, 1, { kind: 'endTurn' });

  // Exhausted units are not auto-captured again within the same endTurn.
  applyAction(g, 0, { kind: 'capture', unitId: inf.id });
  const capAfter = t.b.cap;
  const e2 = applyAction(g, 0, { kind: 'endTurn' });
  assert.ok(!e2.events.some((e) => e.type === 'capture' || e.type === 'captured'));
  assert.equal(t.b.cap, capAfter);

  applyAction(g, 1, { kind: 'endTurn' });

  // Auto-capture can complete the flip.
  inf.hp = 10;
  const e3 = applyAction(g, 0, { kind: 'endTurn' });
  assert.ok(e3.events.some((e) => e.type === 'captured'));
  assert.equal(t.b.owner, 0);
});

test('HQ capture eliminates the owner and ends a 2p game', () => {
  const g = newGame();
  const hqTile = [...g.tiles.values()].find((t) => t.b?.type === 'hq' && t.b.owner === 1);
  // Clear any defender and park a fresh P0 infantry on the HQ.
  const occ = unitAt(g, hqTile.q, hqTile.r);
  if (occ) g.units.delete(occ.id);
  const inf = spawnUnit(g, 'INFANTRY', 0, hqTile.q, hqTile.r, false);

  const c1 = applyAction(g, 0, { kind: 'capture', unitId: inf.id });
  assert.equal(c1.ok, true);
  applyAction(g, 0, { kind: 'endTurn' });
  applyAction(g, 1, { kind: 'endTurn' });
  const c2 = applyAction(g, 0, { kind: 'capture', unitId: inf.id });
  assert.equal(c2.ok, true);

  assert.equal(g.players[1].alive, false);
  assert.equal(g.winner, 0);
  assert.equal(hqTile.b.type, 'city'); // HQ demoted
  assert.equal(hqTile.b.owner, 0);
  // Loser's units removed.
  assert.ok([...g.units.values()].every((u) => u.owner !== 1));
});

test('build: spends gold, spawns exhausted unit, validates placement', () => {
  const g = newGame();
  const hq = [...g.tiles.values()].find((t) => t.b?.type === 'hq' && t.b.owner === 0);
  const occ = unitAt(g, hq.q, hq.r);
  if (occ) g.units.delete(occ.id);

  assert.equal(canBuildAt(g, 0, hq.q, hq.r), true);
  const goldBefore = g.players[0].gold;
  const res = applyAction(g, 0, {
    kind: 'build', unitType: 'TANK', q: hq.q, r: hq.r,
  });
  assert.equal(res.ok, true);
  assert.equal(g.players[0].gold, goldBefore - UNIT_TYPES.TANK.cost);
  const u = unitAt(g, hq.q, hq.r);
  assert.equal(u.type, 'TANK');
  assert.ok(u.moved && u.acted);

  // Occupied now.
  const res2 = applyAction(g, 0, { kind: 'build', unitType: 'INFANTRY', q: hq.q, r: hq.r });
  assert.equal(res2.ok, false);

  // Can't afford Titan spam.
  g.players[0].gold = 100;
  const res3 = applyAction(g, 0, { kind: 'build', unitType: 'TITAN', q: hq.q, r: hq.r });
  assert.equal(res3.ok, false);
});

test('endTurn: rotates, pays income, refreshes units', () => {
  const g = newGame();
  const u0 = [...g.units.values()].find((u) => u.owner === 0);
  applyAction(g, 0, { kind: 'wait', unitId: u0.id });
  assert.ok(u0.moved && u0.acted);

  const p1GoldBefore = g.players[1].gold;
  const p1Buildings = [...g.tiles.values()].filter((t) => t.b?.owner === 1).length;
  const res = applyAction(g, 0, { kind: 'endTurn' });
  assert.equal(res.ok, true);
  assert.equal(g.turnIdx, 1);
  assert.equal(g.players[1].gold, p1GoldBefore + p1Buildings * INCOME_PER_BUILDING);

  applyAction(g, 1, { kind: 'endTurn' });
  assert.equal(g.turnIdx, 0);
  assert.equal(g.round, 2);
  assert.ok(!u0.moved && !u0.acted); // refreshed
});

test('resign: eliminates and declares winner in 2p', () => {
  const g = newGame();
  const res = applyAction(g, 1, { kind: 'resign' });
  assert.equal(res.ok, true);
  assert.equal(g.players[1].alive, false);
  assert.equal(g.winner, 0);
});

test('fog: snapshot hides unseen enemy units, off shows all', () => {
  const g = newGame({ fog: true, radius: 6 });
  // Move all P1 units far from P0 sight (park them on P1's HQ corner).
  const p1hq = [...g.tiles.values()].find((t) => t.b?.type === 'hq' && t.b.owner === 1);
  for (const u of [...g.units.values()].filter((u) => u.owner === 1)) {
    u.q = p1hq.q;
    u.r = p1hq.r;
    break; // just ensure at least one is at a known far spot
  }
  const snap0 = toSnapshot(g, 0);
  assert.ok(Array.isArray(snap0.visible));
  // All own units present.
  assert.equal(snap0.units.filter((u) => u.owner === 0).length, 2);
  // Any enemy unit present must be on a visible hex.
  for (const u of snap0.units.filter((u) => u.owner === 1)) {
    assert.ok(snap0.visible.includes(key(u.q, u.r)));
  }
  // Fog off: everything visible.
  const g2 = newGame({ fog: false });
  const snapAll = toSnapshot(g2, 0);
  assert.equal(snapAll.visible, null);
  assert.equal(snapAll.units.length, 4);
});

test('wire snapshot roundtrip preserves counts', () => {
  const g = newGame();
  const snap = toSnapshot(g, null);
  assert.equal(snap.units.length, [...g.units.values()].length);
  assert.equal(
    snap.buildings.length,
    [...g.tiles.values()].filter((t) => t.b).length
  );
  assert.equal(typeof snap.turnIdx, 'number');
});

// ---------------------------------------------------------------------------
// AI opponent
// ---------------------------------------------------------------------------

// Drive one full AI turn; returns number of actions taken.
function runAiTurn(g, idx) {
  let steps = 0;
  while (g.turnIdx === idx && g.winner == null && steps < 400) {
    const action = nextAiAction(g, idx) ?? { kind: 'endTurn' };
    const res = applyAction(g, idx, action);
    assert.equal(res.ok, true, `AI action failed: ${action.kind} — ${res.error}`);
    steps++;
  }
  return steps;
}

test('ai: every proposed action is legal and the turn terminates', () => {
  const g = newGame({ seed: 'ai-legal' });
  const steps = runAiTurn(g, 0);
  assert.ok(steps > 0 && steps < 400);
  assert.equal(g.turnIdx, 1); // turn was ended
});

test('ai: takes an obvious kill', () => {
  const g = newGame({ seed: 'ai-kill' });
  const me = [...g.units.values()].find((u) => u.owner === 0);
  forcePlains(g, me.q, me.r);
  // Weak enemy right next door.
  const nb = [...g.tiles.values()].find(
    (t) => hexDist(t, me) === 1 && TERRAINS[t.t].cost.foot != null && !unitAt(g, t.q, t.r)
  );
  forcePlains(g, nb.q, nb.r);
  const victim = spawnUnit(g, 'INFANTRY', 1, nb.q, nb.r, false);
  victim.hp = 1;

  let killed = false;
  let guard = 0;
  while (g.turnIdx === 0 && guard++ < 400) {
    const action = nextAiAction(g, 0) ?? { kind: 'endTurn' };
    const res = applyAction(g, 0, action);
    assert.equal(res.ok, true);
    if (action.kind === 'attack' && action.targetId === victim.id) killed = true;
  }
  assert.equal(killed, true);
  assert.equal(g.units.has(victim.id), false);
});

test('ai vs ai: full game reaches a winner', () => {
  const g = newGame({ seed: 'ai-duel', radius: 4 });
  let rounds = 0;
  while (g.winner == null && rounds < 2000) {
    runAiTurn(g, g.turnIdx);
    rounds++;
  }
  assert.notEqual(g.winner, null, 'AI vs AI game should finish');
});
