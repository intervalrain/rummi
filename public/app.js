import * as E from './engine.js';
import { sfx } from './sound.js';

const { T, isJ, analyze, looseOrder, setValue, handValue } = E;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const JOKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="2.3"/><circle cx="8.7" cy="10" r="1.6" fill="currentColor"/><circle cx="15.3" cy="10" r="1.6" fill="currentColor"/><path d="M7.4 14.1q4.6 4.8 9.2 0" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>';
const COLOR_NAMES = ['黑', '紅', '藍', '橙'];
const QUICK_PHRASES = ['安安', '好牌！', '等我一下', '哈哈哈', '手氣不錯', '再一局？', 'GG'];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/* ================= connection ================= */
let ws = null, retry = 0;
const me = { id: null, token: store.get('rummi.token') || '', name: store.get('rummi.name') || '' };
let stats = { online: 0, queue: 0 }, queueInfo = null, V = null, screen = 'home';
let pendingRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4) || null;
const chats = { lobby: [], table: [] };
let unread = 0;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; $('#conn').hidden = true; raw({ t: 'hello', token: me.token, name: me.name }); };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  ws.onclose = ev => {
    if (ev.code === 4000) { $('#conn').textContent = '你在另一個分頁開啟了遊戲'; $('#conn').hidden = false; return; }
    $('#conn').hidden = false;
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}
const raw = o => { if (ws?.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };
const send = o => { if (!raw(o)) toast('連線中，請稍候再試', 'bad'); };

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      me.id = m.id; me.token = m.token; me.name = m.name;
      store.set('rummi.token', m.token); store.set('rummi.name', m.name);
      if (document.activeElement !== $('#nameIn')) $('#nameIn').value = m.name;
      if (pendingRoom) { send({ t: 'join', code: pendingRoom }); pendingRoom = null; history.replaceState(null, '', location.pathname); }
      return;
    case 'stats': stats = m; renderStats(); return;
    case 'queue':
      if (m.off) { queueInfo = null; if (screen === 'queue' && !m.matched) show('home'); return; }
      queueInfo = { ...m, at: Date.now() }; show('queue'); renderQueue(); return;
    case 'table': onTable(m.view); return;
    case 'left': V = null; chats.table = []; closeModal(); closeChat(); show('home'); return;
    case 'chat': onChat(m.ch, m.msg); return;
    case 'chatHistory': chats[m.ch] = m.list.slice(); renderChats(); return;
    case 'preview':
      if (V && m.seq === V.seq && !myTurn() && Array.isArray(m.board)) { PV = m.board; renderGame(); }
      return;
    case 'error': busy = false; toast(m.text, 'bad'); if (V && screen === 'game') renderRack(); return;
  }
}

/* ================= screens ================= */
function show(name) {
  screen = name;
  for (const s of ['home', 'queue', 'room', 'game']) $('#' + s).hidden = s !== name;
  if (name === 'home') renderStats();
  renderChats();
}

function markHTML(word = 'RUMMI') {
  const cols = [1, 2, 3, 0, 1];
  return [...word].map((l, i) => `<div class="tile c${cols[i % 5]}"><span>${l}</span></div>`).join('');
}
function rulesHTML() {
  return `<ul class="rules">
    <li><b>牌組</b>：同色連號 3 張以上（順子），或同數字不同色 3–4 張（群組）。鬼牌可代替任何牌。</li>
    <li><b>破冰</b>：第一次出牌只能用手牌，總點數至少 30。</li>
    <li><b>重組</b>：破冰後可以拆解、重組桌上的牌，回合結束時每一組都成立即可。</li>
    <li>出不了牌就抽一張，先出完手牌的人獲勝。每回合限時 90 秒。</li>
    <li>點牌選取，再點目標牌組裡的任一張加入，或點「＋ 新牌組」。也可以直接拖曳。</li>
    <li><b>雙擊手牌</b>會自動接到能接的牌組；選牌後能接上的牌組會亮<b class="okc">綠框</b>。</li>
    <li><b>智慧出牌</b>會算出最多能出的牌（包含重組桌面）並自動擺好，你確認後按「完成」。</li>
  </ul>`;
}
function renderStats() {
  $('#onlineTxt').textContent = `線上 ${stats.online} 人${stats.queue ? ` · ${stats.queue} 人配對中` : ''}`;
  $('#lobbyCount').textContent = `${stats.online} 人在線`;
}
function renderQueue() {
  if (!queueInfo) return;
  const waited = Math.floor((queueInfo.waited + Date.now() - queueInfo.at) / 1000);
  let s = `配對中 ${queueInfo.n} 人 · 已等 ${waited} 秒`;
  if (queueInfo.startsIn != null) {
    const left = Math.max(0, Math.ceil((queueInfo.startsIn - (Date.now() - queueInfo.at)) / 1000));
    s += ` · ${left} 秒後開局`;
  }
  $('#queueTxt').textContent = s;
}

/* ---------- home controls ---------- */
const soloOpt = { bots: 3, diff: 'hard' };
function segPick(el, key) {
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    soloOpt[key] = key === 'bots' ? +b.dataset.v : b.dataset.v;
    el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  });
}
segPick($('#soloBots'), 'bots');
segPick($('#soloDiff'), 'diff');
$('#nameIn').addEventListener('change', e => { const n = e.target.value.trim(); if (n && n !== me.name) send({ t: 'name', name: n }); });
$('#nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#bQuick').onclick = () => send({ t: 'quick' });
$('#bCreate').onclick = () => send({ t: 'create' });
$('#bSolo').onclick = () => send({ t: 'solo', bots: soloOpt.bots, diff: soloOpt.diff });
$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const c = $('#codeIn').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(c)) return toast('房號是 4 碼英文或數字', 'bad');
  send({ t: 'join', code: c });
});
$('#bUnqueue').onclick = () => send({ t: 'unqueue' });
$('#bQueueSolo').onclick = () => { send({ t: 'unqueue' }); send({ t: 'solo', bots: 3, diff: 'hard' }); };

/* ---------- room (waiting) ---------- */
function renderRoom() {
  $('#roomCode').textContent = V.code;
  const host = V.isHost, filled = V.seats.filter(Boolean).length;
  $('#seats').innerHTML = V.seats.map((s, i) => {
    if (!s) return `<div class="seat empty"><span class="av">＋</span><span class="nm">空位</span>${host ? `<button class="btn" data-act="addBot" type="button">加電腦</button>` : ''}</div>`;
    const tags = [i === V.you ? '你' : '', s.isHost ? '房主' : '', s.bot ? '電腦' : '', !s.bot && !s.online ? '離線' : ''].filter(Boolean).join(' · ');
    return `<div class="seat"><span class="av ${s.bot ? 'bot' : 's' + i}">${esc([...s.name][0] || '?')}</span>
      <span class="nm">${esc(s.name)}<small>${tags}</small></span>
      ${host && s.bot ? `<button class="btn" data-act="removeBot" data-i="${i}" type="button">移除</button>` : ''}</div>`;
  }).join('');
  $('#roomCtl').innerHTML = host
    ? `<div class="ctl"><div class="seg" id="roomDiff" role="group" aria-label="電腦強度">
        <button type="button" data-v="easy" aria-pressed="${V.diff === 'easy'}">電腦：一般</button>
        <button type="button" data-v="hard" aria-pressed="${V.diff === 'hard'}">電腦：高手</button></div>
        <div class="row2"><button class="btn danger" data-act="leave" type="button">離開</button>
        <button class="btn go" data-act="start" type="button" ${filled < 2 ? 'disabled' : ''}>開始遊戲（${filled}/4）</button></div></div>`
    : `<div class="ctl"><p class="wait">等房主開始遊戲…（${filled}/4）</p><div class="row2"><button class="btn danger" data-act="leave" type="button">離開</button></div></div>`;
}
$('#room').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'addBot') send({ t: 'addBot' });
  else if (act === 'removeBot') send({ t: 'removeBot', i: +b.dataset.i });
  else if (act === 'leave') send({ t: 'leave' });
  else if (act === 'start') send({ t: 'start' });
  else if (b.closest('#roomDiff')) send({ t: 'diff', diff: b.dataset.v });
});
$('#bInvite').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${V.code}`;
  if (navigator.share) { try { await navigator.share({ title: 'Rummi 數字牌', text: `來玩數字牌！房號 ${V.code}`, url }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(url); toast('邀請連結已複製', 'good'); }
  catch { toast(`把這個連結傳給朋友：${url}`); }
};

/* ================= chat ================= */
function chatBoxInit(box) {
  box.innerHTML = `<div class="msgs"></div>
    <div class="quick">${QUICK_PHRASES.map(p => `<button type="button">${esc(p)}</button>`).join('')}</div>
    <form class="chatform"><input class="field" maxlength="200" placeholder="說點什麼…" enterkeyhint="send" aria-label="訊息"><button class="btn" type="submit">送出</button></form>`;
  const ch = box.dataset.ch;
  box.querySelector('.quick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) send({ t: 'chat', ch, text: b.textContent }); });
  box.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const inp = box.querySelector('input'), text = inp.value.trim();
    if (!text) return;
    send({ t: 'chat', ch, text });
    inp.value = '';
  });
}
$$('.chatbox').forEach(chatBoxInit);
function msgHTML(m) {
  if (m.sys) return `<div class="msg sys">${esc(m.text)}</div>`;
  return `<div class="msg ${m.from === me.id ? 'me' : ''}"><b>${esc(m.name)}</b>${esc(m.text)}</div>`;
}
function renderChats() {
  for (const box of $$('.chatbox')) {
    if (box.offsetParent === null) continue;
    const list = chats[box.dataset.ch], el = box.querySelector('.msgs');
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = list.map(msgHTML).join('');
    if (stick || !el.dataset.init) { el.scrollTop = el.scrollHeight; el.dataset.init = 1; }
  }
}
function onChat(ch, msg) {
  chats[ch].push(msg);
  if (chats[ch].length > 80) chats[ch].shift();
  renderChats();
  if (!msg.sys && msg.from !== me.id && (ch === 'table' || screen === 'home')) sfx.pop();
  if (ch === 'table' && screen === 'game' && $('#chatSheet').hidden && !msg.sys && msg.from !== me.id) {
    unread++; updateBadge();
    toast(`${msg.name}：${msg.text}`, 'chat');
  }
}
function updateBadge() { const b = $('#chatBadge'); b.hidden = !unread; b.textContent = unread > 9 ? '9+' : unread; }
function openChat() { $('#chatSheet').hidden = false; unread = 0; updateBadge(); renderChats(); }
function closeChat() { $('#chatSheet').hidden = true; }
$('#bChat').onclick = openChat;
$('#bChatClose').onclick = closeChat;
$('#chatSheet').addEventListener('click', e => { if (e.target.id === 'chatSheet') closeChat(); });

/* ================= game state ================= */
// L = the local, tentative table and hand for this turn. TS = the same at turn start.
let L = { board: [], hand: [] }, TS = { board: [], hand: [] }, undoStack = [], PV = null;
let sid = 1, lastMsgN = 0, resultSeq = -1, lastDrawn = null, busy = false;
let sortMode = store.get('rummi.sort') || 'smart';
const sel = new Set(), recent = new Set();
const cloneBoard = b => b.map(s => ({ id: s.id, tiles: s.tiles.slice() }));
const myTurn = () => !!V && V.status === 'playing' && V.you >= 0 && V.turn === V.you;
const melded = () => V.you >= 0 && V.seats[V.you].melded;
const getSet = id => L.board.find(s => s.id === id);
const playedNow = () => (myTurn() ? TS.hand.filter(id => !L.hand.includes(id)) : []);
const pname = i => (i === V.you ? '你' : V.seats[i]?.name || '玩家');

function fmtMsg(m) {
  const n = pname(m.seat);
  switch (m.kind) {
    case 'play': return `${n} 出了 ${m.cnt} 張${m.initial ? '（破冰）' : ''}`;
    case 'draw': return `${n} 抽了一張`;
    case 'pass': return `${n} 過（牌堆已空）`;
    case 'timeout': return `${n} 超時，自動抽一張`;
    case 'autoplay': return `${n} 離線中，系統代打出了 ${m.cnt} 張`;
    case 'autodraw': return `${n} 離線中，系統代抽一張`;
  }
  return '';
}

function onTable(v) {
  const prev = V;
  V = v; V.recvAt = Date.now(); busy = false;
  if (v.status === 'waiting') { closeModal(); show('room'); renderRoom(); return; }
  const fresh = !prev || prev.code !== v.code || prev.status === 'waiting';
  if (fresh) {
    recent.clear(); lastMsgN = v.msg?.n ?? 0; resultSeq = -1; lastDrawn = null; unread = 0; updateBadge();
    if (v.status === 'playing') { sfx.deal(); if (v.turn === v.you) setTimeout(sfx.turn, 1100); }
  }
  if (screen !== 'game') show('game');
  if (fresh || prev.seq !== v.seq) {
    if (!fresh && v.msg && v.msg.n !== lastMsgN) {
      lastMsgN = v.msg.n;
      const k = v.msg.kind;
      if (v.msg.seat !== v.you) {
        toast(fmtMsg(v.msg));
        if (k === 'play' || k === 'autoplay') sfx.opponent(v.msg.cnt);
        else if (k !== 'pass') sfx.draw(0.5);
        const before = new Set(prev.board.flat());
        v.board.flat().forEach(id => { if (!before.has(id)) recent.add(id); });
      } else {
        recent.clear();
        const before = new Set(prev.hand);
        lastDrawn = v.hand.find(id => !before.has(id)) ?? null;
        if (k === 'play' || k === 'autoplay') sfx.play(v.msg.cnt);
        else if (k !== 'pass') sfx.draw();
        if (k === 'timeout') toast('時間到，系統幫你抽了一張', 'bad');
      }
    }
    L = { board: v.board.map(t => ({ id: sid++, tiles: t.slice() })), hand: v.hand.slice() };
    TS = { board: cloneBoard(L.board), hand: L.hand.slice() };
    undoStack = []; sel.clear(); PV = null;
    if (myTurn() && !fresh) { navigator.vibrate?.(25); setTimeout(sfx.turn, 450); }
  }
  renderGame();
  if (v.status === 'over' && resultSeq !== v.seq) { resultSeq = v.seq; setTimeout(showResult, REDUCE ? 0 : 700); }
}

/* ---------- player actions ---------- */
function canPick(id) {
  if (!myTurn()) return false;
  if (L.hand.includes(id)) return true;
  return melded() || TS.hand.includes(id);
}
const allowedTarget = s => melded() || s.tiles.every(id => TS.hand.includes(id));
function pushUndo() { undoStack.push({ hand: L.hand.slice(), board: cloneBoard(L.board) }); }
function changed() { sel.clear(); renderGame(); sendPreview(); }

function moveTiles(ids, target) {
  ids = ids.filter(canPick);
  if (target.type === 'hand') ids = ids.filter(id => TS.hand.includes(id) && !L.hand.includes(id));
  if (!ids.length) { if (target.type !== 'hand') toast('破冰前不能移動桌上的牌', 'bad'); sel.clear(); renderGame(); return false; }
  if (target.type === 'set') {
    const s = getSet(target.id);
    if (!s) return false;
    if (!allowedTarget(s)) { toast('破冰前只能用手牌組成新牌組', 'bad'); return false; }
    if (ids.every(id => s.tiles.includes(id))) { sel.clear(); renderGame(); return false; }
  }
  pushUndo();
  const mv = new Set(ids);
  L.hand = L.hand.filter(id => !mv.has(id));
  L.board.forEach(s => { s.tiles = s.tiles.filter(id => !mv.has(id)); });
  if (target.type === 'hand') L.hand.push(...ids);
  else if (target.type === 'new') L.board.push({ id: sid++, tiles: ids.slice() });
  else getSet(target.id).tiles.push(...ids);
  L.board = L.board.filter(s => s.tiles.length);
  sfx.place();
  changed();
  return true;
}
function quickPlace(id) {
  const cands = L.board.filter(s => !s.tiles.includes(id) && allowedTarget(s) && analyze(s.tiles.concat(id)));
  if (!cands.length) { toast('這張牌目前沒有能直接接上的牌組'); renderGame(); return; }
  cands.sort((a, b) => a.tiles.length - b.tiles.length);
  moveTiles([id], { type: 'set', id: cands[0].id });
}
const iceValue = () => L.board.filter(s => s.tiles.every(id => TS.hand.includes(id))).reduce((v, s) => v + setValue(s.tiles), 0);

function commit() {
  if (!myTurn() || busy) return;
  const played = playedNow();
  if (!played.length) { busy = true; send({ t: 'draw', seq: V.seq }); renderRack(); return; }
  const r = E.validateTurn(TS.board.map(s => s.tiles), L.board.map(s => s.tiles), TS.hand, melded());
  if (r.err) { toast(r.err.includes('不成立') ? '紅框或黃框的牌組還不成立，請調整或重置' : r.err, 'bad'); return; }
  busy = true;
  send({ t: 'commit', seq: V.seq, board: L.board.map(s => s.tiles) });
  renderRack();
}
function undo() { const u = undoStack.pop(); if (!u) return; L.hand = u.hand; L.board = u.board; sfx.undo(); changed(); }
function resetTurn() { L = { board: cloneBoard(TS.board), hand: TS.hand.slice() }; undoStack = []; }
function hint() {
  if (!myTurn()) return;
  toast('計算最佳出法中…');
  setTimeout(() => {
    resetTurn();
    const plan = E.bestPlan(TS.hand, melded(), cloneBoard(TS.board), true, 900);
    if (!plan) { changed(); toast('沒有能出的牌，建議抽牌'); return; }
    if (plan.initial && plan.value < 30) { changed(); toast(`手牌最多只能湊 ${plan.value} 分，破冰要 30 分，建議抽牌`); return; }
    pushUndo();
    const played = new Set(plan.played);
    L.board = plan.board.map(s => ({ id: s.id ?? sid++, tiles: s.tiles }));
    L.hand = TS.hand.filter(id => !played.has(id));
    changed();
    flash(plan.played);
    sfx.magic();
    toast(`已擺好 ${plan.played.length} 張${plan.initial ? `（破冰 ${plan.value} 分）` : ''}，確認後按「完成」`, 'good');
  }, 40);
}
function flash(ids) {
  if (REDUCE) return;
  ids.forEach(id => document.querySelector(`#game .tile[data-id="${id}"]`)?.animate([{ boxShadow: '0 0 0 3px #86D9E6, 0 0 18px rgba(134,217,230,.8)' }, {}], { duration: 1400, easing: 'ease-out' }));
}
let pvTimer = null;
function sendPreview() {
  if (!myTurn()) return;
  clearTimeout(pvTimer);
  pvTimer = setTimeout(() => raw({ t: 'preview', seq: V.seq, board: L.board.map(s => s.tiles) }), 120);
}

/* ================= game render ================= */
function tileHTML(id, extra = '') {
  const t = T[id];
  let cls = 'tile ' + (t.c < 0 ? 'jk j' + t.j : 'c' + t.c) + extra;
  if (sel.has(id)) cls += ' sel';
  return `<div class="${cls}" data-id="${id}" aria-label="${t.c < 0 ? '鬼牌' : COLOR_NAMES[t.c] + t.n}">${t.c < 0 ? JOKER : `<span>${t.n}</span>`}</div>`;
}
function renderGame() {
  if (!V || V.status === 'waiting') return;
  const prev = new Map();
  if (!REDUCE) $$('#game .tile[data-id]').forEach(el => prev.set(el.dataset.id, el.getBoundingClientRect()));
  renderTop(); renderBoard(); renderHand(); renderRack();
  if (!REDUCE) flip(prev);
}
function flip(prev) {
  const first = prev.size === 0;
  $$('#game .tile[data-id]').forEach(el => {
    const p = prev.get(el.dataset.id);
    if (!p) { if (!first || el.closest('#hand')) el.classList.add('pop'); return; }
    const r = el.getBoundingClientRect(), dx = p.left - r.left, dy = p.top - r.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const base = getComputedStyle(el).transform, b = base === 'none' ? '' : base;
    el.animate({ transform: [`translate(${dx}px,${dy}px) ${b}`, b || 'none'] }, { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}
function turnLeft() { return V && V.turnLeft ? Math.max(0, V.turnLeft - (Date.now() - V.recvAt)) : 0; }
function renderTop() {
  $('#players').innerHTML = V.seats.map((p, i) => {
    const active = i === V.turn && V.status === 'playing';
    const state = p.left ? '已離開' : `${p.count} 張${p.melded ? '' : ' · <i>未破冰</i>'}`;
    return `<div class="pl ${active ? 'active' : ''} ${p.left ? 'gone' : ''}">
      <div class="av ${p.bot ? 'bot' : 's' + i}">${esc(i === V.you ? '你' : [...p.name][0] || '?')}</div>
      ${!p.online && !p.left ? '<span class="off" title="離線"></span>' : ''}
      <div class="pm"><b>${esc(pname(i))}</b><span>${state}${active && V.turnLeft ? ` <em data-timer></em>` : ''}</span></div></div>`;
  }).join('');
  tickTimers();
}
function displayBoard() {
  if (!myTurn() && PV && V.status === 'playing') return PV.map((tiles, i) => ({ id: 'p' + i, tiles }));
  return L.board;
}
function renderBoard() {
  const mt = myTurn(), selIds = [...sel], mine = mt ? new Set(TS.hand) : new Set();
  const board = displayBoard();
  const html = board.map(s => {
    const a = analyze(s.tiles), order = a ? a.order : looseOrder(s.tiles);
    let cls = 'set';
    if (!a) cls += s.tiles.length < 3 ? ' partial' : ' invalid';
    if (selIds.length && mt && !selIds.every(id => s.tiles.includes(id)) && allowedTarget(s) && analyze([...new Set(s.tiles.concat(selIds))])) cls += ' fits';
    return `<div class="${cls}" data-drop="s:${s.id}">${order.map(id => tileHTML(id, (mine.has(id) ? ' mine' : '') + (recent.has(id) ? ' recent' : ''))).join('')}</div>`;
  }).join('');
  const watching = !mt && PV && V.status === 'playing' ? `<div class="watching">${esc(pname(V.turn))} 正在排牌…</div>` : '';
  const empty = board.length ? '' : `<div class="empty"><b>桌面還是空的</b>用手牌湊出 30 分以上的牌組來破冰</div>`;
  $('#sets').innerHTML = watching + empty + html + (mt ? '<div class="newset" data-drop="new">＋ 新牌組</div>' : '');
  $('#board').classList.toggle('selecting', sel.size > 0);
}
let smartCache = { key: '', groups: null };
function handGroups() {
  const h = L.hand.slice();
  const byC = (a, b) => (isJ(a) - isJ(b)) || T[a].c - T[b].c || T[a].n - T[b].n || a - b;
  const byN = (a, b) => (isJ(a) - isJ(b)) || T[a].n - T[b].n || T[a].c - T[b].c || a - b;
  if (sortMode === 'num') return [{ tiles: h.sort(byN) }];
  if (sortMode === 'color') return [{ tiles: h.sort(byC) }];
  const key = h.slice().sort((a, b) => a - b).join(',');
  if (smartCache.key === key) return smartCache.groups;
  const ms = E.handMelds(h, 'count', 150);
  const used = new Set(ms.flat());
  const groups = ms.map(m => ({ tiles: analyze(m)?.order || m, meld: true })).sort((x, y) => byC(x.tiles[0], y.tiles[0]));
  const rest = h.filter(id => !used.has(id));
  if (rest.length) groups.push({ tiles: rest.sort(byC) });
  smartCache = { key, groups };
  return groups;
}
function renderHand() {
  const hand = $('#hand');
  if (V.you < 0) { hand.innerHTML = '<p class="spectate">你已離開這一局，正在觀戰</p>'; return; }
  const groups = handGroups(), n = L.hand.length;
  const W = hand.clientWidth - 16, gapCount = groups.length - 1;
  let tw = 48;
  for (const rows of [2, 3, 4]) {
    const per = Math.ceil(n / rows) || 1;
    tw = (W - (per - 1) * 4 - (gapCount * 10) / rows) / per;
    if (tw >= 36 || rows === 4) break;
  }
  tw = Math.max(26, Math.min(48, Math.floor(tw)));
  document.documentElement.style.setProperty('--hw', tw + 'px');
  hand.innerHTML = groups.map(g => g.tiles.map((id, i) => tileHTML(id, (i === 0 ? ' gs' : '') + (g.meld ? ' mg' : '') + (lastDrawn === id ? ' drawn' : ''))).join('')).join('');
}
function renderRack() {
  const played = playedNow(), mt = myTurn();
  const who = V.status === 'over' ? '牌局結束' : mt ? '你的回合' : V.you < 0 ? '觀戰中' : `${pname(V.turn)} 思考中…`;
  let chips = `<span class="chip">牌堆 ${V.pool}</span>`;
  if (mt && !melded()) { const v = iceValue(); chips = `<span class="chip ${v >= 30 ? 'ok' : 'warn'}">破冰 ${v}/30</span>` + chips; }
  else if (mt && played.length) chips = `<span class="chip ok">本回合 +${played.length}</span>` + chips;
  if (mt && V.turnLeft) chips = `<span class="chip" data-timer></span>` + chips;
  $('#status').innerHTML = `<span class="who">${esc(who)}</span>${chips}`;
  $('#sortLbl').textContent = { smart: '智慧', color: '顏色', num: '數字' }[sortMode];
  $('#bHint').disabled = !mt;
  $('#bUndo').disabled = !mt || !undoStack.length;
  $('#bReset').disabled = !mt || (!played.length && !undoStack.length);
  const m = $('#bMain');
  m.disabled = !mt || busy;
  m.classList.toggle('go', mt && played.length > 0);
  m.textContent = !mt ? '等待中' : busy ? '送出中…' : played.length ? '完成' : V.pool ? '抽牌' : '過';
  tickTimers();
}
function tickTimers() {
  const left = turnLeft(), s = Math.ceil(left / 1000);
  for (const el of $$('[data-timer]')) {
    el.textContent = el.tagName === 'EM' ? `${s}s` : `剩 ${s} 秒`;
    el.classList.toggle('low', left < 15000);
  }
}
let lastTickS = 0;
setInterval(() => {
  if (screen === 'queue') renderQueue();
  if (screen !== 'game') return;
  tickTimers();
  const s = Math.ceil(turnLeft() / 1000);
  if (myTurn() && s > 0 && s <= 10 && s !== lastTickS) sfx.tick(s <= 3);
  lastTickS = s;
}, 250);

/* ================= overlays ================= */
let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  if (kind === 'bad') sfx.nope();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'chat' ? 3200 : 2600);
}
const modal = $('#modal'), sheet = $('#sheet');
function closeModal() { modal.hidden = true; }
function showMenu() {
  sheet.innerHTML = `<div class="mark">${markHTML()}</div>
    <p class="sub">房號 ${esc(V.code)}${V.priv ? '' : '（配對桌）'}</p>
    <h2 class="sec">規則與操作</h2>${rulesHTML()}
    <div class="row2"><button class="btn danger" id="mLeave" type="button">離開牌局</button><button class="btn primary" id="mClose" type="button">回到牌桌</button></div>`;
  modal.hidden = false;
}
function showResult() {
  if (!V?.over) return;
  const o = V.over, w = o.winner;
  if (w === V.you) sfx.win(); else sfx.lose();
  const rows = V.seats.map((p, i) => ({ p, i, s: o.scores[i] })).sort((a, b) => b.s.score - a.s.score);
  sheet.innerHTML = `<div class="mark">${markHTML()}</div>
    <div class="big">${w === V.you ? '你贏了！' : `${esc(pname(w))} 獲勝`}</div><p class="sub">${esc(o.reason)}</p>
    <div class="res">${rows.map(r => `<div class="${r.i === w ? 'win' : ''}"><span class="av ${r.p.bot ? 'bot' : 's' + r.i}">${esc(r.i === V.you ? '你' : [...r.p.name][0] || '?')}</span>
      <span class="n">${esc(pname(r.i))} · 剩 ${r.s.left} 張</span><span class="s ${r.s.score >= 0 ? 'pos' : 'neg'}">${r.s.score >= 0 ? '+' + r.s.score : '−' + -r.s.score}</span></div>`).join('')}</div>
    <div class="row2"><button class="btn" id="mLobby" type="button">回大廳</button><button class="btn primary" id="mRematch" type="button">再來一局</button></div>`;
  modal.hidden = false;
}
modal.addEventListener('click', e => {
  if (e.target === modal) return closeModal();
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'mClose') closeModal();
  if (b.id === 'mLeave') {
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = '確定離開？電腦會代打'; return; }
    send({ t: 'leave' }); closeModal();
  }
  if (b.id === 'mLobby') { send({ t: 'leave' }); closeModal(); }
  if (b.id === 'mRematch') { send({ t: 'rematch' }); closeModal(); }
});

/* ================= input ================= */
let drag = null, lastTap = { id: -1, t: 0 }, ghost = null, overEl = null;
document.addEventListener('pointerdown', e => {
  if (screen !== 'game' || !modal.hidden) return;
  const el = e.target.closest('#game .tile[data-id]');
  if (!el || !myTurn()) return;
  drag = { id: +el.dataset.id, x0: e.clientX, y0: e.clientY, pid: e.pointerId, started: false };
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
    if (!canPick(drag.id)) { drag = null; return; }
    startDrag();
  }
  e.preventDefault();
  moveDrag(e.clientX, e.clientY);
}, { passive: false });
document.addEventListener('pointerup', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  if (d.started) endDrag(d.ids); else tapTile(d.id);
});
document.addEventListener('pointercancel', () => { if (drag?.started) cleanupDrag(); drag = null; });

function startDrag() {
  drag.started = true;
  sfx.pick();
  drag.ids = sel.has(drag.id) ? [...sel].filter(canPick) : [drag.id];
  if (!drag.ids.includes(drag.id)) drag.ids = [drag.id];
  drag.ids.forEach(id => document.querySelector(`#game .tile[data-id="${id}"]`)?.classList.add('dragging'));
  ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.innerHTML = drag.ids.map(id => tileHTML(id).replace(' sel', '')).join('');
  document.body.appendChild(ghost);
  const ids = drag.ids;
  $$('#sets .set').forEach(s => {
    const set = getSet(+s.dataset.drop.slice(2));
    s.classList.toggle('fits', !!set && !ids.every(id => set.tiles.includes(id)) && allowedTarget(set) && !!analyze([...new Set(set.tiles.concat(ids))]));
  });
  $('#board').classList.add('selecting');
}
function moveDrag(x, y) {
  const gw = ghost.offsetWidth, gh = ghost.offsetHeight;
  ghost.style.transform = `translate(${x - Math.min(gw / 2, 30)}px,${y - gh * 0.8}px)`;
  const z = document.elementFromPoint(x, y)?.closest('[data-drop]') || null;
  if (z !== overEl) { overEl?.classList.remove('over'); overEl = z; if (z && z.id !== 'board') z.classList.add('over'); }
  const bd = $('#board'), b = bd.getBoundingClientRect();
  if (x > b.left && x < b.right) {
    if (y < b.top + 36 && y > b.top - 20) bd.scrollTop -= 10;
    else if (y > b.bottom - 36 && y < b.bottom + 10) bd.scrollTop += 10;
  }
}
function cleanupDrag() { ghost?.remove(); ghost = null; overEl?.classList.remove('over'); overEl = null; renderGame(); }
function endDrag(ids) {
  const d = overEl?.dataset.drop;
  ghost?.remove(); ghost = null; overEl?.classList.remove('over'); overEl = null;
  if (!d) return renderGame();
  if (d === 'hand') { if (!moveTiles(ids, { type: 'hand' })) renderGame(); }
  else if (d === 'new') moveTiles(ids, { type: 'new' });
  else if (!moveTiles(ids, { type: 'set', id: +d.slice(2) })) renderGame();
}
const locate = id => L.board.find(s => s.tiles.includes(id)) || null;
function tapTile(id) {
  const now = Date.now();
  if (lastTap.id === id && now - lastTap.t < 330 && L.hand.includes(id)) {
    lastTap = { id: -1, t: 0 }; sel.delete(id); quickPlace(id); return;
  }
  lastTap = { id, t: now };
  const home = locate(id);
  if (sel.size && home && !sel.has(id) && ![...sel].some(s => locate(s) === home)) {
    moveTiles([...sel], { type: 'set', id: home.id }); return;
  }
  if (!canPick(id)) { toast('破冰前不能移動桌上的牌'); return; }
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  sfx.pick();
  renderGame();
}
document.addEventListener('click', e => {
  if (screen !== 'game' || !modal.hidden || !myTurn()) return;
  if (e.target.closest('.tile') || e.target.closest('button')) return;
  const z = e.target.closest('#game [data-drop]');
  if (!z || !sel.size) return;
  const d = z.dataset.drop;
  if (d === 'new' && z.classList.contains('newset')) moveTiles([...sel], { type: 'new' });
  else if (d === 'new') { sel.clear(); renderGame(); }
  else if (d === 'hand') {
    const back = [...sel].filter(id => !L.hand.includes(id));
    if (back.length) moveTiles(back, { type: 'hand' }); else { sel.clear(); renderGame(); }
  } else moveTiles([...sel], { type: 'set', id: +d.slice(2) });
});
$('#bSort').onclick = () => { sortMode = { smart: 'color', color: 'num', num: 'smart' }[sortMode]; store.set('rummi.sort', sortMode); renderGame(); };
$('#bHint').onclick = hint;
$('#bUndo').onclick = undo;
$('#bReset').onclick = () => { resetTurn(); sfx.undo(); changed(); };
$('#bMain').onclick = commit;
$('#bMenu').onclick = showMenu;
function renderSound() {
  const on = sfx.enabled;
  $('#bSound').innerHTML = on
    ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M3 8h3l4-3.5v11L6 12H3z"/><path d="M13.5 7.2a4 4 0 0 1 0 5.6M15.8 5a7 7 0 0 1 0 10"/></svg>'
    : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M3 8h3l4-3.5v11L6 12H3z"/><path d="M13.5 8l4 4M17.5 8l-4 4"/></svg>';
  $('#bSound').setAttribute('aria-label', on ? '關閉音效' : '開啟音效');
  $('#soundTxt').textContent = on ? '音效開' : '音效關';
}
$('#bSound').onclick = () => { sfx.toggle(); renderSound(); };
$('#bSoundHome').onclick = () => { sfx.toggle(); renderSound(); };
document.addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
// No zooming: iOS Safari ignores user-scalable=no, so block pinch gestures directly.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
renderSound();
let rz;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (screen === 'game') renderGame(); }, 120); });

/* ================= boot ================= */
$('#markHome').innerHTML = markHTML();
$('#rulesHome').innerHTML = rulesHTML();
$('#nameIn').value = me.name;
if (pendingRoom) $('#codeIn').value = pendingRoom;
show('home');
connect();
