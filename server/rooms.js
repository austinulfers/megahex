// Room / lobby management and game session orchestration.

import { randomBytes } from 'node:crypto';
import { createGame, applyAction, toSnapshot } from '../shared/rules.js';
import { tilesToWire } from '../shared/mapgen.js';
import { MAP_SIZES, PLAYER_COLORS, TURN_SKIP_DISCONNECT_MS } from '../shared/constants.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function makeCode() {
  let s = '';
  const bytes = randomBytes(5);
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

function makeToken() {
  return randomBytes(16).toString('hex');
}

export class Room {
  constructor(code, hostName) {
    this.code = code;
    this.options = { maxPlayers: 2, mapSize: 'medium', fog: false };
    this.players = []; // {name, token, ws|null, idx}
    this.game = null;
    this.mapWire = null;
    this.started = false;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.skipTimer = null;
    this.chatTimes = new Map(); // idx -> [timestamps]
  }

  touch() {
    this.lastActivity = Date.now();
  }

  addPlayer(name, ws) {
    if (this.started) return { error: 'Game already started' };
    if (this.players.length >= this.options.maxPlayers) return { error: 'Room is full' };
    const clean = String(name || '').trim().slice(0, 16) || `Player ${this.players.length + 1}`;
    const player = {
      name: clean,
      token: makeToken(),
      ws,
      idx: this.players.length,
    };
    this.players.push(player);
    this.touch();
    return { player };
  }

  removeLobbyPlayer(idx) {
    if (this.started) return;
    this.players.splice(idx, 1);
    this.players.forEach((p, i) => (p.idx = i));
  }

  findByToken(token) {
    return this.players.find((p) => p.token === token) || null;
  }

  setOptions(opts) {
    if (this.started) return;
    if (opts.maxPlayers != null) {
      const n = Math.floor(Number(opts.maxPlayers));
      if (n >= 2 && n <= 4) this.options.maxPlayers = n;
    }
    if (opts.mapSize != null && MAP_SIZES[opts.mapSize]) {
      this.options.mapSize = opts.mapSize;
    }
    if (opts.fog != null) this.options.fog = !!opts.fog;
  }

  lobbyState() {
    return {
      type: 'room',
      code: this.code,
      started: this.started,
      options: this.options,
      players: this.players.map((p, i) => ({
        name: p.name,
        color: PLAYER_COLORS[i],
        connected: !!p.ws,
        isHost: i === 0,
      })),
    };
  }

  broadcastLobby() {
    const base = this.lobbyState();
    this.players.forEach((p, i) => {
      if (p.ws && p.ws.readyState === 1) {
        p.ws.send(JSON.stringify({ ...base, you: i }));
      }
    });
  }

  start() {
    if (this.started) return { error: 'Already started' };
    if (this.players.length < 2) return { error: 'Need at least 2 players' };
    this.started = true;
    const radius = MAP_SIZES[this.options.mapSize].radius;
    const seed = this.code + '-' + Date.now();
    this.game = createGame({
      seed,
      radius,
      fog: this.options.fog,
      players: this.players.map((p) => ({ name: p.name })),
    });
    this.mapWire = tilesToWire(this.game.tiles);
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === 1) {
        p.ws.send(JSON.stringify(this.startPayload(p.idx)));
      }
    }
    this.armSkipTimerIfNeeded();
    return {};
  }

  startPayload(idx) {
    return {
      type: 'start',
      code: this.code,
      you: idx,
      token: this.players[idx].token,
      options: this.options,
      map: { radius: this.game.radius, tiles: this.mapWire },
      snap: this.snapFor(idx),
    };
  }

  snapFor(idx) {
    const snap = toSnapshot(this.game, idx);
    snap.players = snap.players.map((p, i) => ({
      ...p,
      connected: !!this.players[i].ws,
      isHost: i === 0,
    }));
    return snap;
  }

  // Filter events so fogged players don't learn hidden enemy moves.
  // Simple, safe policy: everyone gets non-positional events; positional
  // events are included for everyone when fog is off, otherwise only the
  // actor and players who can currently see the location get them. Since the
  // fresh snapshot is authoritative, missing an animation is harmless.
  eventsFor(idx, actorIdx, events) {
    if (!this.game.fog) return events;
    if (idx === actorIdx) return events;
    const snap = toSnapshot(this.game, idx);
    const vis = new Set(snap.visible || []);
    return events.filter((e) => {
      if (e.type === 'move') {
        return e.path.some((h) => vis.has(h.q + ',' + h.r));
      }
      if (e.type === 'attack') {
        return (
          vis.has(e.attacker.q + ',' + e.attacker.r) ||
          vis.has(e.defender.q + ',' + e.defender.r)
        );
      }
      if (e.type === 'build') {
        return vis.has(e.unit.q + ',' + e.unit.r);
      }
      if (e.type === 'capture' || e.type === 'captured') {
        return vis.has(e.q + ',' + e.r);
      }
      return true; // turn, eliminated, gameover
    });
  }

  handleAction(playerIdx, action) {
    if (!this.started || !this.game) return { error: 'Game not started' };
    const res = applyAction(this.game, playerIdx, action);
    if (!res.ok) return { error: res.error };
    this.touch();
    this.broadcastUpdate(playerIdx, res.events);
    this.armSkipTimerIfNeeded();
    return {};
  }

  broadcastUpdate(actorIdx, events) {
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === 1) {
        p.ws.send(
          JSON.stringify({
            type: 'update',
            snap: this.snapFor(p.idx),
            events: this.eventsFor(p.idx, actorIdx, events),
          })
        );
      }
    }
  }

  chat(idx, text) {
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    // Rate limit: max 5 messages per 10s per player.
    const now = Date.now();
    const times = (this.chatTimes.get(idx) || []).filter((t) => now - t < 10000);
    if (times.length >= 5) return;
    times.push(now);
    this.chatTimes.set(idx, times);
    const msg = JSON.stringify({
      type: 'chat',
      from: this.players[idx].name,
      color: PLAYER_COLORS[idx],
      text: clean,
    });
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
    }
  }

  onDisconnect(idx) {
    const p = this.players[idx];
    if (p) p.ws = null;
    this.touch();
    if (!this.started) {
      // In lobby: drop the player entirely (host leaving hands host to next).
      this.removeLobbyPlayer(idx);
      this.broadcastLobby();
      return;
    }
    this.broadcastUpdate(-1, []); // refresh connected flags
    this.armSkipTimerIfNeeded();
  }

  onRejoin(token, ws) {
    const p = this.findByToken(token);
    if (!p) return { error: 'Invalid session' };
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.close(4000, 'Replaced by new connection'); } catch {}
    }
    p.ws = ws;
    this.touch();
    if (this.started) {
      ws.send(JSON.stringify(this.startPayload(this.players.indexOf(p))));
      this.broadcastUpdate(-1, []);
      this.armSkipTimerIfNeeded();
    } else {
      this.broadcastLobby();
    }
    return { player: p };
  }

  // If it's a disconnected player's turn, auto end their turn after a grace
  // period so the game can't stall forever.
  armSkipTimerIfNeeded() {
    clearTimeout(this.skipTimer);
    this.skipTimer = null;
    if (!this.started || !this.game || this.game.winner != null) return;
    const cur = this.players[this.game.turnIdx];
    if (cur && !cur.ws) {
      const turnAtArm = { idx: this.game.turnIdx, round: this.game.round };
      this.skipTimer = setTimeout(() => {
        if (!this.game || this.game.winner != null) return;
        if (
          this.game.turnIdx === turnAtArm.idx &&
          this.game.round === turnAtArm.round &&
          !this.players[this.game.turnIdx].ws
        ) {
          const res = applyAction(this.game, this.game.turnIdx, { kind: 'endTurn' });
          if (res.ok) this.broadcastUpdate(this.game.turnIdx, res.events);
          this.armSkipTimerIfNeeded();
        }
      }, TURN_SKIP_DISCONNECT_MS);
    }
  }

  isDead() {
    const anyConnected = this.players.some((p) => p.ws);
    const idleMs = Date.now() - this.lastActivity;
    return !anyConnected && idleMs > 30 * 60 * 1000; // 30 min grace for rejoin
  }

  destroy() {
    clearTimeout(this.skipTimer);
    for (const p of this.players) {
      try { p.ws?.close(); } catch {}
    }
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    // Periodic garbage collection of abandoned rooms.
    this.gc = setInterval(() => {
      for (const [code, room] of this.rooms) {
        if (room.isDead()) {
          room.destroy();
          this.rooms.delete(code);
        }
      }
    }, 60 * 1000);
    this.gc.unref?.();
  }

  create(hostName) {
    let code;
    do {
      code = makeCode();
    } while (this.rooms.has(code));
    const room = new Room(code, hostName);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase()) || null;
  }
}
