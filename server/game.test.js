import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TricksGame, DEFAULT_SCHEDULE, roundScore, trickWinner } from './game.js';

const P = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));
const card = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });

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

test('last bidder cannot make total equal cards dealt (after round 1)', () => {
  const g = new TricksGame(P, () => 0.5);
  g.startRound(); // round 1, dealer = a
  assert.deepEqual(g.allowedBids('d'), [0, 1]); // round 1 exempt
  for (const id of ['a', 'b', 'c', 'd']) g.placeBid(id, 0);
  // play round 1 out quickly
  while (g.phase === 'playing') g.playCard(g.players[g.turn].id, g.hands[g.players[g.turn].id][0].id);
  assert.equal(g.phase, 'roundEnd');

  g.startRound(); // round 2, dealer = b, last bidder = a
  g.placeBid('b', 0);
  g.placeBid('c', 1);
  g.placeBid('d', 0);
  assert.deepEqual(g.allowedBids('a'), [0, 2]); // 1 would make total 2
  assert.throws(() => g.placeBid('a', 1));
  g.placeBid('a', 2);
  assert.equal(g.phase, 'playing');
  assert.equal(g.players[g.turn].id, 'b'); // dealer leads
});

test('must follow suit when able', () => {
  const g = new TricksGame(P, () => 0.5);
  g.startRound();
  for (const id of ['a', 'b', 'c', 'd']) g.placeBid(id, 0);
  g.phase = 'playing';
  g.hands = { a: [card('5H')], b: [card('2H'), card('AS')], c: [card('3D')], d: [card('4C')] };
  g.round = 1;
  g.turn = 0;
  g.playCard('a', '5H');
  assert.throws(() => g.playCard('b', 'AS'));
  assert.deepEqual(g.legalCards('b').map((c) => c.id), ['2H']);
});

test('13-card round has no trump; schedule is 1..13', () => {
  assert.deepEqual(DEFAULT_SCHEDULE, Array.from({ length: 13 }, (_, i) => i + 1));
  const g = new TricksGame(P, () => 0.5, [13, 13]);
  g.startRound();
  assert.equal(g.round, 13);
  assert.equal(g.trump, null);
  assert.equal(g.hands.a.length, 13);
  assert.equal(g.roundIndex, 0);
});

test('game ends after the last scheduled round', () => {
  const g = new TricksGame(P, () => 0.5, [1]);
  g.startRound();
  for (const id of ['a', 'b', 'c', 'd']) g.placeBid(id, 0);
  while (g.phase === 'playing') g.playCard(g.players[g.turn].id, g.hands[g.players[g.turn].id][0].id);
  assert.equal(g.phase, 'gameOver');
});
