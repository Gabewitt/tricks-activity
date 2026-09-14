// Rules engine for "Tricks". No Discord or networking in here, so it can be
// unit-tested on its own (see game.test.js).

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEATS = 4;

// Cards dealt per round, in order: 1 card up to 13. The 13-card round has no
// trump because no card is left to turn over. If the family plays it
// differently (e.g. back down to 1 again), edit this list.
export const DEFAULT_SCHEDULE = Array.from({ length: 13 }, (_, i) => i + 1);

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
const sortCards = (a, b) =>
  SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || rankValue(b) - rankValue(a);

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
  /** @param {{id:string,name:string}[]} players exactly 4, in seat order */
  constructor(players, rng = Math.random, schedule = DEFAULT_SCHEDULE) {
    if (players.length !== SEATS) throw new Error('Tricks needs exactly 4 players');
    this.players = players;
    this.rng = rng;
    this.schedule = schedule;
    this.scores = Object.fromEntries(players.map((p) => [p.id, 0]));
    this.roundIndex = -1; // index into schedule
    this.round = 0; // cards dealt this round
    this.dealer = -1;
    this.phase = 'lobby'; // lobby | bidding | playing | roundEnd | gameOver
    this.history = [];
    this.lastTrick = null;
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
    if (this.round === 1 || this.seatOf(playerId) !== this.lastBidderSeat) return all;
    const others = Object.entries(this.bids)
      .filter(([id]) => id !== playerId)
      .reduce((sum, [, b]) => sum + b, 0);
    const forbidden = this.round - others;
    return all.filter((b) => b !== forbidden);
  }

  placeBid(playerId, bid) {
    if (this.phase !== 'bidding') throw new Error('Not bidding now');
    if (this.players[this.turn].id !== playerId) throw new Error('Not your turn to bid');
    if (!Number.isInteger(bid) || !this.allowedBids(playerId).includes(bid))
      throw new Error('That bid is not allowed');
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
    if (this.currentTrick.length === SEATS) this.resolveTrick();
  }

  resolveTrick() {
    const winner = trickWinner(this.currentTrick, this.trump);
    this.tricksWon[winner.playerId] += 1;
    this.trickNumber += 1;
    this.lastTrick = { cards: this.currentTrick, winnerId: winner.playerId };
    this.currentTrick = [];
    this.leadSuit = null;
    if (this.trickNumber === this.round) this.endRound();
    else this.turn = this.seatOf(winner.playerId);
  }

  endRound() {
    const result = {};
    for (const p of this.players) {
      const delta = roundScore(this.bids[p.id], this.tricksWon[p.id]);
      this.scores[p.id] += delta;
      result[p.id] = { bid: this.bids[p.id], won: this.tricksWon[p.id], delta, total: this.scores[p.id] };
    }
    this.history.push({ round: this.roundIndex + 1, cards: this.round, trump: this.trump, result });
    this.phase = this.roundIndex === this.schedule.length - 1 ? 'gameOver' : 'roundEnd';
  }

  /** What one player is allowed to see. Other hands are only counts. */
  viewFor(playerId) {
    const isPlayer = this.players.some((p) => p.id === playerId);
    return {
      phase: this.phase,
      round: this.roundIndex + 1,
      totalRounds: this.schedule.length,
      cards: this.round,
      dealerId: this.players[this.dealer]?.id ?? null,
      turnId: this.phase === 'bidding' || this.phase === 'playing' ? this.players[this.turn].id : null,
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
      lastTrick: this.lastTrick,
      hand: isPlayer ? this.hands?.[playerId] ?? [] : [],
      legal: isPlayer && this.phase === 'playing' ? this.legalCards(playerId).map((c) => c.id) : [],
      allowedBids: isPlayer && this.phase === 'bidding' ? this.allowedBids(playerId) : [],
      history: this.history,
    };
  }
}
