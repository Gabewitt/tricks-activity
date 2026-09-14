import { DiscordSDK } from '@discord/embedded-app-sdk';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;
const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const app = document.getElementById('app');

let ws;
let state = null;
let toastTimer;
let scoreboardOpen = false;
let dealtRound = 0;            // last round whose deal animation has played
let seenTrickCards = new Set(); // cards already animated into the current trick
let collectedTrick = null;     // lastTrick already animated away

// ---------- Discord handshake ----------
async function connectDiscord() {
  const sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  const res = await fetch('/.proxy/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { access_token } = await res.json();
  const auth = await sdk.commands.authenticate({ access_token });
  return {
    instanceId: sdk.instanceId,
    user: { id: auth.user.id, name: auth.user.global_name || auth.user.username },
  };
}

// ---------- Socket ----------
function connectSocket({ instanceId, user }) {
  ws = new WebSocket(`wss://${location.host}/.proxy/ws`);
  ws.onopen = () => send({ type: 'join', instanceId, user });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') {
      state = msg;
      render();
    } else if (msg.type === 'error') {
      toast(msg.message);
    }
  };
  ws.onclose = () => {
    toast('Connection lost. Reconnecting…');
    setTimeout(() => connectSocket({ instanceId, user }), 1500);
  };
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast' }, text);
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3000);
}

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

function cardEl(card, extra = '') {
  if (!card) return h('div', { class: `card back ${extra}` });
  const red = card.suit === 'H' || card.suit === 'D';
  return h(
    'div',
    { class: `card ${red ? 'red' : ''} ${extra}`, 'aria-label': `${card.rank} of ${SUIT_NAME[card.suit]}` },
    h('div', { class: 'corner' }, h('span', {}, card.rank), h('span', {}, SUIT_GLYPH[card.suit])),
    h('div', { class: 'pip' }, SUIT_GLYPH[card.suit]),
  );
}

// ---------- Views ----------
function render() {
  app.replaceChildren();
  if (!state) return;
  const { game, room, me } = state;
  if (!game) return app.append(lobbyView(room, me));
  if (game.phase === 'gameOver') return app.append(gameOverView(game, room, me));
  app.append(tableView(game, room, me));
  if (game.phase === 'roundEnd') app.append(roundEndView(game, me));
  if (scoreboardOpen) app.append(scoreboardView(game));
}

function lobbyView(room, me) {
  const isHost = room.hostId === me;
  const seats = [0, 1, 2, 3].map((i) => {
    const p = room.players[i];
    return p ? h('li', {}, `${p.name}${p.id === room.hostId ? ' (host)' : ''}`) : h('li', { class: 'empty' }, 'Waiting for a player…');
  });
  const extras = room.players.slice(4);
  return h(
    'div',
    { class: 'lobby' },
    h('h1', {}, 'Tricks'),
    h('p', {}, 'Four seats at the table. Play goes clockwise in the order listed.'),
    h('ul', { class: 'seatlist' }, seats),
    extras.length ? h('p', {}, `Watching: ${extras.map((p) => p.name).join(', ')}`) : null,
    isHost
      ? h('button', { class: 'primary', disabled: room.players.length < 4, onclick: () => send({ type: 'start' }) }, 'Deal the first round')
      : h('p', {}, `${room.players.find((p) => p.id === room.hostId)?.name ?? 'The host'} will start the game.`),
  );
}

function tableView(game, room, me) {
  const seated = game.players.map((p) => p.id);
  const mySeat = Math.max(0, seated.indexOf(me)); // spectators see from seat 0
  const positions = ['south', 'west', 'north', 'east']; // clockwise from me
  const posOf = (id) => positions[(seated.indexOf(id) - mySeat + 4) % 4];
  const byId = Object.fromEntries(game.players.map((p) => [p.id, p]));
  const isPlayer = seated.includes(me);
  const myTurn = game.turnId === me;

  const seats = game.players.map((p) =>
    h(
      'div',
      { class: `seat ${posOf(p.id)} ${game.turnId === p.id ? 'active' : ''}` },
      h('div', { class: 'name' }, p.name, p.id === game.dealerId ? h('span', { class: 'dealer' }, 'dealer') : null),
      h('div', { class: 'tally' }, p.bid == null ? 'bidding…' : ['Called ', h('b', {}, p.bid), ` · won ${p.won}`]),
      h('div', { class: 'score' }, `${p.score} points`),
    ),
  );

  // Show the finished trick briefly so people can see who took it.
  const showLast = game.currentTrick.length === 0 && game.lastTrick && game.phase !== 'bidding';
  if (game.currentTrick.length === 0 && !showLast) seenTrickCards = new Set();
  const trickCards = (showLast ? game.lastTrick.cards : game.currentTrick).map((e) => {
    const fresh = !seenTrickCards.has(e.card.id);
    seenTrickCards.add(e.card.id);
    const isWinner = showLast && e.playerId === game.lastTrick.winnerId;
    return cardEl(e.card, `${posOf(e.playerId)} ${isWinner ? 'winner' : ''} ${fresh && !showLast ? 'play-in' : ''}`);
  });
  // Once the trick is complete, sweep the four cards toward whoever won it.
  const collect = showLast && collectedTrick !== game.lastTrick.cards[0].card.id + game.round;
  if (collect) collectedTrick = game.lastTrick.cards[0].card.id + game.round;
  const trickClass = `trick ${collect ? 'collect to-' + posOf(game.lastTrick?.winnerId ?? '') : showLast ? 'collected' : ''}`;

  let callout = null;
  if (game.phase === 'bidding') callout = `${byId[game.turnId].name} is calling…`;
  else if (showLast) callout = `${byId[game.lastTrick.winnerId].name} takes the trick`;
  else if (game.phase === 'playing' && !myTurn) callout = `${byId[game.turnId].name} to play`;

  const trumpBadge = game.trump
    ? h('div', { class: 'trump-badge' }, 'Trump', cardEl(game.trumpCard, 'mini'), SUIT_NAME[game.trump])
    : h('div', { class: 'trump-badge none' }, 'No trump this round');

  let prompt = '';
  let controls = null;
  if (isPlayer && game.phase === 'bidding' && myTurn) {
    prompt = 'How many tricks will you make?';
    controls = h(
      'div',
      { class: 'bids' },
      Array.from({ length: game.cards + 1 }, (_, n) =>
        h('button', { disabled: !game.allowedBids.includes(n), onclick: () => send({ type: 'bid', bid: n }) }, n),
      ),
    );
  } else if (isPlayer && game.phase === 'playing' && myTurn) {
    prompt = game.leadSuit ? `Your turn — follow ${SUIT_NAME[game.leadSuit].toLowerCase()} if you can` : 'Your turn — lead a card';
  }

  const dealNow = isPlayer && dealtRound !== game.round && game.phase === 'bidding';
  if (dealNow) dealtRound = game.round;
  const hand = h(
    'div',
    { class: 'hand' },
    game.hand.map((c, i) =>
      h(
        'button',
        {
          class: `cardbtn ${dealNow ? 'deal' : ''}`,
          style: dealNow ? `animation-delay: ${i * 90}ms` : null,
          disabled: !(myTurn && game.phase === 'playing' && game.legal.includes(c.id)),
          onclick: () => send({ type: 'play', cardId: c.id }),
        },
        cardEl(c),
      ),
    ),
  );
  const meRow = byId[me];
  const myTally =
    isPlayer && meRow.bid != null && game.phase === 'playing'
      ? h('div', { class: 'mytally' }, 'You called ', h('b', {}, meRow.bid), ' · made ', h('b', {}, meRow.won), ` of ${game.cards - (game.hand.length)} played`)
      : null;

  return h(
    'div',
    { class: 'table' },
    h(
      'div',
      { class: 'topbar' },
      h('span', {}, `Round ${game.round} of ${game.totalRounds} · ${game.cards} card${game.cards > 1 ? 's' : ''}`),
      trumpBadge,
      h('button', { class: 'small', onclick: () => { scoreboardOpen = true; render(); } }, 'Scores'),
    ),
    h('div', { class: 'felt' }, seats, h('div', { class: 'center' }, trickCards.length ? h('div', { class: trickClass }, trickCards) : callout && h('div', { class: 'callout' }, callout)), trickCards.length && callout ? h('div', { class: 'center', style: 'align-items: end; padding-bottom: 8px' }, h('div', { class: 'callout' }, callout)) : null),
    h('div', { class: 'hand-area' }, myTally, h('div', { class: 'prompt' }, prompt), controls, hand),
  );
}

function scoreTable(game, roundResult) {
  const rows = game.players
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const r = roundResult?.[p.id];
      return h(
        'tr',
        {},
        h('td', {}, p.name),
        r ? h('td', {}, `${r.bid} / ${r.won}`) : null,
        r ? h('td', { class: r.delta > 0 ? 'gain' : 'loss' }, (r.delta > 0 ? '+' : '') + r.delta) : null,
        h('td', {}, p.score),
      );
    });
  return h(
    'table',
    {},
    h('tr', {}, h('th', {}, 'Player'), roundResult ? h('th', {}, 'Called / won') : null, roundResult ? h('th', {}, 'This round') : null, h('th', {}, 'Total')),
    rows,
  );
}

function scoreboardView(game) {
  const close = () => { scoreboardOpen = false; render(); };
  const ranked = game.players.slice().sort((a, b) => b.score - a.score);
  const header = h('tr', {}, h('th', {}, 'Round'), game.players.map((p) => h('th', { class: 'num' }, p.name)));
  const rows = game.history.map((r) =>
    h(
      'tr',
      {},
      h('td', {}, h('span', { class: 'roundlabel' }, `${r.round}`), h('span', { class: `roundtrump ${r.trump === 'H' || r.trump === 'D' ? 'red' : ''}` }, r.trump ? ` ${SUIT_GLYPH[r.trump]}` : ' —'), h('span', { class: 'roundcards' }, ` ${r.cards} card${r.cards > 1 ? 's' : ''}`)),
      game.players.map((p) => {
        const c = r.result[p.id];
        const mark = c.won > c.bid ? h('span', { class: 'over', title: 'overcall' }, '▲') : c.won < c.bid ? h('span', { class: 'under', title: 'undercall' }, '▼') : h('span', { class: 'exact' }, '✓');
        return h('td', { class: 'num' }, h('div', { class: 'call' }, `${c.bid}/${c.won} `, mark), h('div', { class: c.delta > 0 ? 'gain' : 'loss' }, (c.delta > 0 ? '+' : '') + c.delta));
      }),
    ),
  );
  const totals = h('tr', { class: 'totals' }, h('td', {}, 'Total'), game.players.map((p) => h('td', { class: 'num' }, p.score)));
  return h(
    'div',
    { class: 'overlay', onclick: (e) => e.target.classList.contains('overlay') && close() },
    h(
      'div',
      { class: 'panel scoreboard' },
      h('h2', {}, 'Scores'),
      h('p', { class: 'standing' }, ranked.map((p, i) => `${i + 1}. ${p.name} ${p.score}`).join('   ')),
      game.history.length
        ? h('div', { class: 'scroll' }, h('table', {}, header, rows, totals))
        : h('p', {}, 'No rounds finished yet.'),
      h('p', { class: 'legend' }, 'called/made · ✓ exact · ▲ made more than called · ▼ made fewer'),
      h('button', { class: 'primary', onclick: close }, 'Back to the table'),
    ),
  );
}

function roundEndView(game, me) {
  const last = game.history[game.history.length - 1];
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, `Round ${last.round} finished`),
      scoreTable(game, last.result),
      h('button', { class: 'primary', onclick: () => send({ type: 'nextRound' }) }, `Deal round ${game.round + 1}`),
    ),
  );
}

function gameOverView(game, room, me) {
  const winner = game.players.slice().sort((a, b) => b.score - a.score)[0];
  return h(
    'div',
    { class: 'gameover' },
    h('h1', {}, `${winner.name} wins!`),
    h('div', { class: 'panel' }, scoreTable(game)),
    room.hostId === me ? h('button', { class: 'primary', onclick: () => send({ type: 'newGame' }) }, 'Play again') : null,
  );
}

// ---------- boot ----------
(async () => {
  try {
    const session = await connectDiscord();
    connectSocket(session);
  } catch (e) {
    app.replaceChildren(h('div', { class: 'loading' }, `Could not connect to Discord: ${e.message}`));
  }
})();
