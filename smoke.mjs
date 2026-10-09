// Server smoke test: four fake players connect over WebSockets and play a few rounds.
// Start the server first (e.g. `TRICK_PAUSE_MS=50 PORT=3999 node server/index.js`), then `node smoke.mjs`.
import WebSocket from 'ws';

const PORT = process.env.PORT || 3999;
const ROUNDS = 3;
const names = ['Mamie', 'Papi', 'Rose', 'Jean'];
const TABLE = `smoke-${Date.now()}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = names.map((n, i) => ({ id: 'u' + i, name: n, ws: new WebSocket(`ws://localhost:${PORT}/ws`), state: null }));

for (const c of clients) {
  await new Promise((r) => c.ws.on('open', r));
  c.ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.type === 'state') c.state = d;
    else console.log('ERR', c.name, d.message);
  });
  c.ws.send(JSON.stringify({ type: 'join', instanceId: TABLE, user: { id: c.id, name: c.name } }));
}
await wait(200);
clients[0].ws.send(JSON.stringify({ type: 'start' }));
await wait(200);

let finished = 0;
while (finished < ROUNDS) {
  const g = clients[0].state.game;
  const turn = clients.find((c) => c.id === g.turnId);
  if (g.phase === 'bidding') turn.ws.send(JSON.stringify({ type: 'bid', bid: turn.state.game.allowedBids[0] }));
  else if (g.phase === 'playing') turn.ws.send(JSON.stringify({ type: 'play', cardId: turn.state.game.legal[0] }));
  else if (g.phase === 'roundEnd') {
    finished++;
    console.log(`round ${g.round} (${g.cards} cards, trump ${g.trump}):`, g.players.map((p) => `${p.name} ${p.bid}/${p.won} => ${p.score}`).join(' | '));
    if (finished < ROUNDS) clients[0].ws.send(JSON.stringify({ type: 'nextRound' }));
  }
  await wait(60); // trickEnd: just wait for the server to collect the trick
}
console.log('opponents hidden:', clients[1].state.game.hand.length, 'own cards; others only show counts', clients[1].state.game.players.map((p) => p.cardsLeft));
process.exit(0);
