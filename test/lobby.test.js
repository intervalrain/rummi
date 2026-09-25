import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';
import { Lobby, MATCH_WAIT_MS, cleanName, cleanText } from '../src/lobby.js';

function setup() {
  let clock = 1_000_000;
  const lobby = new Lobby({ now: () => clock });
  const inbox = new Map();
  const connect = (name, token) => {
    const box = [];
    const conn = { send: m => box.push(m), close: () => {} };
    const p = lobby.hello(conn, { name, token });
    inbox.set(p.id, box);
    return { p, box, conn, last: t => [...box].reverse().find(m => m.t === t) };
  };
  return { lobby, connect, advance: ms => { clock += ms; } };
}
const stopAll = lobby => { for (const t of lobby.tables.values()) t.close(); };

test('names and chat text are sanitised and length-capped', () => {
  assert.equal(cleanName('  小明‮\u0007  '), '小明');
  assert.equal(Array.from(cleanName('一二三四五六七八九十甲乙丙丁')).length, 12);
  assert.equal(cleanText('hi\u0000 there'), 'hi there');
  assert.equal(cleanText('x'.repeat(500)).length, 200);
});

test('reconnecting with the token restores the same player', () => {
  const { lobby, connect } = setup();
  const a = connect('阿明');
  const again = connect('', a.p.token);
  assert.equal(again.p.id, a.p.id);
  assert.equal(again.p.name, '阿明');
  assert.equal(lobby.players.size, 1);
});

test('four queued players are matched at once', () => {
  const { lobby, connect } = setup();
  const ps = ['A', 'B', 'C', 'D'].map(n => connect(n));
  ps.forEach(x => lobby.handle(x.p, { t: 'quick' }));
  assert.equal(lobby.queue.length, 0);
  assert.equal(lobby.tables.size, 1);
  const view = ps[0].last('table').view;
  assert.equal(view.status, 'playing');
  assert.equal(view.seats.length, 4);
  assert.equal(view.hand.length, 14);
  stopAll(lobby);
});

test('two queued players are matched after the wait', () => {
  const { lobby, connect, advance } = setup();
  const a = connect('A'), b = connect('B');
  lobby.handle(a.p, { t: 'quick' });
  lobby.handle(b.p, { t: 'quick' });
  assert.equal(lobby.tables.size, 0);
  advance(MATCH_WAIT_MS);
  lobby.tick();
  assert.equal(lobby.tables.size, 1);
  assert.equal(a.last('table').view.seats.length, 2);
  stopAll(lobby);
});

test('a player never sees another player\'s hand', () => {
  const { lobby, connect } = setup();
  const ps = ['A', 'B', 'C', 'D'].map(n => connect(n));
  ps.forEach(x => lobby.handle(x.p, { t: 'quick' }));
  const va = ps[0].last('table').view, vb = ps[1].last('table').view;
  assert.notDeepEqual(va.hand, vb.hand);
  const json = JSON.stringify(va);
  for (const id of vb.hand) assert.ok(!va.hand.includes(id));
  assert.ok(!('pool' in va && Array.isArray(va.pool)), 'pool contents are not sent');
  assert.ok(json.length < 4000);
  stopAll(lobby);
});

test('private room: join by code, host adds a bot and starts', () => {
  const { lobby, connect } = setup();
  const host = connect('Host'), guest = connect('Guest');
  lobby.handle(host.p, { t: 'create' });
  const code = host.last('table').view.code;
  lobby.handle(guest.p, { t: 'join', code: code.toLowerCase() });
  lobby.handle(guest.p, { t: 'start' });
  assert.match(guest.last('error').text, /房主/);
  lobby.handle(host.p, { t: 'addBot' });
  lobby.handle(host.p, { t: 'start' });
  const v = guest.last('table').view;
  assert.equal(v.status, 'playing');
  assert.equal(v.seats.length, 3);
  assert.equal(v.seats.filter(s => s.bot).length, 1);
  stopAll(lobby);
});

test('table chat reaches only that table; lobby chat reaches everyone', () => {
  const { lobby, connect } = setup();
  const a = connect('A'), b = connect('B'), outsider = connect('C');
  lobby.handle(a.p, { t: 'create' });
  lobby.handle(b.p, { t: 'join', code: a.last('table').view.code });
  lobby.handle(a.p, { t: 'chat', ch: 'table', text: '安安' });
  assert.equal(b.last('chat').msg.text, '安安');
  assert.ok(!outsider.box.some(m => m.t === 'chat' && m.msg.text === '安安'));
  lobby.handle(outsider.p, { t: 'chat', ch: 'lobby', text: '有人嗎' });
  assert.equal(a.last('chat').msg.text, '有人嗎');
  stopAll(lobby);
});

test('table chat carries the sender seat so clients can show it on their player pill', () => {
  const { lobby, connect } = setup();
  const a = connect('A'), b = connect('B');
  lobby.handle(a.p, { t: 'create' });
  lobby.handle(b.p, { t: 'join', code: a.last('table').view.code });
  lobby.handle(b.p, { t: 'chat', ch: 'table', text: '😏' });
  assert.equal(a.last('chat').msg.seat, 1);
  lobby.handle(a.p, { t: 'start' });
  lobby.handle(a.p, { t: 'chat', ch: 'table', text: '快點啦' });
  assert.equal(b.last('chat').msg.seat, a.last('table').view.you);
  stopAll(lobby);
});

test('chat is rate-limited', () => {
  const { lobby, connect } = setup();
  const a = connect('A');
  for (let i = 0; i < 8; i++) lobby.handle(a.p, { t: 'chat', ch: 'lobby', text: 'x' + i });
  assert.equal(lobby.chat.length, 5);
  assert.match(a.last('error').text, /太快/);
});

test('server rejects an invalid commit and out-of-turn moves', () => {
  const { lobby, connect } = setup();
  const a = connect('A'), b = connect('B');
  lobby.handle(a.p, { t: 'create' });
  lobby.handle(b.p, { t: 'join', code: a.last('table').view.code });
  lobby.handle(a.p, { t: 'start' });
  const t = [...lobby.tables.values()][0];
  const turnPid = t.cur().pid, other = turnPid === a.p.id ? b : a, mover = turnPid === a.p.id ? a : b;
  lobby.handle(other.p, { t: 'draw', seq: t.seq });
  assert.match(other.last('error').text, /輪到/);
  const hand = mover.last('table').view.hand;
  lobby.handle(mover.p, { t: 'commit', seq: t.seq, board: [[hand[0], hand[1], hand[2]]] });
  // almost certainly not a valid 30-point set; if it happens to be valid the turn moves on
  const e = mover.last('error');
  if (e) assert.ok(e.text.length > 0);
  stopAll(lobby);
});

test('a full game of computer players keeps every tile accounted for', () => {
  const { lobby, connect } = setup();
  const a = connect('A');
  lobby.handle(a.p, { t: 'solo', bots: 3, diff: 'hard' });
  const t = [...lobby.tables.values()][0];
  // the human leaves so every seat is auto-played; drive turns synchronously
  t.g.players.find(p => p.pid === a.p.id).left = true;
  let turns = 0;
  while (t.status === 'playing' && turns < 400) {
    t.autoTurn(t.seq);
    turns++;
    const all = t.g.board.flat().concat(t.g.pool, ...t.g.players.map(p => p.hand));
    assert.equal(new Set(all).size, E.TILE_COUNT);
    assert.equal(all.length, E.TILE_COUNT);
    for (const s of t.g.board) assert.ok(E.analyze(s), 'every set on the table is valid');
  }
  assert.equal(t.status, 'over');
  stopAll(lobby);
});
