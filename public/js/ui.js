// DOM UI: screens, lobby, HUD, popups, chat, toasts.

import { PLAYER_COLORS, UNIT_TYPES, TERRAINS, BUILDINGS, MAP_SIZES } from '/shared/constants.js';

const $ = (sel) => document.querySelector(sel);

export const els = {
  screens: {
    menu: $('#screen-menu'),
    lobby: $('#screen-lobby'),
    game: $('#screen-game'),
  },
  name: $('#input-name'),
  code: $('#input-code'),
  btnCreate: $('#btn-create'),
  btnJoin: $('#btn-join'),
  menuError: $('#menu-error'),

  lobbyCode: $('#lobby-code'),
  btnCopyCode: $('#btn-copy-code'),
  lobbyPlayers: $('#lobby-players'),
  lobbyOptions: $('#lobby-options'),
  optPlayers: $('#opt-players'),
  optMap: $('#opt-map'),
  optFog: $('#opt-fog'),
  btnStart: $('#btn-start'),
  btnLeave: $('#btn-leave'),
  lobbyHint: $('#lobby-hint'),
  lobbyError: $('#lobby-error'),

  canvas: $('#canvas'),
  hudPlayers: $('#hud-players'),
  hudTurn: $('#hud-turn'),
  btnNextUnit: $('#btn-next-unit'),
  btnMute: $('#btn-mute'),
  btnEndTurn: $('#btn-endturn'),
  btnResign: $('#btn-resign'),
  tileInfo: $('#tile-info'),
  unitInfo: $('#unit-info'),
  actionMenu: $('#action-menu'),
  buildMenu: $('#build-menu'),
  buildList: $('#build-list'),
  btnBuildCancel: $('#btn-build-cancel'),
  chatLog: $('#chat-log'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  banner: $('#banner'),
  toasts: $('#toasts'),
  gameover: $('#gameover'),
  gameoverTitle: $('#gameover-title'),
  gameoverSub: $('#gameover-sub'),
  btnBackMenu: $('#btn-back-menu'),
};

export function showScreen(name) {
  for (const [k, el] of Object.entries(els.screens)) {
    el.classList.toggle('active', k === name);
  }
}

export function toast(text, isError = false) {
  const div = document.createElement('div');
  div.className = 'toast' + (isError ? ' error' : '');
  div.textContent = text;
  els.toasts.appendChild(div);
  setTimeout(() => div.remove(), 3200);
}

// Screen-reader announcement (polite live region).
let srTimer = null;
export function announce(text) {
  const el = document.getElementById('sr-announce');
  if (!el) return;
  clearTimeout(srTimer);
  el.textContent = '';
  srTimer = setTimeout(() => {
    el.textContent = text;
  }, 30);
}

let bannerTimer = null;
export function banner(text, color = '#fff', ms = 1600) {
  els.banner.textContent = text;
  els.banner.style.color = color;
  els.banner.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => els.banner.classList.add('hidden'), ms);
}

// ---------------- lobby ----------------
export function renderLobby(state, youAreHost) {
  els.lobbyCode.textContent = state.code;
  els.lobbyPlayers.innerHTML = '';
  for (let i = 0; i < state.options.maxPlayers; i++) {
    const li = document.createElement('li');
    const p = state.players[i];
    if (p) {
      li.innerHTML = `<span class="dot" style="background:${PLAYER_COLORS[i]}"></span>
        <span>${escapeHtml(p.name)}</span>
        ${p.isHost ? '<span class="host-tag">HOST</span>' : p.connected ? '' : '<span class="off">offline</span>'}`;
    } else {
      li.innerHTML = `<span class="dot" style="background:#2a3648"></span><span style="color:var(--muted)">Waiting for player…</span>`;
    }
    els.lobbyPlayers.appendChild(li);
  }
  els.optPlayers.value = String(state.options.maxPlayers);
  els.optMap.value = state.options.mapSize;
  els.optFog.checked = !!state.options.fog;
  els.lobbyOptions.classList.toggle('locked', !youAreHost);
  els.btnStart.style.display = youAreHost ? '' : 'none';
  els.btnStart.disabled = state.players.length < 2;
  els.lobbyHint.textContent = youAreHost
    ? state.players.length < 2
      ? 'Share the room code with friends to fill the lobby.'
      : 'Ready when you are, Commander.'
    : 'Waiting for the host to start the war…';
}

// ---------------- game HUD ----------------
export function renderHud(snap, you) {
  els.hudPlayers.innerHTML = '';
  snap.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className =
      'hud-player' +
      (i === snap.turnIdx && p.alive ? ' current' : '') +
      (!p.alive ? ' dead' : '');
    div.innerHTML = `<span class="dot" style="background:${PLAYER_COLORS[i]}"></span>
      <span>${escapeHtml(p.name)}${i === you ? ' (you)' : ''}</span>
      ${i === you || !snap.fog ? `<span class="gold">${p.gold}g</span>` : ''}
      ${!p.connected && p.alive ? '<span class="discon">⌁</span>' : ''}`;
    els.hudPlayers.appendChild(div);
  });
  const myTurn = snap.turnIdx === you && snap.winner == null;
  els.hudTurn.textContent = `Round ${snap.round}`;
  els.btnEndTurn.disabled = !myTurn;
  els.btnEndTurn.textContent = myTurn ? 'End Turn' : `${escapeHtml(snap.players[snap.turnIdx]?.name ?? '')}'s turn`;
}

export function renderTileInfo(tile, unitHere) {
  if (!tile) {
    els.tileInfo.textContent = '';
    return;
  }
  const parts = [];
  if (tile.b) {
    const b = BUILDINGS[tile.b.type];
    parts.push(`${tile.b.type.toUpperCase()} · def ★${b.stars}` +
      (tile.b.owner != null ? '' : ' · neutral') +
      (tile.b.cap != null ? ` · capture ${tile.b.cap} left` : ''));
  } else {
    const t = TERRAINS[tile.t];
    parts.push(`${tile.t} · def ★${t.stars}`);
  }
  els.tileInfo.textContent = parts.join('  ');
}

export function renderUnitInfo(u) {
  if (!u) {
    els.unitInfo.textContent = '';
    return;
  }
  const t = UNIT_TYPES[u.type];
  els.unitInfo.innerHTML =
    `<b>${t.name}</b> · HP ${u.hp}/10 · ATK ${t.atk} · MOV ${t.move}` +
    (t.rangeMax > 1 ? ` · RNG ${t.rangeMin}–${t.rangeMax}` : '') +
    (t.canCapture ? ' · can capture' : '') +
    (t.indirect ? ' · cannot move & fire' : '');
}

// Position a popup near a world point, clamped to viewport.
export function placePopup(popup, screenX, screenY) {
  popup.classList.remove('hidden');
  const pad = 8;
  const rect = popup.getBoundingClientRect();
  if (matchMedia('(max-width: 600px)').matches) {
    // Phones: center horizontally; above or below the tapped hex, whichever fits.
    const x = Math.max(pad, Math.min(innerWidth - rect.width - pad, (innerWidth - rect.width) / 2));
    let y = screenY + 34;
    if (y + rect.height > innerHeight - pad) y = screenY - rect.height - 34;
    y = Math.max(pad, Math.min(innerHeight - rect.height - pad, y));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
    return;
  }
  let x = screenX + 24;
  let y = screenY - rect.height / 2;
  if (x + rect.width > innerWidth - pad) x = screenX - rect.width - 24;
  y = Math.max(pad, Math.min(innerHeight - rect.height - pad, y));
  popup.style.left = x + 'px';
  popup.style.top = y + 'px';
}

// Arrow-key navigation + Escape handling inside a popup menu.
function wireMenuKeys(menu, onEscape) {
  menu.onkeydown = (e) => {
    const btns = [...menu.querySelectorAll('.btn:not(.disabled)')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      btns[(i + dir + btns.length) % btns.length]?.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      onEscape?.();
    }
  };
}

export function showActionMenu(screenX, screenY, items, onClose) {
  const menu = els.actionMenu;
  menu.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML =
      escapeHtml(item.label) +
      (item.dmg ? `<span class="dmg">${item.dmg}</span>` : '') +
      (item.sub ? `<span class="sub">${item.sub}</span>` : '');
    if (item.ariaLabel) btn.setAttribute('aria-label', item.ariaLabel);
    if (item.onFocus) {
      btn.addEventListener('mouseenter', item.onFocus);
      btn.addEventListener('focus', item.onFocus);
    }
    if (item.onBlur) {
      btn.addEventListener('mouseleave', item.onBlur);
      btn.addEventListener('blur', item.onBlur);
    }
    btn.addEventListener('click', () => {
      hideActionMenu();
      item.act();
      onClose?.();
    });
    menu.appendChild(btn);
  }
  placePopup(menu, screenX, screenY);
  wireMenuKeys(menu, () => {
    hideActionMenu();
    onClose?.();
    els.canvas.focus();
  });
  menu.querySelector('.btn')?.focus();
}

export function hideActionMenu() {
  els.actionMenu.classList.add('hidden');
}

export function showBuildMenu(screenX, screenY, gold, onBuild) {
  els.buildList.innerHTML = '';
  for (const [type, t] of Object.entries(UNIT_TYPES)) {
    const btn = document.createElement('button');
    const affordable = gold >= t.cost;
    btn.className = 'btn small' + (affordable ? '' : ' disabled');
    btn.setAttribute('role', 'menuitem');
    if (!affordable) btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-label',
      `${t.name}, ${t.cost} gold${affordable ? '' : ', cannot afford'}`);
    btn.innerHTML = `${t.name}<span class="sub">${t.cost}g</span>
      <small>ATK ${t.atk} · DEF ${t.def} · MOV ${t.move}${t.rangeMax > 1 ? ` · RNG ${t.rangeMin}–${t.rangeMax}` : ''}${t.canCapture ? ' · captures' : ''}</small>`;
    btn.addEventListener('click', () => {
      hideBuildMenu();
      onBuild(type);
    });
    els.buildList.appendChild(btn);
  }
  placePopup(els.buildMenu, screenX, screenY);
  wireMenuKeys(els.buildMenu, () => {
    hideBuildMenu();
    els.canvas.focus();
  });
  els.buildList.querySelector('.btn:not(.disabled)')?.focus();
}

export function hideBuildMenu() {
  els.buildMenu.classList.add('hidden');
}

export function addChat(from, color, text, isSystem = false) {
  const div = document.createElement('div');
  if (isSystem) {
    div.className = 'sys';
    div.textContent = text;
  } else {
    const b = document.createElement('b');
    b.style.color = color;
    b.textContent = from + ': ';
    div.appendChild(b);
    div.appendChild(document.createTextNode(text));
  }
  els.chatLog.appendChild(div);
  while (els.chatLog.children.length > 60) els.chatLog.firstChild.remove();
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

export function showGameOver(won, winnerName, color) {
  els.gameoverTitle.textContent = won ? 'VICTORY' : 'DEFEAT';
  els.gameoverTitle.style.color = won ? '#eab308' : '#e5484d';
  els.gameoverSub.textContent = `${winnerName} conquers the hexfield.`;
  els.gameover.classList.remove('hidden');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
