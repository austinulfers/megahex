// End-to-end protocol smoke test: spins up the real server on a random port,
// drives two WebSocket clients through lobby -> game -> combat -> resign.
// Run: node test/smoke.e2e.mjs

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3170;
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res) => server.stdout.on('data', (d) => {
  if (String(d).includes('running')) res();
}));

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [];
  let wake = null;
  ws.on('message', (raw) => {
    queue.push(JSON.parse(raw.toString()));
    wake?.();
  });
  // Strictly sequential receiver: returns the next message whose type is in
  // `types`, skipping any other message types (chat/etc).
  async function next(types, timeout = 4000) {
    const want = Array.isArray(types) ? types : [types];
    const deadline = Date.now() + timeout;
    for (;;) {
      while (queue.length) {
        const msg = queue.shift();
        if (want.includes(msg.type)) return msg;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${name}: timeout waiting for '${want}'`);
      await new Promise((res) => {
        const t = setTimeout(res, remaining);
        wake = () => { clearTimeout(t); wake = null; res(); };
      });
    }
  }
  return {
    name,
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next,
    open: () => new Promise((res) => ws.once('open', res)),
  };
}

const fail = (msg) => {
  console.error('FAIL:', msg);
  server.kill();
  process.exit(1);
};
const ok = (msg) => console.log('ok –', msg);

try {
  const a = client('alice');
  const b = client('bob');
  await Promise.all([a.open(), b.open()]);

  // Lobby flow.
  a.send({ type: 'create', name: 'Alice', options: { mapSize: 'small' } });
  const joinedA = await a.next('joined');
  if (!/^[A-Z2-9]{5}$/.test(joinedA.code)) fail('bad room code');
  ok(`room created ${joinedA.code}`);

  b.send({ type: 'join', code: joinedA.code, name: 'Bob' });
  await b.next('joined');
  await b.next('room');
  ok('bob joined lobby');

  // Non-host cannot start.
  b.send({ type: 'start' });
  const err = await b.next('error');
  if (!err.message.includes('host')) fail('expected host-only start error');
  ok('non-host start rejected');

  a.send({ type: 'start' });
  const [startA, startB] = await Promise.all([a.next('start'), b.next('start')]);
  if (startA.you !== 0 || startB.you !== 1) fail('bad player indexes');
  if (startA.map.tiles.length === 0) fail('empty map');
  ok(`game started, map ${startA.map.tiles.length} tiles`);

  // Helper: latest snapshot tracking.
  let snapA = startA.snap;
  const myUnits = (snap, who) => snap.units.filter((u) => u.owner === who);

  // Alice builds infantry at her HQ if empty, else just end turn.
  const hqA = snapA.buildings.find((x) => x.type === 'hq' && x.owner === 0);
  const occupied = snapA.units.some((u) => u.q === hqA.q && u.r === hqA.r);
  if (!occupied) {
    a.send({ type: 'action', action: { kind: 'build', unitType: 'INFANTRY', q: hqA.q, r: hqA.r } });
    const upd = await a.next('update');
    await b.next('update');
    if (!upd.events.some((e) => e.type === 'build')) fail('no build event');
    snapA = upd.snap;
    ok('build works');
  }

  // Teleport-free combat test: march Alice's units toward Bob's until an
  // attack lands (server-validated moves only). Cap at 40 turns.
  let attacked = false;
  for (let turn = 0; turn < 40 && !attacked; turn++) {
    // --- Alice's turn ---
    const enemies = snapA.units.filter((u) => u.owner === 1);
    for (const u of myUnits(snapA, 0)) {
      if (u.moved) continue;
      // Try attacking an adjacent enemy first.
      const adj = enemies.find((e) => {
        const d = (Math.abs(u.q - e.q) + Math.abs(u.q + u.r - e.q - e.r) + Math.abs(u.r - e.r)) / 2;
        return d === 1;
      });
      if (adj) {
        a.send({ type: 'action', action: { kind: 'attack', unitId: u.id, targetId: adj.id } });
        const upd = await a.next('update');
        await b.next('update');
        snapA = upd.snap;
        const ev = upd.events.find((e) => e.type === 'attack');
        if (!ev) fail('attack sent but no attack event');
        if (typeof ev.dmg !== 'number' || ev.dmg < 1) fail('bad damage');
        ok(`attack landed for ${ev.dmg} dmg (counter ${ev.counter})`);
        attacked = true;
        break;
      }
      // Otherwise, step toward nearest enemy: try all 6 dirs sorted by distance.
      const target = enemies[0];
      if (!target) break;
      const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]
        .map(([dq, dr]) => ({ q: u.q + dq, r: u.r + dr }))
        .sort((p1, p2) => {
          const d = (p) => (Math.abs(p.q - target.q) + Math.abs(p.q + p.r - target.q - target.r) + Math.abs(p.r - target.r)) / 2;
          return d(p1) - d(p2);
        });
      for (const dscan of dirs) {
        a.send({ type: 'action', action: { kind: 'move', unitId: u.id, q: dscan.q, r: dscan.r } });
        const res = await a.next(['update', 'error']);
        if (res.type === 'update') {
          await b.next('update');
          snapA = res.snap;
          break;
        }
      }
    }
    if (attacked) break;
    a.send({ type: 'action', action: { kind: 'endTurn' } });
    let upd = await a.next('update');
    await b.next('update');
    snapA = upd.snap;

    // --- Bob just ends his turn ---
    b.send({ type: 'action', action: { kind: 'endTurn' } });
    upd = await a.next('update');
    await b.next('update');
    snapA = upd.snap;
  }
  if (!attacked) fail('never managed to attack in 40 turns');

  // Chat.
  b.send({ type: 'chat', text: 'nice shot' });
  const chatA = await a.next('chat');
  if (chatA.from !== 'Bob' || chatA.text !== 'nice shot') fail('chat mismatch');
  ok('chat relays');

  // Resign -> gameover.
  b.send({ type: 'action', action: { kind: 'resign' } });
  const final = await a.next('update');
  if (final.snap.winner !== 0) fail('expected Alice to win after resign');
  if (!final.events.some((e) => e.type === 'gameover')) fail('no gameover event');
  ok('resign ends game, Alice wins');

  // Rejoin flow: reconnect Bob with his token.
  const b2 = client('bob2');
  await b2.open();
  b2.send({ type: 'rejoin', code: joinedA.code, token: startB.token });
  const re = await b2.next('start');
  if (re.you !== 1) fail('rejoin restored wrong seat');
  ok('rejoin restores seat + full state');

  console.log('\nSMOKE TEST PASSED');
  server.kill();
  process.exit(0);
} catch (e) {
  fail(e.message);
}
