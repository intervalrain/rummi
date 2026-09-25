// Rummi rules and solver. Shared by the browser client and the Node server.

export const T = [];
for (let d = 0; d < 2; d++) for (let c = 0; c < 4; c++) for (let n = 1; n <= 13; n++) T.push({ id: T.length, c, n });
T.push({ id: 104, c: -1, n: 0, j: 0 });
T.push({ id: 105, c: -1, n: 0, j: 1 });

export const BOTS = ['阿偉', '小美', '老K', '阿花', '大雄', '胖虎'];
export const TILE_COUNT = 106;
export const isJ = id => T[id].c < 0;
export const kOf = id => T[id].c * 13 + T[id].n - 1;
const Z = () => new Array(52).fill(0);
const now = () => (globalThis.performance ? performance.now() : Date.now());

/* ---------------- rules ---------------- */

/** Returns {type, order, value} for a valid set, otherwise null. */
export function analyze(ids) {
  if (ids.length < 3 || ids.length > 13) return null;
  const real = ids.filter(i => !isJ(i)), jk = ids.filter(isJ), J = jk.length;
  if (!real.length) return null;
  const n0 = T[real[0]].n, c0 = T[real[0]].c;
  const isGroup = ids.length <= 4 && real.every(i => T[i].n === n0) && new Set(real.map(i => T[i].c)).size === real.length;
  let run = null;
  if (real.every(i => T[i].c === c0)) {
    const s = real.slice().sort((a, b) => T[a].n - T[b].n);
    let ok = true;
    for (let i = 1; i < s.length; i++) if (T[s[i]].n === T[s[i - 1]].n) ok = false;
    if (ok) {
      const mn = T[s[0]].n, mx = T[s[s.length - 1]].n, gaps = mx - mn + 1 - s.length;
      if (gaps <= J) {
        let extra = J - gaps;
        const hi = Math.min(13, mx + extra);
        extra -= hi - mx;
        const lo = mn - extra;
        if (lo >= 1) {
          const order = [];
          let si = 0, ji = 0, val = 0;
          for (let v = lo; v <= hi; v++) {
            if (si < s.length && T[s[si]].n === v) order.push(s[si++]);
            else order.push(jk[ji++]);
            val += v;
          }
          run = { type: 'run', order, value: val };
        }
      }
    }
  }
  if (isGroup && !(run && real.length === 1)) {
    return { type: 'group', order: real.slice().sort((a, b) => T[a].c - T[b].c).concat(jk), value: n0 * ids.length };
  }
  return run;
}
export const looseOrder = ids => ids.slice().sort((a, b) => (isJ(a) - isJ(b)) || T[a].c - T[b].c || T[a].n - T[b].n);
export const setValue = ids => analyze(ids)?.value || 0;
export const handValue = ids => ids.reduce((a, id) => a + (isJ(id) ? 30 : T[id].n), 0);

/**
 * Checks a finished turn. Boards are arrays of tile-id arrays.
 * Returns {ok:true, added, initial, value} or {err}.
 */
export function validateTurn(oldBoard, newBoard, hand, melded) {
  if (!Array.isArray(newBoard) || newBoard.length > 60) return { err: '資料格式錯誤' };
  const seen = new Set();
  for (const s of newBoard) {
    if (!Array.isArray(s) || !s.length || s.length > 13) return { err: '資料格式錯誤' };
    for (const id of s) {
      if (!Number.isInteger(id) || id < 0 || id >= TILE_COUNT || seen.has(id)) return { err: '資料格式錯誤' };
      seen.add(id);
    }
  }
  const old = new Set(oldBoard.flat());
  for (const id of old) if (!seen.has(id)) return { err: '桌上的牌不能收回手上' };
  const inHand = new Set(hand);
  const added = [...seen].filter(id => !old.has(id));
  for (const id of added) if (!inHand.has(id)) return { err: '出了不在手上的牌' };
  if (!added.length) return { err: '這回合還沒有出牌' };
  if (newBoard.some(s => !analyze(s))) return { err: '有牌組不成立' };
  if (melded) return { ok: true, added, initial: false, value: 0 };
  const sig = s => s.slice().sort((a, b) => a - b).join(',');
  const left = new Map();
  for (const s of newBoard) left.set(sig(s), (left.get(sig(s)) || 0) + 1);
  for (const s of oldBoard) {
    const c = left.get(sig(s)) || 0;
    if (!c) return { err: '破冰前不能動到桌上的牌組' };
    left.set(sig(s), c - 1);
  }
  const addSet = new Set(added);
  const fresh = newBoard.filter(s => s.every(id => addSet.has(id)));
  if (fresh.flat().length !== added.length) return { err: '破冰前只能用手牌組成新牌組' };
  const value = fresh.reduce((v, s) => v + setValue(s), 0);
  if (value < 30) return { err: `破冰需要 30 分，目前 ${value} 分` };
  return { ok: true, added, initial: true, value };
}

/* ---------------- solver ----------------
   Exact search over tile counts. B = tiles that must be used (table),
   H = optional tiles (hand). The lowest remaining tile is always expanded
   first, so each meld is enumerated one canonical way; results are memoised. */
const ABORT = {};
export function solveCounts(Bin, Hin, jB, jH, obj, ms, early) {
  const B = Bin.slice(), H = Hin.slice();
  let JB = jB, JH = jH;
  const t0 = now(), memo = new Map();
  let nodes = 0;
  const W = (n, h) => (h ? (obj === 'value' ? n * 64 + 1 : 1000 + n) : 0);
  const nextK = k => { while (k < 52 && B[k] + H[k] === 0) k++; return k; };
  const sig = k => { let s = k + ':' + JB + JH + ':'; for (let i = k; i < 52; i++) s += B[i] * 3 + H[i]; return s; };
  const take = k => { if (B[k]) { B[k]--; return 0; } H[k]--; return 1; };
  const put = (k, h) => { if (h) H[k]++; else B[k]++; };
  const tJ = () => { if (JB) { JB--; return 0; } JH--; return 1; };
  const pJ = h => { if (h) JH++; else JB++; };

  function dfs(k0) {
    if ((++nodes & 2047) === 0 && now() - t0 > ms) throw ABORT;
    const k = nextK(k0);
    if (k === 52) return JB === 0 ? 0 : -1e9;
    const key = sig(k), hit = memo.get(key);
    if (hit) return hit.s;
    let best = -1e9, ch = null;
    const c = (k / 13) | 0, n = (k % 13) + 1;
    if (H[k]) { H[k]--; const s = dfs(k); H[k]++; if (s > best) { best = s; ch = { skip: 1 }; } }
    const others = [];
    for (let c2 = c + 1; c2 < 4; c2++) { const k2 = c2 * 13 + n - 1; if (B[k2] + H[k2]) others.push(k2); }
    const J = JB + JH;
    for (let mask = 0; mask < 1 << others.length; mask++) {
      const pick = others.filter((_, i) => (mask >> i) & 1);
      for (let jn = 0; jn <= Math.min(2, J); jn++) {
        const tot = 1 + pick.length + jn;
        if (tot < 3 || tot > 4) continue;
        let g = 0;
        const h0 = take(k); g += W(n, h0);
        const hk = pick.map(k2 => { const h = take(k2); g += W(n, h); return h; });
        const hj = [];
        for (let i = 0; i < jn; i++) { const h = tJ(); hj.push(h); g += W(n, h); }
        const s = dfs(k) + g;
        hj.forEach(pJ); pick.forEach((k2, i) => put(k2, hk[i])); put(k, h0);
        if (s > best) { best = s; ch = { items: [k, ...pick].map(x => ({ k: x })).concat(Array.from({ length: jn }, () => ({ j: n }))) }; }
        if (early && best >= 0) break;
      }
      if (early && best >= 0) break;
    }
    for (let L = 0; L <= Math.min(J, 2, n - 1) && !(early && best >= 0); L++) {
      let g = 0;
      const items = [], hj = [];
      for (let i = 0; i < L; i++) { const h = tJ(); hj.push(h); g += W(n - L + i, h); items.push({ j: n - L + i }); }
      const h0 = take(k); g += W(n, h0); items.push({ k });
      let len = L + 1, m = n;
      const st = [];
      for (;;) {
        if (len >= 3) { const s = dfs(k) + g; if (s > best) { best = s; ch = { items: items.slice() }; } if (early && best >= 0) break; }
        if (++m > 13) break;
        const k2 = c * 13 + m - 1;
        if (B[k2] + H[k2]) { const h = take(k2); st.push([1, k2, h]); g += W(m, h); items.push({ k: k2 }); }
        else if (JB + JH) { const h = tJ(); st.push([0, 0, h]); g += W(m, h); items.push({ j: m }); }
        else break;
        len++;
      }
      for (let i = st.length - 1; i >= 0; i--) { const [t, k2, h] = st[i]; if (t) put(k2, h); else pJ(h); }
      put(k, h0); hj.forEach(pJ);
    }
    memo.set(key, { s: best, ch });
    return best;
  }

  let total;
  try { total = dfs(0); } catch (e) { if (e === ABORT) return null; throw e; }
  if (total < 0) return null;
  const melds = [];
  let k = 0;
  for (;;) {
    k = nextK(k);
    if (k === 52) break;
    const e = memo.get(sig(k));
    if (!e || !e.ch) break;
    if (e.ch.skip) { H[k]--; continue; }
    const m = [];
    for (const it of e.ch.items) {
      if (it.k !== undefined) { take(it.k); m.push({ c: (it.k / 13) | 0, n: (it.k % 13) + 1 }); }
      else { tJ(); m.push({ j: 1, v: it.j }); }
    }
    melds.push(m);
  }
  return { melds, score: total };
}

export function counts(ids) {
  const a = Z(); let j = 0;
  for (const id of ids) { if (isJ(id)) j++; else a[kOf(id)]++; }
  return { a, j };
}
function pools(ids) {
  const p = {}, jp = [];
  for (const id of ids) { if (isJ(id)) jp.push(id); else (p[kOf(id)] ||= []).push(id); }
  return { p, jp };
}
export function mapMelds(melds, ids) {
  const { p, jp } = pools(ids);
  return melds.map(m => m.map(it => (it.j ? jp.shift() : p[it.c * 13 + it.n - 1].shift())));
}
const sigIds = ids => ids.map(i => (isJ(i) ? 'J' : kOf(i))).sort().join(',');
const sigMeld = m => m.map(it => (it.j ? 'J' : it.c * 13 + it.n - 1)).sort().join(',');

/** Turns solver melds back into tile ids, keeping untouched sets as they were. */
function materialize(melds, oldSets, hand) {
  const { p, jp } = pools(oldSets.flatMap(s => s.tiles).concat(hand));
  const drop = id => { const a = isJ(id) ? jp : p[kOf(id)]; a.splice(a.indexOf(id), 1); };
  const out = new Array(melds.length).fill(null);
  for (const s of oldSets) {
    const sg = sigIds(s.tiles), i = melds.findIndex((m, i) => !out[i] && sigMeld(m) === sg);
    if (i >= 0) { out[i] = { id: s.id, tiles: s.tiles.slice() }; s.tiles.forEach(drop); }
  }
  melds.forEach((m, i) => { if (!out[i]) out[i] = { id: null, tiles: m.map(it => (it.j ? jp.shift() : p[it.c * 13 + it.n - 1].shift())) }; });
  const res = [];
  for (const s of oldSets) { const o = out.find(x => x && x.id === s.id); if (o) res.push(o); }
  out.forEach(o => { if (o.id === null) res.push(o); });
  return res;
}

/** Best melds from the hand alone, as tile-id arrays. */
export function handMelds(hand, obj = 'count', ms = 150) {
  const { a, j } = counts(hand);
  const r = solveCounts(Z(), a, 0, j, obj, ms);
  return r ? mapMelds(r.melds, hand) : [];
}

/** Splits an invalid set into valid ones using every tile (e.g. run 1-5 plus
    another 3 becomes 1,2,3 + 3,4,5). Returns tile-id arrays, or null when the
    set is already valid or no such split exists. */
export function splitSet(ids, ms = 60) {
  if (ids.length < 6 || analyze(ids)) return null;
  const { a, j } = counts(ids);
  const r = solveCounts(a, Z(), j, 0, 'count', ms, true);
  if (!r || r.melds.length < 2) return null;
  const parts = mapMelds(r.melds, ids);
  return parts.every(p => analyze(p)) ? parts : null;
}

/** Plan A: melds from the hand plus extensions of existing sets; the table is untouched. */
export function planSimple(hand, board) {
  const sets = board.map(s => ({ id: s.id, tiles: s.tiles.slice() }));
  let rest = hand.slice();
  for (const m of handMelds(hand, 'count', 250)) { sets.push({ id: null, tiles: m }); rest = rest.filter(id => !m.includes(id)); }
  let changed = true;
  while (changed) {
    changed = false;
    rest.sort((x, y) => isJ(x) - isJ(y));
    for (const id of rest.slice()) {
      const s = sets.find(s => analyze(s.tiles.concat(id)));
      if (s) { s.tiles.push(id); rest.splice(rest.indexOf(id), 1); changed = true; }
    }
  }
  return { board: sets, played: hand.filter(id => !rest.includes(id)) };
}

/** Plan B: after plan A, keep feeding leftover tiles (singly, then in pairs)
    into the table and ask the solver whether the whole table can be rebuilt. */
export function planFull(hand, board, ms) {
  const t0 = now(), a = planSimple(hand, board);
  const table = a.board.flatMap(s => s.tiles);
  let rest = hand.filter(id => !a.played.includes(id)), melds = null;
  const fits = ids => {
    const c = counts(table.concat(ids));
    const left = ms - (now() - t0);
    if (left < 20) return null;
    return solveCounts(c.a, Z(), c.j, 0, 'count', Math.min(160, left), true);
  };
  const add = (ids, r) => { table.push(...ids); rest = rest.filter(id => !ids.includes(id)); melds = r.melds; };
  let progress = true;
  while (progress && now() - t0 < ms) {
    progress = false;
    rest.sort((x, y) => (isJ(x) - isJ(y)) || T[y].n - T[x].n);
    for (const id of rest.slice()) { if (isJ(id)) continue; const r = fits([id]); if (r) { add([id], r); progress = true; } }
    if (progress) continue;
    outer: for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) {
      const x = rest[i], y = rest[j];
      if (isJ(x) || isJ(y)) continue;
      const near = (T[x].c === T[y].c && Math.abs(T[x].n - T[y].n) <= 2) || (T[x].n === T[y].n && T[x].c !== T[y].c);
      if (!near) continue;
      if (now() - t0 > ms) break outer;
      const r = fits([x, y]);
      if (r) { add([x, y], r); progress = true; break outer; }
    }
  }
  if (!melds) return a;
  const played = hand.filter(id => !rest.includes(id));
  const sets = materialize(melds, board, played);
  const on = new Set(sets.flatMap(s => s.tiles));
  if (table.some(id => !on.has(id)) || sets.some(s => !analyze(s.tiles))) return a;
  return { board: sets, played };
}

/**
 * Best play for a hand. board is [{id, tiles}]. Before the initial meld only
 * hand melds count (maximising value). Returns null when nothing can be played.
 */
export function bestPlan(hand, melded, board, full, ms) {
  if (!melded) {
    const sets = handMelds(hand, 'value', ms).map(t => ({ id: null, tiles: t }));
    if (!sets.length) return null;
    return {
      initial: true,
      board: board.map(s => ({ id: s.id, tiles: s.tiles.slice() })).concat(sets),
      played: sets.flatMap(s => s.tiles),
      value: sets.reduce((v, s) => v + setValue(s.tiles), 0),
    };
  }
  const best = full ? planFull(hand, board, ms) : planSimple(hand, board);
  return best.played.length ? { initial: false, ...best } : null;
}
