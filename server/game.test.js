import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TricksGame, roundScore, trickWinner, sortCards, SCHEDULES, scoreboardCsv } from './game.js';

const P = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));
const card = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
const fixed = () => 0.5;

// Play out whatever is left of the current round with legal random-ish moves.
function finishRound(g) {
  while (['bidding', 'playing', 'trickEnd'].includes(g.phase)) {
    if (g.phase === 'trickEnd') g.collectTrick();
    else if (g.phase === 'bidding') {
      const id = g.players[g.turn].id;
      g.placeBid(id, g.allowedBids(id)[0]);
    } else {
      const id = g.players[g.turn].id;
      g.playCard(id, g.legalCards(id)[0].id);
    }
  }
}

test('scoring matches the house rules', () => {
  assert.equal(roundScore(0, 0), 10);
  assert.equal(roundScore(1, 1), 20);
  assert.equal(roundScore(4, 4), 50);
  assert.equal(roundScore(0, 1), -20);
  assert.equal(roundScore(2, 1), -20);
  assert.equal(roundScore(3, 5), -30);
});

test('highest of led suit wins unless trumped', () => {
  const t = [
    { playerId: 'a', card: card('9H') },
    { playerId: 'b', card: card('AS') }, // off-suit, no trump
    { playerId: 'c', card: card('KH') },
    { playerId: 'd', card: card('2D') },
  ];
  assert.equal(trickWinner(t, null).playerId, 'c');
  assert.equal(trickWinner(t, 'D').playerId, 'd'); // small trump beats everything
  assert.equal(trickWinner(t, 'S').playerId, 'b');
});

test('hands sort spades, hearts, clubs, diamonds, low to high', () => {
  const hand = ['2D', 'KC', '5H', 'AS', '10D', '2C', 'KH', '3S'].map(card).sort(sortCards);
  assert.deepEqual(hand.map((c) => c.id), ['3S', 'AS', '5H', 'KH', '2C', 'KC', '2D', '10D']);
});

test('game lengths', () => {
  const full = SCHEDULES.full.schedule;
  const half = SCHEDULES.half.schedule;
  assert.equal(full.length, 32);
  assert.deepEqual(full.slice(0, 12), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(full.slice(12, 16), [13, 13, 13, 13]);
  assert.deepEqual(full.slice(16, 28), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(full.slice(28), [13, 13, 13, 13]);
  assert.equal(half.length, 16);
  assert.deepEqual(half, full.slice(0, 16));
});

test('last caller cannot make total equal cards dealt (after the opening round)', () => {
  const g = new TricksGame(P, { rng: fixed });
  g.startRound(); // round 1, dealer = a
  assert.deepEqual(g.allowedBids('d'), [0, 1]); // opening round exempt
  finishRound(g);
  assert.equal(g.phase, 'roundEnd');

  g.startRound(); // round 2, dealer = b, last caller = a
  g.placeBid('b', 0);
  g.placeBid('c', 1);
  g.placeBid('d', 0);
  assert.deepEqual(g.allowedBids('a'), [0, 2]); // 1 would make total 2
  assert.throws(() => g.placeBid('a', 1));
  g.placeBid('a', 2);
  assert.equal(g.phase, 'playing');
  assert.equal(g.players[g.turn].id, 'b'); // dealer leads
});

test('the 1-card round on the way down is not exempt', () => {
  const g = new TricksGame(P, { rng: fixed, schedule: [1, 1] });
  g.startRound();
  finishRound(g);
  g.startRound(); // second 1-card round, dealer = b, last caller = a
  g.placeBid('b', 0);
  g.placeBid('c', 0);
  g.placeBid('d', 0);
  assert.deepEqual(g.allowedBids('a'), [0]);
});

test('must follow suit when able', () => {
  const g = new TricksGame(P, { rng: fixed });
  g.startRound();
  for (const id of ['a', 'b', 'c', 'd']) g.placeBid(id, 0);
  g.hands = { a: [card('5H')], b: [card('2H'), card('AS')], c: [card('3D')], d: [card('4C')] };
  g.turn = 0;
  g.playCard('a', '5H');
  assert.throws(() => g.playCard('b', 'AS'));
  assert.deepEqual(g.legalCards('b').map((c) => c.id), ['2H']);
});

test('a finished trick stays on the table until collected', () => {
  const g = new TricksGame(P, { rng: fixed, schedule: [2, 2] });
  g.startRound();
  g.placeBid('a', 0);
  g.placeBid('b', 0);
  g.placeBid('c', 0);
  g.placeBid('d', 1);
  g.hands = {
    a: [card('5H'), card('2S')],
    b: [card('KH'), card('3S')],
    c: [card('2H'), card('4S')],
    d: [card('3H'), card('5S')],
  };
  g.trump = null;
  for (const [id, c] of [['a', '5H'], ['b', 'KH'], ['c', '2H'], ['d', '3H']]) g.playCard(id, c);
  assert.equal(g.phase, 'trickEnd');
  assert.equal(g.currentTrick.length, 4);
  assert.equal(g.trickWinnerId, 'b');
  assert.equal(g.viewFor('a').turnId, null); // nobody can play during the pause
  assert.throws(() => g.playCard('b', '3S'));
  g.collectTrick();
  assert.equal(g.phase, 'playing');
  assert.equal(g.tricksWon.b, 1);
  assert.equal(g.players[g.turn].id, 'b'); // winner leads next
});

test('13-card rounds have no trump and a full game ends after 32 rounds', () => {
  const g = new TricksGame(P);
  let rounds = 0;
  while (g.phase !== 'gameOver') {
    g.startRound();
    rounds++;
    if (g.round === 13) assert.equal(g.trump, null);
    else assert.ok(g.trump);
    finishRound(g);
  }
  assert.equal(rounds, 32);
  assert.equal(g.history.length, 32);
  const total = Object.values(g.scores).reduce((a, b) => a + b, 0);
  const fromHistory = g.history.reduce((s, r) => s + Object.values(r.result).reduce((a, c) => a + c.delta, 0), 0);
  assert.equal(total, fromHistory);
  const csv = scoreboardCsv(g).replace(/^\uFEFF/, '').trim().split('\n');
  assert.equal(csv.length, 1 + 32 + 1);
  assert.match(csv[0], /^Round,Cards,Trump,Total called,Over\/under,A called/);
  assert.match(csv[1], /^1,1,\w+,\d+,(under|over|even)/);
});
