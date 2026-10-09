// Rules engine for "Tricks". No Discord or networking in here, so it can be
// unit-tested on its own (see game.test.js).

export const SUITS = ['S', 'H', 'C', 'D']; // also the order cards are sorted in a hand
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEATS = 4;

// Cards dealt per round, in order. 13-card rounds have no trump because no
// card is left to turn over. Four 13-card rounds in a row = each player deals one.
const up = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const down = [...up].reverse(); // 12..1
const thirteens = [13, 13, 13, 13];
export const SCHEDULES = {
  full: { label: 'Full game', schedule: [...up, ...thirteens, ...down, ...thirteens] }, // 32 rounds
  half: { label: 'Half game', schedule: [...up, ...thirteens] }, // 16 rounds
};
export const DEFAULT_LENGTH = 'full';

export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ id: rank + suit, rank, suit });
  return deck;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const rankValue = (card) => RANKS.indexOf(card.rank);
// Spades, hearts, clubs, diamonds; lowest card first within each suit (2 ... A).
export const sortCards = (a, b) =>
  SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || rankValue(a) - rankValue(b);

export function roundScore(bid, won) {
  if (bid === won) return 10 + 10 * bid;
  return -(10 + 10 * Math.abs(bid - won));
}

export function trickWinner(trick, trump) {
  // trick: [{ playerId, card }] in play order; first entry led.
  let best = trick[0];
  for (const entry of trick.slice(1)) {
    const c = entry.card;
    const b = best.card;
    if (trump && c.suit === trump && b.suit !== trump) best = entry;
    else if (c.suit === b.suit && rankValue(c) > rankValue(b)) best = entry;
  }
  return best;
}

export class TricksGame {
  /**
   * @param {{id:string,name:string}[]} players exactly 4, in seat order
   * @param {{ length?: keyof SCHEDULES, schedule?: number[], rng?: () => number }} [opts]
   */
  constructor(players, opts = {}) {
    if (players.length !== SEATS) throw new Error('Tricks needs exactly 4 players');
    const length = SCHEDULES[opts.length] ? opts.length : DEFAULT_LENGTH;
    this.players = players;
    this.rng = opts.rng ?? Math.random;
    this.length = opts.schedule ? 'custom' : length;
    this.schedule = opts.schedule ?? SCHEDULES[length].schedule;
    this.scores = Object.fromEntries(players.map((p) => [p.id, 0]));
    this.roundIndex = -1; // index into schedule
    this.round = 0; // cards dealt this round
    this.dealer = -1;
    // lobby | bidding | playing | trickEnd | roundEnd | gameOver
    // trickEnd: all four cards are on the table and the winner is known, but
    // the trick hasn't been collected yet, so everyone gets to see it.
    this.phase = 'lobby';
    this.history = [];
    this.lastTrick = null;
    this.startedAt = new Date().toISOString();
  }

  seatOf(id) {
    const s = this.players.findIndex((p) => p.id === id);
    if (s < 0) throw new Error('Not a player');
    return s;
  }

  startRound() {
    if (!['lobby', 'roundEnd'].includes(this.phase)) throw new Error('Round in progress');
    this.roundIndex += 1;
    this.round = this.schedule[this.roundIndex];
    this.dealer = (this.dealer + 1) % SEATS;
    const deck = shuffle(makeDeck(), this.rng);
    this.hands = {};
    for (const p of this.players) this.hands[p.id] = deck.splice(0, this.round).sort(sortCards);
    this.trumpCard = deck.length ? deck[0] : null; // 13-card rounds: nothing left, no trump
    this.trump = this.trumpCard ? this.trumpCard.suit : null;
    this.bids = {};
    this.tricksWon = Object.fromEntries(this.players.map((p) => [p.id, 0]));
    this.currentTrick = [];
    this.trickWinnerId = null;
    this.leadSuit = null;
    this.trickNumber = 0;
    this.lastTrick = null;
    this.turn = this.dealer; // dealer bids first and leads the first trick
    this.phase = 'bidding';
  }

  get lastBidderSeat() {
    return (this.dealer + SEATS - 1) % SEATS;
  }

  allowedBids(playerId) {
    const all = Array.from({ length: this.round + 1 }, (_, i) => i);
    // Only the opening round of the game is exempt from the "can't add up" rule.
    if (this.roundIndex === 0 || this.seatOf(playerId) !== this.lastBidderSeat) return all;
    const others = Object.entries(this.bids)
      .filter(([id]) => id !== playerId)
      .reduce((sum, [, b]) => sum + b, 0);
    const forbidden = this.round - others;
    return all.filter((b) => b !== forbidden);
  }

  placeBid(playerId, bid) {
    if (this.phase !== 'bidding') throw new Error('Not bidding now');
    if (this.players[this.turn].id !== playerId) throw new Error('Not your turn to call');
    if (!Number.isInteger(bid) || !this.allowedBids(playerId).includes(bid))
      throw new Error('That call is not allowed');
    this.bids[playerId] = bid;
    this.turn = (this.turn + 1) % SEATS;
    if (Object.keys(this.bids).length === SEATS) {
      this.phase = 'playing';
      this.turn = this.dealer;
    }
  }

  legalCards(playerId) {
    const hand = this.hands[playerId];
    if (!this.leadSuit) return hand;
    const following = hand.filter((c) => c.suit === this.leadSuit);
    return following.length ? following : hand;
  }

  playCard(playerId, cardId) {
    if (this.phase !== 'playing') throw new Error('Not playing now');
    if (this.players[this.turn].id !== playerId) throw new Error('Not your turn');
    const card = this.legalCards(playerId).find((c) => c.id === cardId);
    if (!card) throw new Error('You must follow suit if you can');
    this.hands[playerId] = this.hands[playerId].filter((c) => c.id !== cardId);
    this.currentTrick.push({ playerId, card });
    if (this.currentTrick.length === 1) this.leadSuit = card.suit;
    this.turn = (this.turn + 1) % SEATS;
    if (this.currentTrick.length === SEATS) {
      this.trickWinnerId = trickWinner(this.currentTrick, this.trump).playerId;
      this.phase = 'trickEnd'; // the server calls collectTrick() after a short pause
    }
  }

  collectTrick() {
    if (this.phase !== 'trickEnd') return;
    const winnerId = this.trickWinnerId;
    this.tricksWon[winnerId] += 1;
    this.trickNumber += 1;
    this.lastTrick = { cards: this.currentTrick, winnerId };
    this.currentTrick = [];
    this.trickWinnerId = null;
    this.leadSuit = null;
    if (this.trickNumber === this.round) return this.endRound();
    this.phase = 'playing';
    this.turn = this.seatOf(winnerId);
  }

  endRound() {
    const result = {};
    for (const p of this.players) {
      const delta = roundScore(this.bids[p.id], this.tricksWon[p.id]);
      this.scores[p.id] += delta;
      result[p.id] = { bid: this.bids[p.id], won: this.tricksWon[p.id], delta, total: this.scores[p.id] };
    }
    const callTotal = Object.values(this.bids).reduce((a, b) => a + b, 0);
    this.history.push({
      round: this.roundIndex + 1,
      cards: this.round,
      trump: this.trump,
      dealerId: this.players[this.dealer].id,
      callTotal,
      result,
    });
    this.phase = this.roundIndex === this.schedule.length - 1 ? 'gameOver' : 'roundEnd';
    if (this.phase === 'gameOver') this.endedAt = new Date().toISOString();
  }

  /** What one player is allowed to see. Other hands are only counts. */
  viewFor(playerId) {
    const isPlayer = this.players.some((p) => p.id === playerId);
    const active = this.phase === 'bidding' || this.phase === 'playing';
    return {
      gameId: this.startedAt,
      phase: this.phase,
      length: this.length,
      round: this.roundIndex + 1,
      totalRounds: this.schedule.length,
      cards: this.round,
      trickNumber: this.trickNumber ?? 0,
      dealerId: this.players[this.dealer]?.id ?? null,
      turnId: active ? this.players[this.turn].id : null,
      trump: this.trump ?? null,
      trumpCard: this.trumpCard ?? null,
      leadSuit: this.leadSuit ?? null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: this.scores[p.id],
        bid: this.bids?.[p.id] ?? null,
        won: this.tricksWon?.[p.id] ?? 0,
        cardsLeft: this.hands?.[p.id]?.length ?? 0,
      })),
      currentTrick: this.currentTrick ?? [],
      trickWinnerId: this.trickWinnerId ?? null,
      lastTrick: this.lastTrick,
      hand: isPlayer ? this.hands?.[playerId] ?? [] : [],
      legal: isPlayer && this.phase === 'playing' ? this.legalCards(playerId).map((c) => c.id) : [],
      allowedBids: isPlayer && this.phase === 'bidding' ? this.allowedBids(playerId) : [],
      history: this.history,
    };
  }
}

/** Full scoreboard as CSV: one row per round, four columns per player. */
export function scoreboardCsv(game) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const suitName = { S: 'Spades', H: 'Hearts', C: 'Clubs', D: 'Diamonds' };
  const head = ['Round', 'Cards', 'Trump', 'Total called', 'Over/under'];
  for (const p of game.players) head.push(`${p.name} called`, `${p.name} made`, `${p.name} points`, `${p.name} total`);
  const rows = [head];
  for (const r of game.history) {
    const diff = r.callTotal - r.cards;
    const balance = diff < 0 ? `under ${-diff}` : diff > 0 ? `over ${diff}` : 'even';
    const row = [r.round, r.cards, r.trump ? suitName[r.trump] : 'None', r.callTotal, balance];
    for (const p of game.players) {
      const c = r.result[p.id];
      row.push(c.bid, c.won, c.delta, c.total);
    }
    rows.push(row);
  }
  const final = ['Final', '', '', '', ''];
  for (const p of game.players) final.push('', '', '', game.scores[p.id]);
  rows.push(final);
  // The BOM makes Excel read accented names correctly.
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}
