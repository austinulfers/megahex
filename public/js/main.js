// MEGAHEX client entry point: wires net + render + input + ui together.

import * as net from './net.js';
import * as ui from './ui.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { sfx, unlock, isMuted, setMuted } from './sfx.js';
import { fromSnapshot, tileAt, unitAt } from '/shared/rules.js';
import { wireToTiles } from '/shared/mapgen.js';
import { hexToPixel, key } from '/shared/hex.js';
import { PLAYER_COLORS, UNIT_TYPES } from '/shared/constants.js';

const els = ui.els;

// ----- client state -----
let you = -1;
let roomCode = null;
let isHost = false;
let map = null; // {radius, tiles wire}
let shellTiles = null; // Map for fromSnapshot
let snap = null;
let game = null; // reconstructed rules state
let pendingChain = null; // callback fired on next successful update
let lastErrorAt = 0;

const renderer = new Renderer(els.canvas);
const input = new Input(els.canvas, renderer, {
  you: () => you,
  isMyTurn: () => snap && snap.turnIdx === you && snap.winner == null,
  sendAction: (action, chain) => {
    pendingChain = chain || null;
    net.send({ type: 'action', action });
  },
  hideMenus: () => {
    ui.hideActionMenu();
    ui.hideBuildMenu();
  },
  showActionMenu: (q, r, items, onClose) => {
    const p = worldToScreen(q, r);
    ui.showActionMenu(p.x, p.y, items, onClose);
  },
  showBuildMenu: (q, r) => {
    const p = worldToScreen(q, r);
    ui.showBuildMenu(p.x, p.y, snap.players[you].gold, (unitType) => {
      net.send({ type: 'action', action: { kind: 'build', unitType, q, r } });
    });
  },
  updateInfo: (u) => ui.renderUnitInfo(u),
  updateTile: (t) => ui.renderTileInfo(t),
  announce: (text) => ui.announce(text),
});

function worldToScreen(q, r) {
  const w = hexToPixel(q, r, 34);
  return renderer.worldToScreen(w.x, w.y);
}

// ----- render loop -----
function frame() {
  renderer.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));
window.visualViewport?.addEventListener('resize', () => renderer.resize());

// Hover -> tile info.
els.canvas.addEventListener('mousemove', (e) => {
  if (!game) return;
  const rect = els.canvas.getBoundingClientRect();
  const h = input.pickHex(e.clientX, e.clientY);
  const t = tileAt(game, h.q, h.r);
  const visible = !renderer.visible || renderer.visible.has(key(h.q, h.r));
  ui.renderTileInfo(visible ? t : t ? { ...t, b: null } : null);
  const u = visible ? unitAt(game, h.q, h.r) : null;
  if (u && !input.selectedUnit) ui.renderUnitInfo(u);
  else if (!input.selectedUnit && !u) ui.renderUnitInfo(null);
});

// ----- state application -----
function applySnapshot(newSnap, events = []) {
  snap = newSnap;
  if (!shellTiles) return;
  const prevTurn = game?.turnIdx;
  game = fromSnapshot(shellTiles, map.radius, snap);
  renderer.state = game;
  renderer.radius = map.radius;
  renderer.youIdx = you;
  renderer.visible = snap.visible ? new Set(snap.visible) : null;

  playEvents(events, prevTurn);
  ui.renderHud(snap, you);
  input.refresh();

  // Fire chained action (move->capture etc).
  if (pendingChain) {
    const fn = pendingChain;
    pendingChain = null;
    setTimeout(fn, 60);
  }

  if (snap.winner != null) {
    const winnerName = snap.players[snap.winner].name;
    ui.showGameOver(snap.winner === you, winnerName, PLAYER_COLORS[snap.winner]);
    ui.announce(snap.winner === you ? 'Victory! You win.' : `Defeat. ${winnerName} wins.`);
    if (snap.winner === you) sfx.win();
    else sfx.lose();
    setTimeout(() => els.btnBackMenu.focus(), 100);
  }
}

function playEvents(events, prevTurn) {
  for (const e of events) {
    switch (e.type) {
      case 'move': {
        renderer.addAnim({
          type: 'move',
          unitId: e.unitId,
          path: e.path,
          dur: Math.min(700, 130 * Math.max(1, e.path.length - 1)),
        });
        sfx.move();
        break;
      }
      case 'attack': {
        renderer.addAnim({
          type: 'shot',
          from: { q: e.attacker.q, r: e.attacker.r },
          to: { q: e.defender.q, r: e.defender.r },
          dur: 200,
        });
        setTimeout(() => {
          renderer.addAnim({ type: 'boom', q: e.defender.q, r: e.defender.r, dur: 420 });
          renderer.addFloater(e.defender.q, e.defender.r, `-${e.dmg}`, '#ff8589');
          sfx.attack();
        }, 190);
        if (e.counter > 0) {
          setTimeout(() => {
            renderer.addAnim({ type: 'boom', q: e.attacker.q, r: e.attacker.r, dur: 380 });
            renderer.addFloater(e.attacker.q, e.attacker.r, `-${e.counter}`, '#ffd166');
          }, 500);
        }
        for (const d of e.died) {
          setTimeout(() => {
            renderer.addAnim({ type: 'die', unit: d, dur: 500 });
            sfx.destroy();
          }, 420);
        }
        {
          const an = UNIT_TYPES[e.attacker.type].name;
          const dn = UNIT_TYPES[e.defender.type].name;
          let msg = `${an} hit ${dn} for ${e.dmg}.`;
          if (e.counter > 0) msg += ` Counterattack for ${e.counter}.`;
          for (const d of e.died) msg += ` ${UNIT_TYPES[d.type].name} destroyed.`;
          ui.announce(msg);
        }
        break;
      }
      case 'capture': {
        renderer.addFloater(e.q, e.r, `${e.cap} left`, '#eab308');
        sfx.capture();
        break;
      }
      case 'captured': {
        renderer.addAnim({ type: 'flag', q: e.q, r: e.r, color: PLAYER_COLORS[e.owner], dur: 700 });
        renderer.addFloater(e.q, e.r, 'CAPTURED', PLAYER_COLORS[e.owner]);
        sfx.capture();
        break;
      }
      case 'build': {
        renderer.addAnim({ type: 'flag', q: e.unit.q, r: e.unit.r, color: PLAYER_COLORS[e.unit.owner], dur: 450 });
        sfx.build();
        break;
      }
      case 'turn': {
        if (prevTurn !== e.player) {
          const p = snap.players[e.player];
          ui.banner(`${p.name.toUpperCase()}'S TURN`, PLAYER_COLORS[e.player]);
          if (e.player === you) {
            sfx.turn();
            ui.announce(`Your turn. Round ${e.round}. ${snap.players[you].gold} gold.`);
          } else {
            ui.announce(`${p.name}'s turn.`);
          }
          ui.addChat(null, null, `Round ${e.round} — ${p.name}'s turn`, true);
        }
        break;
      }
      case 'eliminated': {
        const p = snap.players[e.player];
        ui.banner(`${p.name.toUpperCase()} ELIMINATED`, '#e5484d', 2000);
        ui.addChat(null, null, `${p.name} has been eliminated!`, true);
        break;
      }
      case 'gameover':
        break;
    }
  }
}

// ----- network handlers -----
net.on('joined', (msg) => {
  you = msg.you;
  roomCode = msg.code;
  isHost = msg.you === 0;
  net.saveSession(msg.code, msg.token);
});

net.on('room', (msg) => {
  roomCode = msg.code;
  if (typeof msg.you === 'number') you = msg.you; // index can shift if lobby players leave
  isHost = you === 0;
  ui.renderLobby(msg, isHost);
  ui.showScreen('lobby');
});

net.on('start', (msg) => {
  you = msg.you;
  roomCode = msg.code;
  net.saveSession(msg.code, msg.token);
  map = msg.map;
  shellTiles = wireToTiles(map.tiles);
  ui.showScreen('game');
  els.gameover.classList.add('hidden');
  renderer.resize();
  applySnapshot(msg.snap, []);
  // Center camera on your HQ.
  const myHq = msg.snap.buildings.find((b) => b.type === 'hq' && b.owner === you);
  if (myHq) renderer.centerOn(myHq.q, myHq.r);
  renderer.fitMap();
  if (myHq) renderer.centerOn(myHq.q, myHq.r);
  ui.addChat(null, null, `Welcome to MEGAHEX. Room ${roomCode}.`, true);
  if (msg.snap.turnIdx === you) ui.banner('YOUR TURN', PLAYER_COLORS[you]);
  ui.announce(
    msg.snap.turnIdx === you
      ? 'Game started. It is your turn. Press N to select your first unit.'
      : `Game started. Waiting for ${msg.snap.players[msg.snap.turnIdx].name}.`
  );
  els.canvas.focus();
});

net.on('update', (msg) => {
  applySnapshot(msg.snap, msg.events || []);
});

net.on('chat', (msg) => {
  ui.addChat(msg.from, msg.color, msg.text);
  sfx.chat();
});

net.on('error', (msg) => {
  pendingChain = null;
  const now = Date.now();
  if (now - lastErrorAt > 400) {
    ui.toast(msg.message, true);
    ui.announce(msg.message);
    sfx.error();
  }
  lastErrorAt = now;
  // Common case: rejoin failed because room is gone.
  if (msg.message === 'Room not found' || msg.message === 'Invalid session') {
    net.clearSession();
  }
});

net.on('_open', () => {
  els.menuError.textContent = '';
});

net.on('_close', () => {
  if (els.screens.game.classList.contains('active')) {
    ui.toast('Connection lost — reconnecting…', true);
  }
});

// ----- menu wiring -----
const savedName = localStorage.getItem('mh_name') || '';
els.name.value = savedName;

function commanderName() {
  const n = els.name.value.trim() || 'Commander';
  localStorage.setItem('mh_name', n);
  return n;
}

els.btnCreate.addEventListener('click', () => {
  unlock();
  if (!net.isOpen()) {
    els.menuError.textContent = 'Connecting to server…';
    return;
  }
  net.clearSession();
  net.send({ type: 'create', name: commanderName() });
});

els.btnJoin.addEventListener('click', joinGame);
els.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinGame();
});

function joinGame() {
  unlock();
  const code = els.code.value.trim().toUpperCase();
  if (code.length !== 5) {
    els.menuError.textContent = 'Enter the 5-letter room code.';
    return;
  }
  if (!net.isOpen()) {
    els.menuError.textContent = 'Connecting to server…';
    return;
  }
  net.clearSession();
  net.send({ type: 'join', code, name: commanderName() });
}

// ----- lobby wiring -----
els.btnCopyCode.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    ui.toast('Room code copied');
  } catch {
    ui.toast(roomCode, false);
  }
});

function pushOptions() {
  net.send({
    type: 'setOptions',
    options: {
      maxPlayers: Number(els.optPlayers.value),
      mapSize: els.optMap.value,
      mapPattern: els.optPattern.value,
      fog: els.optFog.checked,
    },
  });
}
els.optPlayers.addEventListener('change', pushOptions);
els.optMap.addEventListener('change', pushOptions);
els.optPattern.addEventListener('change', pushOptions);
els.optFog.addEventListener('change', pushOptions);

els.btnStart.addEventListener('click', () => {
  unlock();
  net.send({ type: 'start' });
});

els.btnLeave.addEventListener('click', () => {
  location.reload();
});

// ----- game wiring -----
els.btnEndTurn.addEventListener('click', () => {
  input.deselect();
  net.send({ type: 'action', action: { kind: 'endTurn' } });
});

els.btnNextUnit.addEventListener('click', () => {
  input.selectNextReadyUnit();
  els.canvas.focus();
});

function syncMuteButton() {
  const m = isMuted();
  els.btnMute.textContent = m ? 'Sound: Off' : 'Sound: On';
  els.btnMute.setAttribute('aria-pressed', String(m));
}
els.btnMute.addEventListener('click', () => {
  setMuted(!isMuted());
  syncMuteButton();
});
syncMuteButton();

els.btnResign.addEventListener('click', () => {
  if (confirm('Resign and concede the war?')) {
    net.send({ type: 'action', action: { kind: 'resign' } });
  }
});

els.btnBuildCancel.addEventListener('click', () => ui.hideBuildMenu());

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (text) net.send({ type: 'chat', text });
  els.chatInput.value = '';
});

els.btnBackMenu.addEventListener('click', () => {
  net.clearSession();
  location.reload();
});

// Keyboard shortcuts. Hex grid arrow mapping (pointy-top axial):
//   Left/Right = ±q; Up/Down alternate the two diagonal columns based on
//   horizontal modifier state — plain Up/Down favors the straighter diagonal.
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (!els.screens.game.classList.contains('active')) return;
  const inMenu = !els.actionMenu.classList.contains('hidden') ||
    !els.buildMenu.classList.contains('hidden');

  switch (e.key) {
    case 'Escape':
      input.deselect();
      els.canvas.focus();
      break;
    case 'e':
    case 'E':
      if (!els.btnEndTurn.disabled) els.btnEndTurn.click();
      break;
    case 'n':
    case 'N':
      if (!inMenu) input.selectNextReadyUnit();
      break;
    case 'm':
    case 'M':
      els.btnMute.click();
      break;
    case 't':
    case 'T':
      e.preventDefault();
      els.chatInput.focus();
      break;
    case 'ArrowLeft':
      if (!inMenu) { e.preventDefault(); input.moveCursor(-1, 0); }
      break;
    case 'ArrowRight':
      if (!inMenu) { e.preventDefault(); input.moveCursor(1, 0); }
      break;
    case 'ArrowUp':
      if (!inMenu) { e.preventDefault(); input.moveCursor(e.shiftKey ? 1 : 0, -1); }
      break;
    case 'ArrowDown':
      if (!inMenu) { e.preventDefault(); input.moveCursor(e.shiftKey ? -1 : 0, 1); }
      break;
    case 'Enter':
    case ' ':
      if (!inMenu && document.activeElement === els.canvas) {
        e.preventDefault();
        input.activateCursor();
      } else if (!inMenu && e.key === 'Enter') {
        els.chatInput.focus();
      }
      break;
    case '+':
    case '=':
      input.zoomAt(innerWidth / 2, innerHeight / 2, 1.2);
      break;
    case '-':
    case '_':
      input.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2);
      break;
  }
});

// First user gesture unlocks audio.
window.addEventListener('pointerdown', unlock, { once: true });

// Debug/test hook.
window.__mh = {
  input,
  renderer,
  get snap() { return snap; },
  get game() { return game; },
  get you() { return you; },
};

// Go.
net.connect();
