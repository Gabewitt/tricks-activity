import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { TricksGame, SCHEDULES, DEFAULT_LENGTH, scoreboardCsv } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const TRICK_PAUSE_MS = Number(process.env.TRICK_PAUSE_MS) || 2600; // how long a finished trick stays on the table
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS) || 900;
const DISCORD_API = process.env.DISCORD_API || 'https://discord.com/api/v10';
const ALLOW_BOTS = process.env.ALLOW_BOTS === '1';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SCORES_CHANNEL_ID = process.env.SCORES_CHANNEL_ID; // optional fixed channel for results

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
    rooms.set(instanceId, {
      id: instanceId,
      players: [],
      sockets: new Map(),
      game: null,
      length: DEFAULT_LENGTH,
      channelId: null,
      results: null, // null | 'posting' | 'posted' | 'failed' | 'off'
      timer: null,
      cleanup: null,
    });
  }
  return rooms.get(instanceId);
}

const isBot = (id) => id.startsWith('bot-');

function broadcast(room) {
  const lengths = Object.fromEntries(
    Object.entries(SCHEDULES).map(([k, v]) => [k, { label: v.label, rounds: v.schedule.length }]),
  );
  for (const [userId, ws] of room.sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(
      JSON.stringify({
        type: 'state',
        me: userId,
        room: {
          players: room.players,
          hostId: room.players.find((p) => !isBot(p.id))?.id ?? null,
          length: room.length,
          lengths,
          botsAllowed: ALLOW_BOTS,
          results: room.results,
        },
        game: room.game ? room.game.viewFor(userId) : null,
      }),
    );
  }
}

// Called after every change: handles the trick pause, bots, and the end of the game.
function afterChange(room) {
  const game = room.game;
  clearTimeout(room.timer);
  room.timer = null;
  if (!game) return;

  if (game.phase === 'trickEnd') {
    room.timer = setTimeout(() => {
      if (room.game !== game) return;
      game.collectTrick();
      broadcast(room);
      afterChange(room);
    }, TRICK_PAUSE_MS);
  } else if (game.phase === 'gameOver' && room.results == null) {
    postResults(room);
  } else if (['bidding', 'playing'].includes(game.phase) && isBot(game.players[game.turn].id)) {
    room.timer = setTimeout(() => {
      if (room.game !== game) return;
      botMove(game);
      broadcast(room);
      afterChange(room);
    }, BOT_DELAY_MS);
  }
}

// Practice bots for testing alone. They call roughly a quarter of the cards and play a random legal card.
function botMove(game) {
  const id = game.players[game.turn].id;
  if (game.phase === 'bidding') {
    const allowed = game.allowedBids(id);
    const target = Math.round(game.round / 4);
    const bid = allowed.reduce((best, b) => (Math.abs(b - target) < Math.abs(best - target) ? b : best), allowed[0]);
    game.placeBid(id, bid);
  } else {
    const legal = game.legalCards(id);
    game.playCard(id, legal[Math.floor(Math.random() * legal.length)].id);
  }
}

// ---- Final scores to Discord ----
async function postResults(room) {
  const game = room.game;
  const channelId = SCORES_CHANNEL_ID || room.channelId;
  if (!BOT_TOKEN || !channelId) {
    room.results = 'off';
    return broadcast(room);
  }
  room.results = 'posting';
  broadcast(room);

  const ranked = game.players.slice().sort((a, b) => game.scores[b.id] - game.scores[a.id]);
  const medals = ['🥇', '🥈', '🥉', '4.'];
  const when = Math.floor(Date.now() / 1000);
  const label = SCHEDULES[game.length]?.label ?? 'Game';
  const content = [
    `**Tricks: ${label}** · <t:${when}:D>`,
    ...ranked.map((p, i) => `${medals[i]} ${p.name}: **${game.scores[p.id]}**`),
    `${game.history.length} rounds · full scoreboard attached`,
  ].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  const filename = `tricks-${date}.csv`;

  try {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content, attachments: [{ id: 0, filename }] }));
    form.append('files[0]', new Blob([scoreboardCsv(game)], { type: 'text/csv' }), filename);
    const r = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
      body: form,
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    room.results = 'posted';
  } catch (e) {
    console.error('Could not post results to Discord:', e.message);
    room.results = 'failed';
  }
  if (room.game === game) broadcast(room);
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
      clearTimeout(room.cleanup);
      userId = msg.user.id;
      if (msg.channelId) room.channelId = msg.channelId;
      room.sockets.set(userId, ws);
      const existing = room.players.find((p) => p.id === userId);
      if (existing) existing.name = msg.user.name;
      else room.players.push({ id: userId, name: msg.user.name });
      return broadcast(room);
    }
    if (!room || !userId) return;

    try {
      const game = room.game;
      const isHost = room.players.find((p) => !isBot(p.id))?.id === userId;
      switch (msg.type) {
        case 'setLength':
          if (!isHost || game) throw new Error('Only the host can change the game length');
          if (!SCHEDULES[msg.length]) throw new Error('Unknown game length');
          room.length = msg.length;
          break;
        case 'addBots': {
          if (!ALLOW_BOTS) throw new Error('Practice bots are turned off on this server');
          if (!isHost || game) throw new Error('Only the host can add bots');
          let n = 1;
          while (room.players.length < 4) {
            while (room.players.some((p) => p.id === `bot-${n}`)) n++;
            room.players.push({ id: `bot-${n}`, name: `Bot ${n}` });
          }
          break;
        }
        case 'removeBots':
          if (!isHost || game) throw new Error('Only the host can remove bots');
          room.players = room.players.filter((p) => !isBot(p.id));
          break;
        case 'start': {
          if (!isHost) throw new Error('Only the host can start');
          if (room.players.length < 4) throw new Error('Need 4 players at the table');
          room.game = new TricksGame(room.players.slice(0, 4), { length: room.length });
          room.results = null;
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
        case 'newGame':
          if (!isHost) throw new Error('Only the host can start a new game');
          room.game = null;
          room.results = null;
          break;
        default:
          throw new Error('Unknown action');
      }
      broadcast(room);
      afterChange(room);
    } catch (e) {
      reply(ws, e.message);
    }
  });

  ws.on('close', () => {
    if (!room || !userId || room.sockets.get(userId) !== ws) return;
    room.sockets.delete(userId);
    // In the lobby, leaving frees the seat. Mid-game, players stay seated so a
    // dropped connection can rejoin and get their hand back.
    if (!room.game) {
      room.players = room.players.filter((p) => p.id !== userId);
      broadcast(room);
    }
    // Forget the room a few hours after everyone has left.
    if (room.sockets.size === 0) {
      const r = room;
      r.cleanup = setTimeout(() => {
        if (r.sockets.size === 0) {
          clearTimeout(r.timer);
          rooms.delete(r.id);
        }
      }, 3 * 60 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => console.log(`Tricks server on http://localhost:${PORT}`));
