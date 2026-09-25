// Players, matchmaking queue, rooms and chat. Transport-agnostic: server.js
// feeds it messages and gives it a way to send.
import crypto from 'node:crypto';
import { Table } from './table.js';

export const MATCH_WAIT_MS = 12_000;   // with 2–3 players queued, start after this long
const CHAT_KEEP = 60;
const CHAT_BURST = 5, CHAT_WINDOW = 5_000;
const IDLE_TABLE_MS = 3 * 60_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEOPLE_MAX = 100;
// messages that can change a player's name or what they're doing, so the online list is re-sent
const STATUS_CHANGES = new Set(['name', 'solo', 'create', 'join', 'leave', 'start', 'rematch']);

const INVISIBLE = '\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069';
const NAME_BAD = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f' + INVISIBLE + ']', 'g');
const TEXT_BAD = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f' + INVISIBLE + ']', 'g');

export function cleanName(v) {
  const s = Array.from(String(v ?? '').replace(NAME_BAD, '').trim()).slice(0, 12).join('');
  return s;
}
export function cleanText(v) {
  return Array.from(String(v ?? '').replace(TEXT_BAD, '').trim()).slice(0, 200).join('');
}

export class Lobby {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.players = new Map();   // id -> player
    this.byToken = new Map();   // token -> player
    this.tables = new Map();    // code -> Table
    this.queue = [];            // [{pid, since}]
    this.chat = [];
    this.hub = {
      send: (pid, msg) => this.send(pid, msg),
      isOnline: pid => !!this.players.get(pid)?.conn,
      nameOf: pid => this.players.get(pid)?.name || '玩家',
    };
  }

  /* ---------- connections ---------- */
  /** conn: { send(obj), close() }. Returns the player. */
  hello(conn, { token, name } = {}) {
    let p = typeof token === 'string' ? this.byToken.get(token) : null;
    if (p && p.conn && p.conn !== conn) p.conn.close();
    if (!p) {
      p = { id: crypto.randomUUID(), token: crypto.randomBytes(24).toString('base64url'), name: '', table: null, chatTimes: [], seen: 0 };
      this.players.set(p.id, p);
      this.byToken.set(p.token, p);
    }
    p.conn = conn;
    p.seen = this.now();
    p.name = cleanName(name) || p.name || `玩家${crypto.randomInt(100, 1000)}`;
    this.send(p.id, { t: 'welcome', id: p.id, token: p.token, name: p.name });
    this.send(p.id, { t: 'chatHistory', ch: 'lobby', list: this.chat });
    const t = p.table && this.tables.get(p.table);
    if (t && t.has(p.id)) {
      this.send(p.id, { t: 'chatHistory', ch: 'table', list: t.chat });
      t.presenceChanged(p.id);
    } else {
      p.table = null;
    }
    this.stats();
    return p;
  }

  disconnect(p, conn) {
    if (p.conn !== conn) return;
    p.conn = null;
    p.seen = this.now();
    this.unqueue(p, true);
    const t = p.table && this.tables.get(p.table);
    if (t) t.presenceChanged(p.id);
    this.stats();
  }

  send(pid, msg) {
    const p = this.players.get(pid);
    if (p?.conn) p.conn.send(msg);
  }

  stats() {
    const online = [...this.players.values()].filter(p => p.conn);
    const people = online.slice(0, PEOPLE_MAX).map(p => ({ id: p.id, name: p.name, st: this.activity(p) }));
    const msg = { t: 'stats', online: online.length, queue: this.queue.length, people };
    for (const p of online) p.conn.send(msg);
  }
  /** lobby | queue | room (waiting for the host) | game */
  activity(p) {
    if (this.queue.some(q => q.pid === p.id)) return 'queue';
    const t = p.table && this.tables.get(p.table);
    if (!t) return 'lobby';
    return t.status === 'waiting' ? 'room' : 'game';
  }

  /* ---------- message router ---------- */
  handle(p, m) {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    this.route(p, m);
    if (STATUS_CHANGES.has(m.t)) this.stats();
  }
  route(p, m) {
    const err = text => this.send(p.id, { t: 'error', text });
    const t = p.table && this.tables.get(p.table);
    switch (m.t) {
      case 'name': {
        const n = cleanName(m.name);
        if (!n) return err('暱稱不能是空的');
        p.name = n;
        this.send(p.id, { t: 'welcome', id: p.id, token: p.token, name: p.name });
        if (t) t.broadcast();
        return;
      }
      case 'chat': return this.chatMsg(p, m.ch, m.text);
      case 'quick': return this.enqueue(p);
      case 'unqueue': return this.unqueue(p);
      case 'solo': {
        const bots = Math.min(3, Math.max(1, m.bots | 0));
        const nt = this.createTable(p, { priv: true, diff: m.diff === 'easy' ? 'easy' : 'hard', hint: m.hint === true });
        for (let i = 0; i < bots; i++) nt.addBot();
        nt.start(p.id);
        return;
      }
      case 'create': this.createTable(p, { priv: true }); return;
      case 'join': return this.join(p, String(m.code || '').toUpperCase());
      case 'leave': return this.leave(p);
      case 'addBot': if (t && t.host === p.id) t.addBot(); return;
      case 'removeBot': if (t && t.host === p.id) t.removeBot(m.i | 0); return;
      case 'diff': if (t && t.host === p.id && t.status === 'waiting') { t.diff = m.diff === 'easy' ? 'easy' : 'hard'; t.touch(); } return;
      case 'hint': if (t && t.host === p.id && t.status === 'waiting') { t.hint = m.on === true; t.touch(); } return;
      case 'start': { if (!t) return; const e = t.start(p.id); if (e) err(e); else t.sys('牌局開始！'); return; }
      case 'commit': { if (!t) return; const e = t.commit(p.id, m.seq, m.board); if (e) { err(e); this.send(p.id, { t: 'table', view: t.view(p.id) }); } return; }
      case 'draw': { if (!t) return; const e = t.draw(p.id, m.seq); if (e) err(e); return; }
      case 'preview': if (t) t.preview(p.id, m.seq, m.board); return;
      case 'rematch': { if (!t) return; const e = t.rematch(p.id); if (e) err(e); return; }
    }
  }

  /* ---------- tables ---------- */
  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.tables.has(c)) return c;
    }
  }
  createTable(p, opts) {
    this.leave(p, true);
    this.unqueue(p, true);
    const t = new Table(this.hub, this.newCode(), { ...opts, host: p.id });
    this.tables.set(t.code, t);
    this.seat(p, t);
    return t;
  }
  seat(p, t) {
    p.table = t.code;
    t.addHuman(p.id);
    this.send(p.id, { t: 'chatHistory', ch: 'table', list: t.chat });
    t.sys(`${p.name} 加入了牌桌`);
  }
  join(p, code) {
    const t = this.tables.get(code);
    if (!t) return this.send(p.id, { t: 'error', text: `找不到房間 ${code}` });
    if (p.table === code && t.has(p.id)) { t.broadcast(); return; }
    if (t.status !== 'waiting') return this.send(p.id, { t: 'error', text: '這桌已經開始了' });
    if (!t.seats.some(s => !s)) return this.send(p.id, { t: 'error', text: '這桌已經坐滿了' });
    this.leave(p, true);
    this.unqueue(p, true);
    this.seat(p, t);
  }
  leave(p, silent) {
    const t = p.table && this.tables.get(p.table);
    p.table = null;
    if (t) {
      t.removeHuman(p.id);
      if (!t.members().length) this.dropTable(t);
      else t.sys(`${p.name} 離開了牌桌`);
    }
    if (!silent) this.send(p.id, { t: 'left' });
  }
  dropTable(t) {
    t.close();
    this.tables.delete(t.code);
  }

  /* ---------- matchmaking ---------- */
  enqueue(p) {
    if (this.queue.some(q => q.pid === p.id)) return;
    this.leave(p, true);
    this.queue.push({ pid: p.id, since: this.now() });
    this.queueUpdate();
    this.tick();
  }
  unqueue(p, silent) {
    const n = this.queue.length;
    this.queue = this.queue.filter(q => q.pid !== p.id);
    if (!silent) this.send(p.id, { t: 'queue', off: true });
    if (n !== this.queue.length) this.queueUpdate();
  }
  queueUpdate() {
    for (const q of this.queue) this.send(q.pid, { t: 'queue', n: this.queue.length, waited: this.now() - q.since, startsIn: this.queue.length >= 2 ? Math.max(0, MATCH_WAIT_MS - (this.now() - this.queue[0].since)) : null });
    this.stats();
  }
  /** Forms a table when 4 are queued, or when 2–3 have waited long enough. */
  tick() {
    this.queue = this.queue.filter(q => this.players.get(q.pid)?.conn);
    if (this.queue.length >= 4 || (this.queue.length >= 2 && this.now() - this.queue[0].since >= MATCH_WAIT_MS)) {
      const group = this.queue.splice(0, 4);
      const host = this.players.get(group[0].pid);
      const t = new Table(this.hub, this.newCode(), { priv: false, host: host.id, diff: 'hard' });
      this.tables.set(t.code, t);
      for (const q of group) {
        const p = this.players.get(q.pid);
        this.send(p.id, { t: 'queue', off: true, matched: true });
        this.seat(p, t);
      }
      t.start();
      t.sys('配對成功，牌局開始！');
      this.queueUpdate();
      return t;
    }
    if (this.queue.length) this.queueUpdate();
    return null;
  }

  /* ---------- chat ---------- */
  chatMsg(p, ch, raw) {
    const text = cleanText(raw);
    if (!text) return;
    const now = this.now();
    p.chatTimes = p.chatTimes.filter(x => now - x < CHAT_WINDOW);
    if (p.chatTimes.length >= CHAT_BURST) return this.send(p.id, { t: 'error', text: '訊息太快了，稍等一下' });
    p.chatTimes.push(now);
    const msg = { id: crypto.randomUUID(), from: p.id, name: p.name, text, ts: now };
    if (ch === 'table') {
      const t = p.table && this.tables.get(p.table);
      if (t) t.addChat({ ...msg, seat: t.seatOf(p.id) });
      return;
    }
    this.chat.push(msg);
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    for (const q of this.players.values()) if (q.conn) q.conn.send({ t: 'chat', ch: 'lobby', msg });
  }

  /* ---------- housekeeping ---------- */
  sweep() {
    const now = this.now();
    for (const t of this.tables.values()) {
      const online = t.members().some(pid => this.hub.isOnline(pid));
      if (online) t.idleSince = 0;
      else if (!t.idleSince) t.idleSince = now;
      else if (now - t.idleSince > IDLE_TABLE_MS) this.dropTable(t);
    }
    for (const p of this.players.values()) {
      if (!p.conn && now - p.seen > 6 * 3600_000 && !p.table) { this.players.delete(p.id); this.byToken.delete(p.token); }
    }
  }
}
