import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';

// tile id helpers: color 0-3 (black, red, blue, orange), number 1-13, copy 0/1
const t = (c, n, copy = 0) => copy * 52 + c * 13 + n - 1;
const J0 = 104, J1 = 105;

test('analyze accepts runs and groups, rejects bad sets', () => {
  assert.equal(E.analyze([t(1, 3), t(1, 4), t(1, 5)]).type, 'run');
  assert.equal(E.analyze([t(0, 7), t(1, 7), t(2, 7), t(3, 7)]).type, 'group');
  assert.equal(E.analyze([t(1, 3), t(1, 4)]), null);
  assert.equal(E.analyze([t(1, 3), t(2, 4), t(1, 5)]), null);
  assert.equal(E.analyze([t(0, 7), t(0, 7, 1), t(2, 7)]), null, 'duplicate colour in group');
  assert.equal(E.analyze([t(1, 12), t(1, 13), t(1, 1)]), null, 'no wrap-around');
});

test('analyze places jokers in the gap and values them', () => {
  const r = E.analyze([t(2, 5), J0, t(2, 7)]);
  assert.equal(r.type, 'run');
  assert.deepEqual(r.order, [t(2, 5), J0, t(2, 7)]);
  assert.equal(r.value, 18);
  const top = E.analyze([t(2, 12), t(2, 13), J1]);
  assert.deepEqual(top.order, [J1, t(2, 12), t(2, 13)], 'joker extends downward when 13 is the top');
});

test('validateTurn enforces the 30-point initial meld from hand only', () => {
  const hand = [t(0, 10), t(1, 10), t(2, 10), t(0, 1), t(0, 2), t(0, 3)];
  assert.match(E.validateTurn([], [[t(0, 1), t(0, 2), t(0, 3)]], hand, false).err, /30/);
  const ok = E.validateTurn([], [[t(0, 10), t(1, 10), t(2, 10)]], hand, false);
  assert.equal(ok.ok, true);
  assert.equal(ok.initial, true);
  assert.equal(ok.value, 30);
});

test('validateTurn blocks touching the table before the initial meld', () => {
  const old = [[t(3, 4), t(3, 5), t(3, 6)]];
  const hand = [t(3, 7), t(0, 11), t(1, 11), t(2, 11)];
  const r = E.validateTurn(old, [[t(3, 4), t(3, 5), t(3, 6), t(3, 7)], [t(0, 11), t(1, 11), t(2, 11)]], hand, false);
  assert.match(r.err, /破冰前/);
});

test('validateTurn rejects tiles not in hand, removed table tiles and malformed input', () => {
  const old = [[t(3, 4), t(3, 5), t(3, 6)]];
  assert.match(E.validateTurn(old, [[t(3, 4), t(3, 5), t(3, 6), t(3, 7)]], [t(0, 1)], true).err, /不在手上/);
  assert.match(E.validateTurn(old, [], [t(0, 1)], true).err, /收回/);
  assert.match(E.validateTurn(old, 'x', [], true).err, /格式/);
  assert.match(E.validateTurn(old, [[999]], [], true).err, /格式/);
  assert.match(E.validateTurn(old, [[t(3, 4), t(3, 4), t(3, 6)]], [], true).err, /格式/);
});

test('validateTurn allows rearranging after the initial meld', () => {
  // table: black 3-4-5-6, hand: red 5 + blue 5 -> split run into 3-4 ... needs 3 tiles; use 5 group
  const old = [[t(0, 3), t(0, 4), t(0, 5), t(0, 6)]];
  const hand = [t(1, 6), t(2, 6)];
  const next = [[t(0, 3), t(0, 4), t(0, 5)], [t(0, 6), t(1, 6), t(2, 6)]];
  const r = E.validateTurn(old, next, hand, true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.added.sort(), hand.slice().sort());
});

test('bestPlan before melding maximises value and reaches 30', () => {
  const hand = [t(0, 13), t(1, 13), t(2, 13), t(0, 1), t(0, 2), t(0, 3), t(3, 9)];
  const p = E.bestPlan(hand, false, [], true, 300);
  assert.ok(p.initial);
  assert.equal(p.value, 45);
  for (const s of p.board) assert.ok(E.analyze(s.tiles));
});

test('bestPlan with rearrangement finds plays plan A cannot', () => {
  const board = [{ id: 1, tiles: [t(0, 3), t(0, 4), t(0, 5), t(0, 6)] }];
  const hand = [t(1, 6), t(2, 6), t(3, 12)];
  const simple = E.planSimple(hand, board);
  assert.equal(simple.played.length, 0);
  const p = E.bestPlan(hand, true, board, true, 500);
  assert.equal(p.played.length, 2);
  const onTable = new Set(p.board.flatMap(s => s.tiles));
  for (const id of board[0].tiles) assert.ok(onTable.has(id));
  for (const s of p.board) assert.ok(E.analyze(s.tiles));
});
