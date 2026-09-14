import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { TricksGame } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const app = express();
app.use(express.json());

// Discord Activity OAuth: the client sends the code it got from the SDK and
// we swap it for an access token here so the client secret never leaves the server.
app.post('/api/token', async (req, res) => {
  try {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.VITE_DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.body.code,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ access_token: data.access_token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---- Rooms: one per Discord activity instance (i.e. per voice call) ----
const rooms = new Map();

function getRoom(instanceId) {
  if (!rooms.has(instanceId)) {
    rooms.set(instanceId, { players: [], sockets: new Map(), game: null, error: null });
  }
  return rooms.get(instanceId);
}

function broadcast(room) {
  for (const [userId, ws] of room.sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(
      JSON.stringify({
        type: 'state',
        me: userId,
        room: {
          players: room.players,
          hostId: room.players[0]?.id ?? null,
          seated: room.players.slice(0, 4).map((p) => p.id),
        },
        game: room.game ? room.game.viewFor(userId) : null,
      }),
    );
  }
}

function reply(ws, error) {
  ws.send(JSON.stringify({ type: 'error', message: error }));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let room = null;
  let userId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      room = getRoom(msg.instanceId);
      userId = msg.user.id;
      room.sockets.set(userId, ws);
      const existing = room.players.find((p) => p.id === userId);
      if (existing) existing.name = msg.user.name;
      else room.players.push({ id: userId, name: msg.user.name });
      return broadcast(room);
    }
    if (!room || !userId) return;

    try {
      const game = room.game;
      const isHost = room.players[0]?.id === userId;
      switch (msg.type) {
        case 'start': {
          if (!isHost) throw new Error('Only the host can start');
          if (room.players.length < 4) throw new Error('Need 4 players at the table');
          room.game = new TricksGame(room.players.slice(0, 4));
          room.game.startRound();
          break;
        }
        case 'bid':
          game.placeBid(userId, msg.bid);
          break;
        case 'play':
          game.playCard(userId, msg.cardId);
          break;
        case 'nextRound':
          if (game.phase !== 'roundEnd') throw new Error('Round not finished');
          game.startRound();
          break;
        case 'reorder': {
          // host drags seats before the game starts
          if (!isHost || room.game) throw new Error('Cannot reorder now');
          const byId = Object.fromEntries(room.players.map((p) => [p.id, p]));
          room.players = msg.order.map((id) => byId[id]).filter(Boolean);
          break;
        }
        case 'newGame':
          if (!isHost) throw new Error('Only the host can start a new game');
          room.game = null;
          break;
      }
      broadcast(room);
    } catch (e) {
      reply(ws, e.message);
    }
  });

  ws.on('close', () => {
    if (room && userId && room.sockets.get(userId) === ws) room.sockets.delete(userId);
    // Players stay seated so a dropped connection can rejoin mid-game.
  });
});

server.listen(PORT, () => console.log(`Tricks server on http://localhost:${PORT}`));
