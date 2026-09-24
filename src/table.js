// One game table. The server holds the real state; clients only see their own hand.
import crypto from 'node:crypto';
import * as E from '../public/engine.js';

export const TURN_MS = 90_000;   // time a connected player gets per turn
export const AWAY_MS = 20_000;   // time before a disconnected player's turn is auto-played
const BOT_DELAY = [900, 1500];
const CHAT_KEEP = 60;

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const wrap = board => board.map((tiles, i) => ({ id: i + 1, tiles }));

/**
 * hub: { send(pid, msg), isOnline(pid), nameOf(pid) }
 */
export class Table {
  constructor(hub, code, { priv = true, host = null, diff = 'hard' } = {}) {
    this.hub = hub;
    this.code = code;
    this.priv = priv;
    this.host = host;
    this.diff = diff;
    this.seats = [null, null, null, null];
    this.status = 'waiting';          // waiting | playing | over
    this.g = null;
    this.seq = 0;
    this.msgN = 0;
    this.chat = [];
    this.timer = null;
    this.turnEnds = 0;
    this.createdAt = Date.now();
  }

  /* ---------- membership ---------- */
  /** Humans who receive this table's updates. */
  members() {
    if (this.status === 'waiting') return this.seats.filter(s => s && !s.bot).map(s => s.pid);
    return this.g.players.filter(p => !p.bot && !p.left).map(p => p.pid);
  }
  has(pid) { return this.members().includes(pid); }
  pname(p) { return p.bot ? p.name : this.hub.nameOf(p.pid); }

  addHuman(pid) {
    if (this.status !== 'waiting') return false;
    if (this.seats.some(s => s && s.pid === pid)) return true;
    const i = this.seats.findIndex(s => !s);
    if (i < 0) return false;
    this.seats[i] = { pid, bot: false };
    if (!this.host) this.host = pid;
    this.touch();
    return true;
  }
  addBot() {
    if (this.status !== 'waiting') return false;
    const i = this.seats.findIndex(s => !s);
    if (i < 0) return false;
    const used = new Set(this.seats.filter(s => s && s.bot).map(s => s.name));
    this.seats[i] = { bot: true, name: E.BOTS.find(n => !used.has(n)) };
    this.touch();
    return true;
  }
  removeBot(i) {
    if (this.status !== 'waiting' || !this.seats[i]?.bot) return false;
    this.seats[i] = null;
    this.touch();
    return true;
  }
  /** A human leaves. Mid-game their seat is auto-played from then on. */
  removeHuman(pid) {
    if (this.status === 'waiting') {
      const i = this.seats.findIndex(s => s && s.pid === pid);
      if (i >= 0) this.seats[i] = null;
    } else {
      const p = this.g.players.find(p => p.pid === pid);
      if (p) { p.left = true; p.leftName = this.hub.nameOf(pid); }
    }
    if (this.host === pid) this.host = this.members()[0] || null;
    if (this.status === 'playing' && this.cur().pid === pid) { this.scheduleTurn(); }
    this.touch();
  }
  /** Called when a member connects or disconnects. */
  presenceChanged(pid) {
    if (this.status === 'playing' && this.cur().pid === pid && !this.hub.isOnline(pid)) {
      if (this.turnEnds - Date.now() > AWAY_MS) this.scheduleTurn(AWAY_MS);
    }
    this.broadcast();
  }

  /* ---------- game flow ---------- */
  cur() { return this.g.players[this.g.turn]; }

  start(by) {
    if (this.status !== 'waiting') return '牌局已經開始';
    if (by && by !== this.host) return '只有房主可以開始';
    const filled = this.seats.filter(Boolean);
    if (filled.length < 2) return '至少要 2 位玩家（可以加電腦）';
    const pool = shuffle([...Array(E.TILE_COUNT).keys()]);
    const players = filled.map(s => ({ pid: s.pid || null, bot: !!s.bot, name: s.name || null, hand: pool.splice(0, 14), melded: false, left: false }));
    this.g = { players, board: [], pool, turn: crypto.randomInt(players.length), passes: 0, over: null, msg: null };
    this.status = 'playing';
    this.seq++;
    this.scheduleTurn();
    this.broadcast();
    return null;
  }

  scheduleTurn(forceMs) {
    clearTimeout(this.timer);
    if (this.status !== 'playing') return;
    const p = this.cur(), seq = this.seq;
    if (p.bot || p.left) {
      this.turnEnds = 0;
      const d = BOT_DELAY[0] + Math.random() * (BOT_DELAY[1] - BOT_DELAY[0]);
      this.timer = setTimeout(() => this.autoTurn(seq), d);
      return;
    }
    const ms = forceMs ?? (this.hub.isOnline(p.pid) ? TURN_MS : AWAY_MS);
    this.turnEnds = Date.now() + ms;
    this.timer = setTimeout(() => this.onTimeout(seq), ms);
  }

  onTimeout(seq) {
    if (seq !== this.seq || this.status !== 'playing') return;
    if (!this.hub.isOnline(this.cur().pid)) this.autoTurn(seq);
    else this.doDraw(this.g.turn, 'timeout');
  }

  /** Plays the current seat with the solver (computer players, absent humans). */
  autoTurn(seq) {
    if (seq !== this.seq || this.status !== 'playing') return;
    const g = this.g, i = g.turn, p = g.players[i];
    const full = !p.bot || this.diff === 'hard';
    let plan = E.bestPlan(p.hand, p.melded, wrap(g.board), full, 450);
    if (plan && plan.initial && plan.value < 30) plan = null;
    if (!plan) return this.doDraw(i, p.bot ? 'draw' : 'autodraw');
    const played = new Set(plan.played);
    g.board = plan.board.map(s => E.analyze(s.tiles).order);
    p.hand = p.hand.filter(id => !played.has(id));
    if (plan.initial) p.melded = true;
    g.passes = 0;
    this.setMsg(i, p.bot ? 'play' : 'autoplay', plan.played.length, plan.initial);
    if (!p.hand.length) return this.finish(i, `${this.pname(p)} 出完了手牌`);
    this.advance();
  }

  commit(pid, seq, board) {
    if (this.status !== 'playing') return '牌局沒有在進行';
    const g = this.g, i = g.turn, p = g.players[i];
    if (p.pid !== pid) return '還沒輪到你';
    if (seq !== this.seq) return '牌局已經更新，請再試一次';
    const r = E.validateTurn(g.board, board, p.hand, p.melded);
    if (r.err) return r.err;
    const added = new Set(r.added);
    g.board = board.map(s => E.analyze(s).order);
    p.hand = p.hand.filter(id => !added.has(id));
    p.melded = true;
    g.passes = 0;
    this.setMsg(i, 'play', r.added.length, r.initial);
    if (!p.hand.length) { this.finish(i, `${this.pname(p)} 出完了手牌`); return null; }
    this.advance();
    return null;
  }

  draw(pid, seq) {
    if (this.status !== 'playing') return '牌局沒有在進行';
    if (this.cur().pid !== pid) return '還沒輪到你';
    if (seq !== this.seq) return '牌局已經更新，請再試一次';
    this.doDraw(this.g.turn, 'draw');
    return null;
  }

  doDraw(i, kind) {
    const g = this.g;
    if (!g.pool.length) {
      g.passes++;
      this.setMsg(i, 'pass', 0);
      if (g.passes >= g.players.length) {
        const best = g.players.map((p, k) => ({ k, v: E.handValue(p.hand) })).sort((a, b) => a.v - b.v)[0];
        return this.finish(best.k, '牌堆用完了，手牌點數最低的人獲勝');
      }
    } else {
      g.players[i].hand.push(g.pool.pop());
      g.passes = 0;
      this.setMsg(i, kind, 1);
    }
    this.advance();
  }

  /** Relays the current player's in-progress table to everyone else. */
  preview(pid, seq, board) {
    if (this.status !== 'playing' || seq !== this.seq || this.cur().pid !== pid) return;
    if (!Array.isArray(board) || board.length > 60) return;
    const allowed = new Set(this.g.board.flat().concat(this.cur().hand)), seen = new Set();
    for (const s of board) {
      if (!Array.isArray(s) || s.length > 13) return;
      for (const id of s) { if (!allowed.has(id) || seen.has(id)) return; seen.add(id); }
    }
    for (const m of this.members()) if (m !== pid) this.hub.send(m, { t: 'preview', seq, board });
  }

  rematch(pid) {
    if (this.status !== 'over' || !this.has(pid)) return '現在不能重新開局';
    const seats = this.g.players.filter(p => !p.left).map(p => (p.bot ? { bot: true, name: p.name } : { pid: p.pid, bot: false }));
    while (seats.length < 4) seats.push(null);
    this.seats = seats;
    if (!this.members().includes(this.host)) this.host = pid;
    this.status = 'waiting';
    this.g = null;
    this.touch();
    return null;
  }

  setMsg(seat, kind, cnt, initial = false) { this.g.msg = { n: ++this.msgN, seat, kind, cnt, initial }; }
  advance() {
    this.g.turn = (this.g.turn + 1) % this.g.players.length;
    this.seq++;
    this.scheduleTurn();
    this.broadcast();
  }
  finish(w, reason) {
    clearTimeout(this.timer);
    const g = this.g;
    const vals = g.players.map(p => E.handValue(p.hand));
    const gain = vals.reduce((a, v, k) => (k === w ? a : a + v), 0);
    g.over = { winner: w, reason, scores: g.players.map((p, k) => ({ left: p.hand.length, score: k === w ? gain : -vals[k] })) };
    this.status = 'over';
    this.seq++;
    this.broadcast();
  }

  /* ---------- chat ---------- */
  addChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    for (const m of this.members()) this.hub.send(m, { t: 'chat', ch: 'table', msg });
  }
  sys(text) { this.addChat({ id: crypto.randomUUID(), sys: true, text, ts: Date.now() }); }

  /* ---------- views ---------- */
  touch() { this.seq++; this.broadcast(); }
  broadcast() { for (const pid of this.members()) this.hub.send(pid, { t: 'table', view: this.view(pid) }); }
  close() { clearTimeout(this.timer); this.status = 'closed'; }

  view(pid) {
    const base = { code: this.code, priv: this.priv, status: this.status, isHost: this.host === pid, seq: this.seq, diff: this.diff };
    if (this.status === 'waiting') {
      return {
        ...base,
        you: this.seats.findIndex(s => s && s.pid === pid),
        seats: this.seats.map(s => s && {
          name: s.bot ? s.name : this.hub.nameOf(s.pid),
          bot: !!s.bot,
          online: s.bot || this.hub.isOnline(s.pid),
          isHost: !s.bot && s.pid === this.host,
        }),
      };
    }
    const g = this.g, you = g.players.findIndex(p => p.pid === pid);
    return {
      ...base,
      you,
      seats: g.players.map(p => ({
        name: p.left ? p.leftName : this.pname(p),
        bot: p.bot,
        left: p.left,
        online: p.bot || (!p.left && this.hub.isOnline(p.pid)),
        count: p.hand.length,
        melded: p.melded,
      })),
      hand: you >= 0 ? g.players[you].hand.slice() : [],
      board: g.board,
      pool: g.pool.length,
      turn: g.turn,
      turnLeft: this.status === 'playing' && this.turnEnds ? Math.max(0, this.turnEnds - Date.now()) : 0,
      turnTotal: TURN_MS,
      msg: g.msg,
      over: g.over,
    };
  }
}
