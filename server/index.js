// MEGAHEX server: static file hosting + WebSocket game protocol.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Serve /shared/* from the shared game-logic directory, all else from public/.
    let filePath;
    if (pathname.startsWith('/shared/')) {
      filePath = join(ROOT, normalize(pathname));
    } else {
      filePath = join(ROOT, 'public', normalize(pathname));
    }
    // Path traversal guard.
    if (!filePath.startsWith(join(ROOT, 'public')) && !filePath.startsWith(join(ROOT, 'shared'))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const rooms = new RoomManager();

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

wss.on('connection', (ws) => {
  // Per-connection session state. Track the player object (not an index)
  // because lobby indexes shift when players leave.
  let room = null;
  let player = null;
  const myIdx = () => (room && player ? room.players.indexOf(player) : -1);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'Bad message');
    }
    if (!msg || typeof msg.type !== 'string') return sendError(ws, 'Bad message');

    try {
      switch (msg.type) {
        case 'create': {
          if (room) return sendError(ws, 'Already in a room');
          const r = rooms.create(msg.name);
          const res = r.addPlayer(msg.name, ws);
          if (res.error) return sendError(ws, res.error);
          room = r;
          player = res.player;
          if (msg.options) room.setOptions(msg.options);
          if (msg.vsAI) room.addBot();
          send(ws, { type: 'joined', code: room.code, you: myIdx(), token: player.token });
          room.broadcastLobby();
          break;
        }

        case 'join': {
          if (room) return sendError(ws, 'Already in a room');
          const r = rooms.get(msg.code);
          if (!r) return sendError(ws, 'Room not found');
          const res = r.addPlayer(msg.name, ws);
          if (res.error) return sendError(ws, res.error);
          room = r;
          player = res.player;
          send(ws, { type: 'joined', code: room.code, you: myIdx(), token: player.token });
          room.broadcastLobby();
          break;
        }

        case 'rejoin': {
          if (room) return sendError(ws, 'Already in a room');
          const r = rooms.get(msg.code);
          if (!r) return sendError(ws, 'Room not found');
          const res = r.onRejoin(msg.token, ws);
          if (res.error) return sendError(ws, res.error);
          room = r;
          player = res.player;
          break;
        }

        case 'setOptions': {
          if (!room) return sendError(ws, 'Not in a room');
          if (myIdx() !== 0) return sendError(ws, 'Only the host can change options');
          room.setOptions(msg.options || {});
          room.broadcastLobby();
          break;
        }

        case 'addBot': {
          if (!room) return sendError(ws, 'Not in a room');
          if (myIdx() !== 0) return sendError(ws, 'Only the host can add AI players');
          const res = room.addBot();
          if (res.error) return sendError(ws, res.error);
          room.broadcastLobby();
          break;
        }

        case 'removeBot': {
          if (!room) return sendError(ws, 'Not in a room');
          if (myIdx() !== 0) return sendError(ws, 'Only the host can remove AI players');
          const res = room.removeBot(Number(msg.idx));
          if (res.error) return sendError(ws, res.error);
          room.broadcastLobby();
          break;
        }

        case 'start': {
          if (!room) return sendError(ws, 'Not in a room');
          if (myIdx() !== 0) return sendError(ws, 'Only the host can start');
          const { error } = room.start();
          if (error) return sendError(ws, error);
          break;
        }

        case 'action': {
          if (!room) return sendError(ws, 'Not in a room');
          const { error } = room.handleAction(myIdx(), msg.action || {});
          if (error) return sendError(ws, error);
          break;
        }

        case 'chat': {
          if (!room) return sendError(ws, 'Not in a room');
          const i = myIdx();
          if (i >= 0) room.chat(i, msg.text);
          break;
        }

        default:
          sendError(ws, 'Unknown message type');
      }
    } catch (err) {
      console.error('Message handling error:', err);
      sendError(ws, 'Server error');
    }
  });

  ws.on('close', () => {
    if (room && player) {
      // Only mark disconnect if this socket is still the registered one
      // (a rejoin may have replaced it already).
      const i = room.players.indexOf(player);
      if (i >= 0 && room.players[i].ws === ws) room.onDisconnect(i);
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`MEGAHEX server running at http://localhost:${PORT}`);
});
