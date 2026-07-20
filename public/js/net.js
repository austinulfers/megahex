// WebSocket client with auto-reconnect + session rejoin.

const listeners = new Map(); // type -> [fn]
let ws = null;
let wantReconnect = false;
let reconnectDelay = 500;

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

function emit(type, msg) {
  for (const fn of listeners.get(type) || []) fn(msg);
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  wantReconnect = true;

  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    emit('_open');
    // Attempt session resume.
    const sess = getSession();
    if (sess) send({ type: 'rejoin', code: sess.code, token: sess.token });
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg && msg.type) emit(msg.type, msg);
  });

  ws.addEventListener('close', () => {
    emit('_close');
    if (wantReconnect) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    }
  });

  ws.addEventListener('error', () => {
    try { ws.close(); } catch {}
  });
}

export function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function isOpen() {
  return !!ws && ws.readyState === 1;
}

// --- session persistence (sessionStorage = per-tab, so you can test with 2 tabs) ---
export function saveSession(code, token) {
  sessionStorage.setItem('mh_session', JSON.stringify({ code, token }));
}

export function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem('mh_session'));
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem('mh_session');
  wantReconnect = true; // keep socket for new lobby
}
