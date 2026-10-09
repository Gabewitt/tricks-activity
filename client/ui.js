// The table UI. Everything is drawn on a fixed-size "stage" that is scaled to
// fit the window, so the layout looks the same in a small Discord call window,
// full screen, or on a tablet.

const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const isRed = (suit) => suit === 'H' || suit === 'D';
const GOLD = ['#f2c14e', '#ffe08a', '#fff4d6', '#d9a441'];
const CONFETTI = ['#f2c14e', '#e4572e', '#29a3a3', '#f4f0e6', '#7bc96f', '#b388eb'];

const viewport = document.getElementById('viewport');
const stage = document.getElementById('stage');
const app = document.getElementById('app');
const fx = document.getElementById('fx');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let ws = null;
let state = null;
let scale = 1;
let toastTimer;
let scoreboardOpen = false;

// render() rebuilds the DOM on every update, so remember which animations
// have already played.
const seen = {
  dealt: null, // round key whose deal animation played
  trickCards: new Set(), // cards that already slid onto the table
  trickEnd: null, // trick whose win effect started
  trickEndAt: 0,
  won: {}, // player id -> tricks won at last render (for the pile "pop")
  roundEnd: null,
  gameOver: null,
};

// ---------- scaling ----------
function fit() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return;
  const portrait = h > w * 1.15;
  const [W, H] = portrait ? [780, 1120] : [1200, 720];
  scale = Math.min(w / W, h / H, 2);
  stage.style.width = `${w / scale}px`;
  stage.style.height = `${h / scale}px`;
  stage.style.transform = `scale(${scale})`;
  document.documentElement.dataset.layout = portrait ? 'portrait' : 'landscape';
}
new ResizeObserver(fit).observe(viewport);
fit();

// ---------- socket ----------
export function connectSocket(url, joinMsg) {
  ws = new WebSocket(url);
  ws.onopen = () => send(joinMsg);
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
    setTimeout(() => connectSocket(url, joinMsg), 1500);
  };
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

export function showError(text) {
  app.replaceChildren(h('div', { class: 'loading' }, text));
}

function toast(text) {
  fx.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast' }, text);
  fx.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
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
  return h(
    'div',
    { class: `card ${isRed(card.suit) ? 'red' : ''} ${extra}`, 'aria-label': `${card.rank} of ${SUIT_NAME[card.suit]}` },
    h('div', { class: 'corner' }, h('span', {}, card.rank), h('span', {}, SUIT_GLYPH[card.suit])),
    h('div', { class: 'pip' }, SUIT_GLYPH[card.suit]),
  );
}

// Spread the call buttons over even rows: 8 buttons -> 2 rows of 4, 14 -> 2 rows of 7.
const bidColumns = (n) => (n <= 7 ? n : Math.ceil(n / Math.ceil(n / 7)));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

// Total called vs. cards dealt: "Undercall −2", "Overcall +1".
function callBalance(total, cards) {
  const diff = total - cards;
  if (diff < 0) return { cls: 'under', label: `Undercall ${signed(diff)}` };
  if (diff > 0) return { cls: 'over', label: `Overcall ${signed(diff)}` };
  return { cls: 'even', label: 'Even' };
}

// ---------- views ----------
function render() {
  app.replaceChildren();
  if (!state) return;
  const { game, room, me } = state;
  const after = [];
  if (!game) {
    app.append(lobbyView(room, me));
  } else if (game.phase === 'gameOver') {
    app.append(gameOverView(game, room, me, after));
    if (scoreboardOpen) app.append(scoreboardView(game));
  } else {
    app.append(tableView(game, room, me, after));
    if (game.phase === 'roundEnd') app.append(roundEndView(game, me, after));
    if (scoreboardOpen) app.append(scoreboardView(game));
  }
  for (const fn of after) fn();
}

function lobbyView(room, me) {
  const isHost = room.hostId === me;
  const host = room.players.find((p) => p.id === room.hostId);
  const hasBots = room.players.some((p) => p.id.startsWith('bot-'));
  const seats = [0, 1, 2, 3].map((i) => {
    const p = room.players[i];
    if (!p) return h('li', { class: 'empty' }, 'Waiting for a player…');
    return h('li', {}, p.name, p.id === room.hostId ? h('span', { class: 'chip' }, 'host') : null, p.id === me ? h('span', { class: 'chip' }, 'you') : null);
  });
  const extras = room.players.slice(4);
  const describe = {
    full: '1 up to 12 cards, four 13-card rounds, back down to 1, then four more 13s',
    half: '1 up to 12 cards, then four 13-card rounds',
  };
  const lengthPicker = h(
    'div',
    { class: 'lengths', role: 'radiogroup', 'aria-label': 'Game length' },
    Object.entries(room.lengths).map(([key, l]) =>
      h(
        'button',
        {
          class: `length ${room.length === key ? 'selected' : ''}`,
          role: 'radio',
          'aria-checked': room.length === key ? 'true' : 'false',
          disabled: !isHost,
          onclick: () => send({ type: 'setLength', length: key }),
        },
        h('span', { class: 'lname' }, l.label),
        h('span', { class: 'lrounds' }, `${l.rounds} rounds`),
        h('span', { class: 'ldesc' }, describe[key] ?? ''),
      ),
    ),
  );
  return h(
    'div',
    { class: 'lobby' },
    h('h1', {}, 'Tricks'),
    h('p', { class: 'sub' }, 'Four seats. Play goes clockwise in this order.'),
    h('ol', { class: 'seatlist' }, seats),
    extras.length ? h('p', { class: 'sub' }, `Watching: ${extras.map((p) => p.name).join(', ')}`) : null,
    lengthPicker,
    isHost
      ? h(
          'div',
          { class: 'lobby-actions' },
          room.botsAllowed && room.players.length < 4
            ? h('button', { onclick: () => send({ type: 'addBots' }) }, 'Fill empty seats with practice bots')
            : null,
          hasBots ? h('button', { onclick: () => send({ type: 'removeBots' }) }, 'Remove bots') : null,
          h('button', { class: 'primary', disabled: room.players.length < 4, onclick: () => send({ type: 'start' }) }, 'Deal the first round'),
        )
      : h('p', { class: 'sub' }, `${host?.name ?? 'The host'} will start the game.`),
  );
}

function tableView(game, room, me, after) {
  const seated = game.players.map((p) => p.id);
  const isPlayer = seated.includes(me);
  const mySeat = Math.max(0, seated.indexOf(me)); // spectators see from seat 0
  const positions = ['south', 'west', 'north', 'east']; // clockwise from me
  const posOf = (id) => positions[(seated.indexOf(id) - mySeat + 4) % 4];
  const byId = Object.fromEntries(game.players.map((p) => [p.id, p]));
  const nameOf = (id) => (id === me ? 'You' : byId[id]?.name ?? '');
  const myTurn = game.turnId === me;
  const roundKey = `${game.gameId}:${game.round}`;
  const ending = game.phase === 'trickEnd';
  const callTotal = game.players.reduce((s, p) => s + (p.bid ?? 0), 0);
  const allCalled = game.players.every((p) => p.bid != null);

  // ----- top bar -----
  const trumpBadge = game.trump
    ? h('div', { class: 'badge trump' }, h('span', {}, 'Trump'), cardEl(game.trumpCard, 'mini'), h('span', { class: isRed(game.trump) ? 'redtext' : '' }, SUIT_NAME[game.trump]))
    : h('div', { class: 'badge trump none' }, 'No trump');
  let callBadge;
  if (!allCalled) {
    callBadge = h('div', { class: 'badge calls' }, h('span', { class: 'big' }, `${callTotal} of ${game.cards}`), h('span', { class: 'small' }, 'called so far'));
  } else {
    const b = callBalance(callTotal, game.cards);
    callBadge = h('div', { class: `badge calls ${b.cls}` }, h('span', { class: 'big' }, b.label), h('span', { class: 'small' }, `${callTotal} called · ${plural(game.cards, 'trick')}`));
  }
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'roundinfo' }, h('span', { class: 'big' }, `Round ${game.round} of ${game.totalRounds}`), h('span', { class: 'small' }, plural(game.cards, 'card'))),
    h('div', { class: 'badges' }, trumpBadge, callBadge),
    h('button', { class: 'small', onclick: () => { scoreboardOpen = true; render(); } }, 'Scores'),
  );

  // ----- name plates (around the table, not on it) -----
  const plate = (p) => {
    const cls = ['plate', posOf(p.id)];
    if (game.turnId === p.id) cls.push('active');
    if (ending && game.trickWinnerId === p.id) cls.push('took');
    let tally;
    if (p.bid == null) tally = h('span', { class: 'muted' }, game.turnId === p.id ? 'calling…' : 'waiting to call');
    else {
      const progress = p.won === p.bid ? 'hit' : p.won > p.bid ? 'bust' : '';
      tally = ['Called ', h('b', {}, p.bid), ' · won ', h('b', { class: progress }, p.won)];
    }
    return h(
      'div',
      { class: cls.join(' '), 'data-player': p.id },
      h('div', { class: 'name' }, h('span', { class: 'nm' }, p.name), p.id === game.dealerId ? h('span', { class: 'chip' }, 'dealer') : null),
      h('div', { class: 'tally' }, tally),
      h('div', { class: 'score' }, `${p.score} points`),
    );
  };

  // ----- won tricks: face-down piles on the table, to each player's right -----
  const corner = { south: 'se', west: 'sw', north: 'nw', east: 'ne' };
  const piles = game.players.map((p) => {
    const key = `${roundKey}:${p.id}`;
    const before = seen.won[key];
    seen.won[key] = p.won;
    const fresh = before != null && p.won > before;
    return h(
      'div',
      { class: `piles ${corner[posOf(p.id)]}`, 'data-player': p.id, 'aria-label': `${p.name} has won ${plural(p.won, 'trick')}` },
      Array.from({ length: p.won }, (_, i) => h('div', { class: `pile ${fresh && i === p.won - 1 ? 'pop' : ''}` })),
    );
  });

  // ----- centre of the table -----
  let center;
  if (game.phase === 'bidding') {
    if (isPlayer && myTurn) {
      const allowed = game.allowedBids;
      const blocked = Array.from({ length: game.cards + 1 }, (_, n) => n).filter((n) => !allowed.includes(n));
      center = h(
        'div',
        { class: 'bidbox' },
        h('div', { class: 'ask' }, 'How many tricks will you make?'),
        h(
          'div',
          { class: 'bids', style: `--cols: ${bidColumns(game.cards + 1)}` },
          Array.from({ length: game.cards + 1 }, (_, n) =>
            h('button', { disabled: !allowed.includes(n), onclick: () => send({ type: 'bid', bid: n }) }, n),
          ),
        ),
        blocked.length ? h('div', { class: 'hint' }, `You can't call ${blocked[0]}: the calls would add up to ${game.cards}.`) : null,
      );
    } else {
      center = h('div', { class: 'callout' }, `${nameOf(game.turnId)} ${game.turnId === me ? 'are' : 'is'} calling…`);
    }
  } else if (game.currentTrick.length) {
    if (ending && seen.trickEnd !== `${roundKey}:${game.trickNumber}`) {
      seen.trickEnd = `${roundKey}:${game.trickNumber}`;
      seen.trickEndAt = performance.now();
      after.push(() => schedule(450, () => sparkle(app.querySelector('.trick .card.winner'))));
    }
    const elapsed = ending ? performance.now() - seen.trickEndAt : 0;
    const cards = game.currentTrick.map((e) => {
      const pos = posOf(e.playerId);
      const isWinner = ending && e.playerId === game.trickWinnerId;
      const el = cardEl(e.card, `${pos} ${isWinner ? 'winner' : ''}`);
      const anims = [];
      if (!seen.trickCards.has(e.card.id)) anims.push(`enter-${pos} 0.35s ease-out both`);
      if (isWinner) anims.push(`win-pop 0.4s ease-out ${Math.max(0, 450 - elapsed)}ms both`);
      if (anims.length) el.style.animation = anims.join(', ');
      seen.trickCards.add(e.card.id);
      return el;
    });
    const trick = h('div', { class: 'trick' }, cards);
    if (ending && !reducedMotion.matches) {
      // After a pause, sweep the cards onto the winner's pile.
      after.push(() => {
        const pile = app.querySelector(`.piles[data-player="${game.trickWinnerId}"]`);
        if (!pile) return;
        const a = trick.getBoundingClientRect();
        const b = pile.getBoundingClientRect();
        const dx = (b.left + b.width / 2 - (a.left + a.width / 2)) / scale;
        const dy = (b.top + b.height / 2 - (a.top + a.height / 2)) / scale;
        trick.style.setProperty('--to', `translate(${dx}px, ${dy}px)`);
        trick.style.animation = `sweep 0.5s ease-in ${Math.max(0, 1900 - elapsed)}ms forwards`;
      });
    }
    center = trick;
  } else {
    seen.trickCards = new Set();
    if (game.phase === 'playing') center = h('div', { class: 'callout quiet' }, `${nameOf(game.turnId)} ${game.turnId === me ? 'lead' : 'leads'}`);
  }

  // ----- status line + my hand -----
  let status = '';
  if (game.phase === 'bidding') status = myTurn ? 'Your call' : `${nameOf(game.turnId)} is calling`;
  else if (ending) status = game.trickWinnerId === me ? 'You take the trick!' : `${nameOf(game.trickWinnerId)} takes the trick`;
  else if (game.phase === 'playing' && myTurn)
    status = game.leadSuit ? `Your turn: follow ${SUIT_NAME[game.leadSuit].toLowerCase()} if you can` : 'Your turn: lead any card';
  else if (game.phase === 'playing') status = `${nameOf(game.turnId)} to play`;
  else if (game.phase === 'roundEnd') status = 'Round finished';

  const dealNow = isPlayer && game.phase === 'bidding' && seen.dealt !== roundKey && !reducedMotion.matches;
  if (game.phase === 'bidding') seen.dealt = roundKey;
  const canPlay = isPlayer && myTurn && game.phase === 'playing';
  const hand = h(
    'div',
    { class: 'hand', style: `--n: ${game.hand.length}` },
    game.hand.map((c, i) => {
      const legal = canPlay && game.legal.includes(c.id);
      return h(
        'button',
        {
          class: `cardbtn ${legal ? 'playable' : ''} ${canPlay && !legal ? 'blocked' : ''}`,
          style: dealNow ? `animation: deal 0.45s cubic-bezier(.2,.8,.3,1) ${i * 80}ms both` : null,
          disabled: !legal,
          'aria-label': `${c.rank} of ${SUIT_NAME[c.suit]}`,
          onclick: () => send({ type: 'play', cardId: c.id }),
        },
        cardEl(c),
      );
    }),
  );

  const slot = (pos) => {
    const p = game.players.find((q) => posOf(q.id) === pos);
    return h('div', { class: `slot ${pos}` }, p ? plate(p) : null);
  };

  return h(
    'div',
    { class: `table ${myTurn ? 'my-turn' : ''}` },
    topbar,
    slot('north'),
    slot('west'),
    h('div', { class: 'felt' }, piles, h('div', { class: 'center' }, center)),
    slot('east'),
    slot('south'),
    h('div', { class: 'hand-area' }, h('div', { class: `status ${myTurn ? 'mine' : ''}` }, status), hand),
  );
}

function resultTable(game, roundResult) {
  const rows = game.players
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const r = roundResult?.[p.id];
      const exact = r && r.bid === r.won;
      return h(
        'tr',
        { class: exact ? 'exact' : '' },
        h('td', {}, p.name),
        r ? h('td', { class: 'num' }, `${r.bid} / ${r.won}`, exact ? h('span', { class: 'tick' }, ' ✓') : null) : null,
        r ? h('td', { class: `num ${r.delta > 0 ? 'gain' : 'loss'}` }, signed(r.delta)) : null,
        h('td', { class: 'num total' }, p.score),
      );
    });
  return h(
    'table',
    {},
    h('tr', {}, h('th', {}, 'Player'), roundResult ? h('th', { class: 'num' }, 'Called / won') : null, roundResult ? h('th', { class: 'num' }, 'This round') : null, h('th', { class: 'num' }, 'Total')),
    rows,
  );
}

function scoreboardView(game) {
  const close = () => {
    scoreboardOpen = false;
    render();
  };
  const header = h('tr', {}, h('th', {}, 'Round'), game.players.map((p) => h('th', { class: 'num' }, p.name)));
  const rows = game.history.map((r) => {
    const b = callBalance(r.callTotal, r.cards);
    return h(
      'tr',
      {},
      h(
        'td',
        { class: 'roundcell' },
        h('span', { class: 'rnum' }, r.round),
        h('span', { class: `rtrump ${r.trump && isRed(r.trump) ? 'redtext' : ''}` }, r.trump ? SUIT_GLYPH[r.trump] : '–'),
        h('span', { class: 'rcards' }, plural(r.cards, 'card')),
        h('span', { class: `rbal ${b.cls}` }, b.cls === 'even' ? 'even' : `${b.cls} ${signed(r.callTotal - r.cards)}`),
      ),
      game.players.map((p) => {
        const c = r.result[p.id];
        const exact = c.bid === c.won;
        return h(
          'td',
          { class: 'num' },
          h('div', { class: 'call' }, `${c.bid}/${c.won}`, exact ? h('span', { class: 'tick' }, ' ✓') : null),
          h('div', { class: c.delta > 0 ? 'gain' : 'loss' }, signed(c.delta)),
        );
      }),
    );
  });
  const totals = h('tr', { class: 'totals' }, h('td', {}, 'Total'), game.players.map((p) => h('td', { class: 'num' }, p.score)));
  return h(
    'div',
    { class: 'overlay', onclick: (e) => e.target.classList.contains('overlay') && close() },
    h(
      'div',
      { class: 'panel scoreboard' },
      h('h2', {}, 'Scores'),
      game.history.length
        ? h('div', { class: 'scroll' }, h('table', {}, header, rows, totals))
        : h('p', {}, 'No rounds finished yet.'),
      h('p', { class: 'legend' }, 'Called/won for each player, ✓ when they made exactly their call. Under/over: total called minus cards dealt.'),
      h('button', { class: 'primary', onclick: close }, 'Back to the table'),
    ),
  );
}

function roundEndView(game, me, after) {
  const last = game.history[game.history.length - 1];
  const b = callBalance(last.callTotal, last.cards);
  const key = `${game.gameId}:${last.round}`;
  if (seen.roundEnd !== key) {
    seen.roundEnd = key;
    after.push(() => {
      for (const row of app.querySelectorAll('.panel tr.exact')) confetti(row.querySelector('.tick') ?? row, 28);
    });
  }
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, `Round ${last.round} finished`),
      h(
        'p',
        { class: 'roundmeta' },
        last.trump ? `${SUIT_NAME[last.trump]} trump` : 'No trump',
        ' · ',
        plural(last.cards, 'card'),
        ' · ',
        h('span', { class: `balance ${b.cls}` }, b.label),
      ),
      resultTable(game, last.result),
      h('button', { class: 'primary', onclick: () => send({ type: 'nextRound' }) }, `Deal round ${game.round + 1}`),
    ),
  );
}

function gameOverView(game, room, me, after) {
  const ranked = game.players.slice().sort((a, b) => b.score - a.score);
  const top = ranked.filter((p) => p.score === ranked[0].score);
  const title = top.length > 1 ? `${top.map((p) => p.name).join(' and ')} tie!` : `${top[0].name} wins!`;
  if (seen.gameOver !== game.gameId) {
    seen.gameOver = game.gameId;
    after.push(() => confettiRain());
  }
  const results = {
    posting: 'Posting the scores to the chat…',
    posted: 'Final scores and the full scoreboard (CSV) were posted in this call’s chat.',
    failed: 'Couldn’t post the scores to the chat. Check the bot setup in the README.',
  }[room.results];
  return h(
    'div',
    { class: 'gameover' },
    h('h1', {}, title),
    h('div', { class: 'panel' }, resultTable(game)),
    results ? h('p', { class: 'sub' }, results) : null,
    h(
      'div',
      { class: 'lobby-actions' },
      h('button', { onclick: () => { scoreboardOpen = true; render(); } }, 'Full scoreboard'),
      room.hostId === me ? h('button', { class: 'primary', onclick: () => send({ type: 'newGame' }) }, 'Play again') : null,
    ),
  );
}

// ---------- effects ----------
function schedule(ms, fn) {
  setTimeout(fn, Math.max(0, ms));
}

function stagePoint(el) {
  const r = el.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return { x: (r.left + r.width / 2 - s.left) / scale, y: (r.top + r.height / 2 - s.top) / scale };
}

function particles(x, y, { count, colors, spread, rise = 0, fall = 140, size = 10, duration = 1200, round = false }) {
  if (reducedMotion.matches) return;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = spread * (0.35 + Math.random() * 0.65);
    const p = document.createElement('i');
    p.className = `particle ${round ? 'round' : ''}`;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    p.style.setProperty('--dy', `${Math.sin(a) * d - rise}px`);
    p.style.setProperty('--fall', `${fall}px`);
    p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    p.style.setProperty('--size', `${size * (0.6 + Math.random() * 0.6)}px`);
    p.style.setProperty('--dur', `${duration * (0.8 + Math.random() * 0.4)}ms`);
    p.style.background = colors[i % colors.length];
    fx.append(p);
    setTimeout(() => p.remove(), duration * 1.3);
  }
}

function sparkle(el) {
  if (!el) return;
  const { x, y } = stagePoint(el);
  particles(x, y, { count: 22, colors: GOLD, spread: 110, fall: 30, size: 8, duration: 900, round: true });
}

function confetti(el, count = 40) {
  if (!el) return;
  const { x, y } = stagePoint(el);
  particles(x, y, { count, colors: CONFETTI, spread: 170, rise: 60, fall: 220, size: 12, duration: 1500 });
}

function confettiRain() {
  if (reducedMotion.matches) return;
  const w = stage.offsetWidth;
  for (let k = 0; k < 6; k++) {
    schedule(k * 260, () => {
      for (let i = 0; i < 5; i++) {
        const x = Math.random() * w;
        particles(x, -20, { count: 8, colors: CONFETTI, spread: 60, rise: -40, fall: stage.offsetHeight, size: 13, duration: 2600 });
      }
    });
  }
}
