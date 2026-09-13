/* ==========================================================
   名簿 — app.js
   依存なし。データは IndexedDB（フォールバック: localStorage）に保存。
   ========================================================== */
(() => {
'use strict';

/* ---------- ユーティリティ ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };

/** 検索用に正規化: NFKC、小文字、カタカナ→ひらがな、空白除去 */
function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s　]+/g, '');
}

/** 減衰比 + 応答時間で表現するスプリング（Apple の damping/response）*/
function spring({ from, to, velocity = 0, response = 0.35, damping = 1, onUpdate, onDone }) {
  if (reducedMotion.matches) { onUpdate(to); onDone && onDone(); return { cancel() {} }; }
  const w0 = (2 * Math.PI) / response;
  const zeta = Math.min(damping, 1);
  const x0 = from - to;
  const v0 = velocity;
  let start = null, raf = 0;
  const frame = (t) => {
    if (start === null) start = t;
    const dt = (t - start) / 1000;
    let x;
    if (zeta >= 1) {
      x = (x0 + (v0 + w0 * x0) * dt) * Math.exp(-w0 * dt);
    } else {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      x = Math.exp(-zeta * w0 * dt) * (x0 * Math.cos(wd * dt) + ((v0 + zeta * w0 * x0) / wd) * Math.sin(wd * dt));
    }
    if (Math.abs(x) < 0.25 && dt > response * 0.6 || dt > 2.5) { onUpdate(to); onDone && onDone(); return; }
    onUpdate(to + x);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return { cancel() { cancelAnimationFrame(raf); } };
}

/** Apple の momentum projection */
const project = (v, d = 0.998) => ((v / 1000) * d) / (1 - d);
const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

/* ---------- 保存（IndexedDB / localStorage） ---------- */
const DB_NAME = 'meibo', STORE = 'kv', KEY = 'state', LS_KEY = 'meibo:state';
const storage = {
  db: null,
  async open() {
    if (!('indexedDB' in window)) return null;
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  },
  async load() {
    this.db = await this.open();
    if (this.db) {
      const val = await new Promise((resolve) => {
        const tx = this.db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(KEY);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
      if (val) return val;
    }
    try { const s = localStorage.getItem(LS_KEY); if (s) return JSON.parse(s); } catch (_) {}
    return null;
  },
  async save(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) {}
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },
};

/* ---------- 状態 ---------- */
const DEFAULT = () => ({
  version: 1,
  people: [],
  places: [],
  tags: [],
  ui: { sort: 'manual', groupByPlace: false, showKana: false, birthdayBanner: true },
});
let state = DEFAULT();

// フィルタ状態（保存しない）
const filter = { q: '', placeId: null, tagIds: new Set() };
let editMode = false;

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storage.save(state), 120);
}

const COLORS = [
  { id: 'red', v: '#ff3b30' }, { id: 'orange', v: '#ff9500' }, { id: 'yellow', v: '#ffcc00' },
  { id: 'green', v: '#34c759' }, { id: 'mint', v: '#00c7be' }, { id: 'teal', v: '#30b0c7' },
  { id: 'cyan', v: '#32ade6' }, { id: 'blue', v: '#007aff' }, { id: 'indigo', v: '#5856d6' },
  { id: 'purple', v: '#af52de' }, { id: 'pink', v: '#ff2d55' }, { id: 'brown', v: '#a2845e' },
  { id: 'gray', v: '#8e8e93' },
];
const colorOf = (id) => (COLORS.find((c) => c.id === id) || {}).v || '';

const placeById = (id) => state.places.find((p) => p.id === id);
const tagById = (id) => state.tags.find((t) => t.id === id);
const personById = (id) => state.people.find((p) => p.id === id);

/* ---------- 誕生日 ---------- */
function daysUntilBirthday(b, now = new Date()) {
  if (!b || !b.month || !b.day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(today.getFullYear(), b.month - 1, b.day);
  if (next.getMonth() !== b.month - 1) next = new Date(today.getFullYear(), b.month, 0); // 2/29 → 2/28
  if (next < today) {
    next = new Date(today.getFullYear() + 1, b.month - 1, b.day);
    if (next.getMonth() !== b.month - 1) next = new Date(today.getFullYear() + 1, b.month, 0);
  }
  return Math.round((next - today) / 86400000);
}
function ageOf(b, now = new Date()) {
  if (!b || !b.year || !b.month || !b.day) return null;
  let age = now.getFullYear() - b.year;
  const m = now.getMonth() + 1 - b.month;
  if (m < 0 || (m === 0 && now.getDate() < b.day)) age--;
  return age;
}
function birthdayText(b) {
  if (!b || !b.month || !b.day) return '';
  return (b.year ? `${b.year}年` : '') + `${b.month}月${b.day}日`;
}

/* ---------- 検索・絞り込み ---------- */
function searchable(p) {
  return norm([
    p.name, p.kana, ...(p.aliases || []), p.note,
    ...(p.tagIds || []).map((id) => tagById(id)?.name),
    ...(p.placeIds || []).map((id) => placeById(id)?.name),
    birthdayText(p.birthday),
  ].filter(Boolean).join(''));
}

function sortKeyName(p) { return norm(p.kana || p.name); }

function filteredPeople() {
  const tokens = filter.q.normalize('NFKC').split(/[\s　]+/).map(norm).filter(Boolean);
  let list = state.people.filter((p) => {
    if (filter.placeId && !(p.placeIds || []).includes(filter.placeId)) return false;
    for (const t of filter.tagIds) if (!(p.tagIds || []).includes(t)) return false;
    if (tokens.length) {
      const hay = searchable(p);
      for (const tk of tokens) if (!hay.includes(tk)) return false;
    }
    return true;
  });
  const s = state.ui.sort;
  if (s === 'manual') list.sort((a, b) => a.order - b.order);
  else if (s === 'name') list.sort((a, b) => sortKeyName(a).localeCompare(sortKeyName(b), 'ja') || a.order - b.order);
  else if (s === 'birthday') list.sort((a, b) => (daysUntilBirthday(a.birthday) ?? 9999) - (daysUntilBirthday(b.birthday) ?? 9999) || a.order - b.order);
  else if (s === 'created') list.sort((a, b) => b.createdAt - a.createdAt);
  else if (s === 'updated') list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

const SORTS = [
  { id: 'manual', label: '手動', desc: '編集モードでドラッグして並び替え' },
  { id: 'name', label: '名前順', desc: 'ふりがな（なければ名前）で五十音順' },
  { id: 'birthday', label: '誕生日が近い順', desc: '誕生日未設定の人は最後' },
  { id: 'created', label: '追加が新しい順' },
  { id: 'updated', label: '更新が新しい順' },
];

/* ---------- レンダリング: 名簿 ---------- */
const listEl = $('#people-list');

function initialOf(name) {
  const s = String(name || '').trim();
  return s ? Array.from(s)[0] : '?';
}

function personCard(p) {
  const places = (p.placeIds || []).map(placeById).filter(Boolean);
  const tags = (p.tagIds || []).map(tagById).filter(Boolean);
  const dU = daysUntilBirthday(p.birthday);
  let bday = '';
  if (dU !== null && dU <= 7) bday = dU === 0 ? '<span class="bday-badge today">今日誕生日</span>' : `<span class="bday-badge">あと${dU}日</span>`;
  else if (state.ui.sort === 'birthday' && dU !== null) bday = `<span class="bday-badge" style="background:var(--fill);color:var(--text-2)">あと${dU}日</span>`;
  const sub = [
    p.aliases?.length ? p.aliases.join('・') : '',
    p.note ? p.note.split('\n')[0] : '',
  ].filter(Boolean).join(' — ');
  const c = colorOf(p.color);
  return `<div class="person" data-id="${p.id}" role="button" tabindex="0" style="${c ? `--pc:${c}` : ''}">
    <div class="avatar" aria-hidden="true">${esc(initialOf(p.name))}</div>
    <div class="person-main">
      <div class="person-name"><span class="nm">${esc(p.name)}</span>${state.ui.showKana && p.kana ? `<span class="kana">${esc(p.kana)}</span>` : ''}</div>
      ${sub ? `<div class="person-sub">${esc(sub)}</div>` : ''}
      <div class="person-tags">${places.map((pl) => `<span class="tag-pill place">${esc(pl.name)}</span>`).join('')}${tags.map((t) => `<span class="tag-pill">${esc(t.name)}</span>`).join('')}</div>
    </div>
    <div class="person-side">
      ${bday}
      <button class="del-btn" type="button" aria-label="${esc(p.name)}を削除" data-del="${p.id}">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8 12h8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>
      <span class="chev" aria-hidden="true"></span>
      <button class="handle${canReorder() ? '' : ' disabled'}" type="button" aria-label="並び替え" data-handle="${p.id}">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>`;
}

function canReorder() { return state.ui.sort === 'manual' && !state.ui.groupByPlace; }

function renderList() {
  const list = filteredPeople();
  const total = state.people.length;
  const hasFilter = filter.q || filter.placeId || filter.tagIds.size;
  $('#result-count').textContent = hasFilter ? `${list.length} / ${total}人` : `${total}人`;
  $('#sort-label').textContent = SORTS.find((s) => s.id === state.ui.sort)?.label || '';

  const empty = $('#empty-state');
  if (!list.length) {
    listEl.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = total === 0
      ? `<strong>まだ誰も登録されていません</strong>右上の＋から最初の人物を追加しましょう。<br><button class="link-btn" type="button" id="empty-add">人物を追加</button>`
      : `<strong>見つかりません</strong>キーワードや絞り込みを変えてみてください。<br><button class="link-btn" type="button" id="empty-clear">絞り込みを解除</button>`;
    $('#empty-add')?.addEventListener('click', () => openEdit(null));
    $('#empty-clear')?.addEventListener('click', clearFilters);
    return;
  }
  empty.hidden = true;

  if (state.ui.groupByPlace) {
    const groups = new Map();
    const noPlace = [];
    for (const p of list) {
      const ids = (p.placeIds || []).filter(placeById);
      if (!ids.length) { noPlace.push(p); continue; }
      for (const id of ids) { if (!groups.has(id)) groups.set(id, []); groups.get(id).push(p); }
    }
    let html = '';
    for (const pl of state.places) {
      const ps = groups.get(pl.id);
      if (!ps) continue;
      html += `<div class="group-title">${esc(pl.name)} <span style="font-weight:400">${ps.length}</span></div>` + ps.map(personCard).join('');
    }
    if (noPlace.length) html += `<div class="group-title">場所なし <span style="font-weight:400">${noPlace.length}</span></div>` + noPlace.map(personCard).join('');
    listEl.innerHTML = html;
  } else {
    listEl.innerHTML = list.map(personCard).join('');
  }
}

function renderChips() {
  const pc = $('#place-chips');
  const tc = $('#tag-chips');
  const countBy = (key, id) => state.people.filter((p) => (p[key] || []).includes(id)).length;
  pc.innerHTML = state.places.length
    ? `<button class="chip${filter.placeId === null ? ' on' : ''}" type="button" data-place="">すべて</button>` +
      state.places.map((pl) => `<button class="chip${filter.placeId === pl.id ? ' on' : ''}" type="button" data-place="${pl.id}">${esc(pl.name)}<span class="cnt">${countBy('placeIds', pl.id)}</span></button>`).join('')
    : '';
  tc.innerHTML = state.tags.length
    ? `<span class="chip chip-label" aria-hidden="true">タグ</span>` +
      state.tags.map((t) => `<button class="chip tag-chip${filter.tagIds.has(t.id) ? ' on' : ''}" type="button" data-tag="${t.id}" aria-pressed="${filter.tagIds.has(t.id)}">${esc(t.name)}<span class="cnt">${countBy('tagIds', t.id)}</span></button>`).join('')
    : '';
}

function renderBanner() {
  const el = $('#birthday-banner');
  if (!state.ui.birthdayBanner) { el.hidden = true; return; }
  const soon = state.people.map((p) => ({ p, d: daysUntilBirthday(p.birthday) })).filter((x) => x.d !== null && x.d <= 7).sort((a, b) => a.d - b.d);
  if (!soon.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="ico" aria-hidden="true">🎂</span><div>${soon.slice(0, 3).map((x) => `<b>${esc(x.p.name)}</b>さん${x.d === 0 ? 'は今日が誕生日' : `はあと${x.d}日`}`).join('、')}${soon.length > 3 ? ` ほか${soon.length - 3}人` : ''}</div>`;
}

function renderPeopleView() { renderChips(); renderBanner(); renderList(); }
function clearFilters() { filter.q = ''; filter.placeId = null; filter.tagIds.clear(); $('#search').value = ''; $('#search-clear').hidden = true; renderPeopleView(); }

/* ---------- レンダリング: 場所・タグ ---------- */
function renderGroups() {
  const build = (items, key, kind) => items.length
    ? items.map((g) => `<div class="g-row" data-id="${g.id}">
        <button class="g-name" type="button" data-gedit="${kind}:${g.id}"><span>${esc(g.name)}</span></button>
        <span class="g-cnt">${state.people.filter((p) => (p[key] || []).includes(g.id)).length}人</span>
        <button class="handle" type="button" aria-label="並び替え" data-ghandle="${g.id}">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>`).join('')
    : `<div class="empty-row">まだありません</div>`;
  $('#place-list').innerHTML = build(state.places, 'placeIds', 'place');
  $('#tag-list').innerHTML = build(state.tags, 'tagIds', 'tag');
}

/* ---------- レンダリング: 設定 ---------- */
function renderSettings() {
  $('#opt-show-kana').checked = !!state.ui.showKana;
  $('#opt-birthday-banner').checked = !!state.ui.birthdayBanner;
  $('#export-sub').textContent = `${state.people.length}人`;
}

/* ---------- タブ ---------- */
function showTab(name) {
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  window.scrollTo(0, 0);
  if (name === 'groups') renderGroups();
  if (name === 'settings') renderSettings();
  if (name === 'people') renderPeopleView();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

/* ---------- シート管理（履歴と連動） ---------- */
const scrim = $('#scrim');
const sheetStack = []; // { id, el, anim, onClose }
let ignorePop = false;

function currentSheet() { return sheetStack[sheetStack.length - 1]; }

function openSheet(id, { onClose } = {}) {
  const el = $('#' + id);
  const entry = { id, el, anim: null, onClose };
  sheetStack.push(entry);
  el.hidden = false;
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('show'));
  document.body.style.overflow = 'hidden';
  el.style.transform = 'translateY(100%)';
  entry.y = el.offsetHeight;
  entry.anim = spring({ from: entry.y, to: 0, response: 0.4, damping: 1, onUpdate: (v) => setSheetY(entry, v) });
  history.pushState({ sheet: id, n: sheetStack.length }, '');
  el.querySelector('.sheet-body')?.scrollTo(0, 0);
  // 下位シートを奥へ押し込む
  updateStackDepth();
}
function setSheetY(entry, y) { entry.y = y; entry.el.style.transform = `translateY(${Math.max(-40, y)}px)`; }

function updateStackDepth() {
  sheetStack.forEach((s, i) => {
    const depth = sheetStack.length - 1 - i;
    s.el.style.filter = depth ? `brightness(${1 - depth * 0.15})` : '';
    s.el.style.transition = 'filter 240ms';
  });
}

/** UI からの閉じる要求。履歴を戻し、popstate 側で実際に閉じる */
function requestClose() {
  if (!sheetStack.length) return;
  history.back();
}

function closeTopSheet() {
  const entry = sheetStack.pop();
  if (!entry) return;
  const velocity = entry.pendingVelocity || 0; // ドラッグで閉じた場合は指の速度を引き継ぐ
  entry.pendingVelocity = 0;
  entry.anim?.cancel();
  const h = entry.el.offsetHeight;
  entry.anim = spring({
    from: entry.y ?? 0, to: h + 20, velocity, response: 0.32, damping: 1,
    onUpdate: (v) => setSheetY(entry, v),
    onDone: () => { entry.el.hidden = true; entry.el.style.transform = ''; },
  });
  if (!sheetStack.length) {
    scrim.classList.remove('show');
    setTimeout(() => { if (!sheetStack.length) { scrim.hidden = true; document.body.style.overflow = ''; } }, 260);
  }
  updateStackDepth();
  entry.onClose && entry.onClose();
}

window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  if (sheetStack.length) closeTopSheet();
});
scrim.addEventListener('click', requestClose);
$$('[data-close]').forEach((b) => b.addEventListener('click', requestClose));

/* シートのドラッグで閉じる（グラバー・ヘッダーから） */
$$('.sheet').forEach((el) => {
  const zones = [el.querySelector('.sheet-grabber'), el.querySelector('.sheet-head')];
  const body = el.querySelector('.sheet-body');
  let track = null;
  const start = (e) => {
    const entry = currentSheet();
    if (!entry || entry.el !== el || e.button > 0) return;
    if (e.target.closest('button')) return; // ボタンはタップとして扱う（キャプチャすると click が奪われる）
    entry.anim?.cancel();
    track = { id: e.pointerId, startY: e.clientY, baseY: entry.y || 0, hist: [[e.clientY, performance.now()]], fromBody: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!track || e.pointerId !== track.id) return;
    const entry = currentSheet();
    if (!entry) return;
    let dy = track.baseY + (e.clientY - track.startY);
    if (dy < 0) dy = rubberband(dy, 200);
    setSheetY(entry, dy);
    track.hist.push([e.clientY, performance.now()]);
    if (track.hist.length > 6) track.hist.shift();
  };
  const end = (e) => {
    if (!track || e.pointerId !== track.id) return;
    const entry = currentSheet();
    const h = el.offsetHeight;
    const [y0, t0] = track.hist[0], [y1, t1] = track.hist[track.hist.length - 1];
    const v = t1 > t0 ? ((y1 - y0) / (t1 - t0)) * 1000 : 0; // px/s
    track = null;
    if (!entry) return;
    const projected = entry.y + project(v);
    if (projected > h * 0.5 || v > 900) {
      entry.pendingVelocity = v;
      history.back();
    } else {
      entry.anim = spring({ from: entry.y, to: 0, velocity: v, response: 0.35, damping: 0.85, onUpdate: (val) => setSheetY(entry, val) });
    }
  };
  zones.forEach((z) => {
    if (!z) return;
    z.addEventListener('pointerdown', start);
    z.addEventListener('pointermove', move);
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  });
  // 本文が最上部のときだけ、下方向ドラッグをシート移動として扱う
  if (body) {
    let bTrack = null;
    body.addEventListener('touchstart', (e) => {
      if (body.scrollTop > 0) { bTrack = null; return; }
      bTrack = { y: e.touches[0].clientY, t: performance.now(), active: false, hist: [] };
    }, { passive: true });
    body.addEventListener('touchmove', (e) => {
      if (!bTrack) return;
      const entry = currentSheet();
      if (!entry || entry.el !== el) return;
      const dy = e.touches[0].clientY - bTrack.y;
      if (!bTrack.active) {
        if (dy > 12 && body.scrollTop <= 0) { bTrack.active = true; entry.anim?.cancel(); }
        else if (dy < -4) { bTrack = null; return; }
        else return;
      }
      if (e.cancelable) e.preventDefault();
      setSheetY(entry, Math.max(0, dy - 12));
      bTrack.hist.push([e.touches[0].clientY, performance.now()]);
      if (bTrack.hist.length > 6) bTrack.hist.shift();
    }, { passive: false });
    const bEnd = () => {
      if (!bTrack || !bTrack.active) { bTrack = null; return; }
      const entry = currentSheet();
      bTrack.active = false;
      const hist = bTrack.hist; bTrack = null;
      if (!entry || hist.length < 2) { entry && setSheetY(entry, 0); return; }
      const [y0, t0] = hist[0], [y1, t1] = hist[hist.length - 1];
      const v = t1 > t0 ? ((y1 - y0) / (t1 - t0)) * 1000 : 0;
      if (entry.y + project(v) > el.offsetHeight * 0.5 || v > 900) { entry.pendingVelocity = v; history.back(); }
      else entry.anim = spring({ from: entry.y, to: 0, velocity: v, response: 0.35, damping: 0.85, onUpdate: (val) => setSheetY(entry, val) });
    };
    body.addEventListener('touchend', bEnd, { passive: true });
    body.addEventListener('touchcancel', bEnd, { passive: true });
  }
});

/* ---------- アラート・トースト ---------- */
function alertDialog({ title, message = '', actions }) {
  return new Promise((resolve) => {
    const wrap = $('#alert');
    $('#alert-title').textContent = title;
    $('#alert-msg').textContent = message;
    $('#alert-msg').hidden = !message;
    const box = $('#alert-actions');
    box.innerHTML = '';
    box.classList.toggle('stack', actions.length > 2);
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.bold) b.classList.add('bold');
      if (a.danger) b.classList.add('danger');
      b.addEventListener('click', () => { wrap.hidden = true; resolve(a.value); });
      box.appendChild(b);
    });
    wrap.hidden = false;
  });
}
const confirmDialog = (title, message, okLabel = '削除', danger = true) =>
  alertDialog({ title, message, actions: [{ label: 'キャンセル', value: false, bold: !danger }, { label: okLabel, value: true, danger, bold: danger }] });

let toastTimer = 0;
function toast(msg, { action, onAction, duration = 4000 } = {}) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.classList.remove('out');
  el.hidden = false;
  $('#toast-msg').textContent = msg;
  const btn = $('#toast-action');
  btn.hidden = !action;
  btn.textContent = action || '';
  btn.onclick = () => { onAction && onAction(); hideToast(); };
  toastTimer = setTimeout(hideToast, duration);
}
function hideToast() {
  const el = $('#toast');
  if (el.hidden) return;
  el.classList.add('out');
  setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 230);
}

/* ---------- 人物詳細 ---------- */
let detailId = null;
function openDetail(id) {
  detailId = id;
  renderDetail();
  openSheet('sheet-detail', { onClose: () => { if (!sheetStack.some((s) => s.id === 'sheet-detail')) detailId = null; } });
}
function renderDetail() {
  const p = personById(detailId);
  if (!p) return;
  const c = colorOf(p.color);
  const places = (p.placeIds || []).map(placeById).filter(Boolean);
  const tags = (p.tagIds || []).map(tagById).filter(Boolean);
  const age = ageOf(p.birthday);
  const dU = daysUntilBirthday(p.birthday);
  const fmt = (t) => new Date(t).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
  const row = (k, v) => v ? `<div class="detail-row"><div class="k">${k}</div><div class="v">${v}</div></div>` : '';
  $('#detail-body').innerHTML = `
    <div class="detail-hero" style="${c ? `--pc:${c}` : ''}">
      <div class="avatar" aria-hidden="true">${esc(initialOf(p.name))}</div>
      <h2>${esc(p.name)}</h2>
      ${p.kana ? `<div class="kana">${esc(p.kana)}</div>` : ''}
      ${p.aliases?.length ? `<div class="detail-aliases">${p.aliases.map((a) => `<span class="alias">${esc(a)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="group-list">
      ${row('場所', places.length ? `<div class="pills">${places.map((x) => `<span class="tag-pill place">${esc(x.name)}</span>`).join('')}</div>` : '')}
      ${row('タグ', tags.length ? `<div class="pills">${tags.map((x) => `<span class="tag-pill">${esc(x.name)}</span>`).join('')}</div>` : '')}
      ${row('誕生日', p.birthday?.month ? `${esc(birthdayText(p.birthday))}${age !== null ? `<span class="sub">（${age}歳）</span>` : ''}<div class="sub">${dU === 0 ? '今日が誕生日です' : `次の誕生日まであと${dU}日`}</div>` : '')}
      ${row('メモ', p.note ? esc(p.note) : '')}
      ${!places.length && !tags.length && !p.birthday?.month && !p.note ? `<div class="detail-row"><div class="v" style="color:var(--text-2)">まだ情報がありません。右上の「編集」から追加できます。</div></div>` : ''}
    </div>
    <div class="group-list detail-actions">
      <button class="row destructive center" type="button" id="btn-detail-delete">この人物を削除</button>
    </div>
    <div class="detail-meta">追加 ${fmt(p.createdAt)} ・ 更新 ${fmt(p.updatedAt)}</div>`;
  $('#btn-detail-delete').addEventListener('click', () => deletePerson(p.id, true));
}
$('#btn-detail-edit').addEventListener('click', () => detailId && openEdit(detailId));

async function deletePerson(id, fromDetail = false) {
  const p = personById(id);
  if (!p) return;
  if (!(await confirmDialog(`「${p.name}」を削除しますか？`, '削除後、数秒間は元に戻せます。'))) return;
  const idx = state.people.indexOf(p);
  state.people.splice(idx, 1);
  save();
  haptic(12);
  if (fromDetail) requestClose();
  renderPeopleView();
  toast(`${p.name} を削除しました`, { action: '元に戻す', onAction: () => { state.people.splice(Math.min(idx, state.people.length), 0, p); save(); renderPeopleView(); } });
}

/* ---------- 人物編集フォーム ---------- */
const form = {
  id: null, aliases: [], placeIds: new Set(), tagIds: new Set(), color: '', dirty: false,
};
const F = {
  name: $('#f-name'), kana: $('#f-kana'), note: $('#f-note'),
  byear: $('#f-byear'), bmonth: $('#f-bmonth'), bday: $('#f-bday'),
  aliases: $('#f-aliases'), places: $('#f-places'), tags: $('#f-tags'), color: $('#f-color'),
  newPlace: $('#f-new-place'), newTag: $('#f-new-tag'), avatar: $('#edit-avatar'),
};
for (let m = 1; m <= 12; m++) F.bmonth.insertAdjacentHTML('beforeend', `<option value="${m}">${m}月</option>`);
for (let d = 1; d <= 31; d++) F.bday.insertAdjacentHTML('beforeend', `<option value="${d}">${d}日</option>`);

function openEdit(id) {
  const p = id ? personById(id) : null;
  form.id = p ? p.id : null;
  form.aliases = p ? [...(p.aliases || [])] : [];
  form.placeIds = new Set(p ? p.placeIds || [] : filter.placeId ? [filter.placeId] : []);
  form.tagIds = new Set(p ? p.tagIds || [] : [...filter.tagIds]);
  form.color = p ? p.color || '' : '';
  form.dirty = false;
  $('#edit-title').textContent = p ? '編集' : '新規';
  F.name.value = p?.name || '';
  F.kana.value = p?.kana || '';
  F.note.value = p?.note || '';
  F.byear.value = p?.birthday?.year || '';
  F.bmonth.value = p?.birthday?.month || '';
  F.bday.value = p?.birthday?.day || '';
  F.newPlace.value = ''; F.newTag.value = '';
  renderFormChips();
  updateSaveState();
  openSheet('sheet-edit');
  if (!p) setTimeout(() => F.name.focus({ preventScroll: true }), 350);
}

function renderFormChips() {
  F.aliases.querySelector('.chip-list').innerHTML = form.aliases.map((a, i) => `<button class="chip removable" type="button" data-alias="${i}" aria-label="${esc(a)} を削除">${esc(a)}<span class="x" aria-hidden="true"></span></button>`).join('');
  F.places.innerHTML = state.places.map((pl) => `<button class="chip${form.placeIds.has(pl.id) ? ' on' : ''}" type="button" data-fplace="${pl.id}" aria-pressed="${form.placeIds.has(pl.id)}">${esc(pl.name)}</button>`).join('');
  F.tags.innerHTML = state.tags.map((t) => `<button class="chip tag-chip${form.tagIds.has(t.id) ? ' on' : ''}" type="button" data-ftag="${t.id}" aria-pressed="${form.tagIds.has(t.id)}">${esc(t.name)}</button>`).join('');
  F.color.innerHTML = `<button class="swatch none${!form.color ? ' on' : ''}" type="button" role="radio" aria-checked="${!form.color}" aria-label="色なし" data-color=""></button>` +
    COLORS.map((c) => `<button class="swatch${form.color === c.id ? ' on' : ''}" type="button" role="radio" aria-checked="${form.color === c.id}" aria-label="${c.id}" data-color="${c.id}" style="--sc:${c.v}"></button>`).join('');
  updateAvatarPreview();
}
function updateAvatarPreview() {
  const c = colorOf(form.color);
  F.avatar.style.setProperty('--pc', c || '#8e8e93');
  F.avatar.textContent = initialOf(F.name.value);
}
function updateSaveState() {
  $('#btn-save').disabled = !F.name.value.trim();
}
function markDirty() { form.dirty = true; updateSaveState(); }

['input', 'change'].forEach((ev) => $('#edit-form').addEventListener(ev, (e) => { markDirty(); if (e.target === F.name) updateAvatarPreview(); }));
$('#edit-form').addEventListener('submit', (e) => e.preventDefault());

// 別名
const aliasInput = F.aliases.querySelector('input');
function addAlias() {
  const v = aliasInput.value.trim();
  if (!v) return;
  if (!form.aliases.includes(v)) form.aliases.push(v);
  aliasInput.value = '';
  markDirty();
  renderFormChips();
  aliasInput.focus();
}
aliasInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } });
F.aliases.querySelector('.mini-btn').addEventListener('click', addAlias);
F.aliases.addEventListener('click', (e) => {
  const b = e.target.closest('[data-alias]');
  if (!b) return;
  form.aliases.splice(+b.dataset.alias, 1);
  markDirty(); renderFormChips();
});

// 場所・タグ トグル
F.places.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fplace]'); if (!b) return;
  const id = b.dataset.fplace; form.placeIds.has(id) ? form.placeIds.delete(id) : form.placeIds.add(id);
  markDirty(); renderFormChips();
});
F.tags.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ftag]'); if (!b) return;
  const id = b.dataset.ftag; form.tagIds.has(id) ? form.tagIds.delete(id) : form.tagIds.add(id);
  markDirty(); renderFormChips();
});
function createGroupInline(kind) {
  const input = kind === 'place' ? F.newPlace : F.newTag;
  const name = input.value.trim();
  if (!name) return;
  const g = addGroup(kind, name);
  (kind === 'place' ? form.placeIds : form.tagIds).add(g.id);
  input.value = '';
  markDirty(); renderFormChips();
}
$('#btn-new-place').addEventListener('click', () => createGroupInline('place'));
$('#btn-new-tag').addEventListener('click', () => createGroupInline('tag'));
F.newPlace.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createGroupInline('place'); } });
F.newTag.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createGroupInline('tag'); } });

// 色
F.color.addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]'); if (!b) return;
  form.color = b.dataset.color; markDirty(); renderFormChips(); haptic(5);
});

// 保存
$('#btn-save').addEventListener('click', () => {
  const name = F.name.value.trim();
  if (!name) return;
  const now = Date.now();
  const birthday = F.bmonth.value && F.bday.value ? { year: F.byear.value ? +F.byear.value : null, month: +F.bmonth.value, day: +F.bday.value } : null;
  const data = {
    name, kana: F.kana.value.trim(), aliases: [...form.aliases],
    placeIds: [...form.placeIds], tagIds: [...form.tagIds], color: form.color, birthday,
    note: F.note.value.trim(), updatedAt: now,
  };
  if (form.id) {
    Object.assign(personById(form.id), data);
  } else {
    const order = state.people.length ? Math.max(...state.people.map((p) => p.order)) + 1 : 0;
    state.people.push({ id: uid(), createdAt: now, order, ...data });
  }
  save();
  haptic(10);
  form.dirty = false;
  requestClose();
  if (detailId) renderDetail();
  renderPeopleView();
  if (!form.id) toast(`${name} を追加しました`);
});

/* ---------- 場所・タグ（グループ）編集 ---------- */
function addGroup(kind, name) {
  const arr = kind === 'place' ? state.places : state.tags;
  const existing = arr.find((g) => norm(g.name) === norm(name));
  if (existing) return existing;
  const g = { id: uid(), name };
  arr.push(g);
  save();
  return g;
}
const G = { kind: 'place', id: null };
function openGroupEdit(kind, id) {
  G.kind = kind; G.id = id;
  const arr = kind === 'place' ? state.places : state.tags;
  const g = id ? arr.find((x) => x.id === id) : null;
  $('#group-title').textContent = (kind === 'place' ? '場所' : 'タグ') + (g ? 'を編集' : 'を追加');
  $('#g-name').value = g?.name || '';
  $('#group-delete-wrap').hidden = !g;
  const key = kind === 'place' ? 'placeIds' : 'tagIds';
  const n = g ? state.people.filter((p) => (p[key] || []).includes(g.id)).length : 0;
  $('#group-count').textContent = g ? `${n}人に設定されています。削除しても人物は消えず、この${kind === 'place' ? '場所' : 'タグ'}だけが外れます。` : '';
  $('#btn-group-save').disabled = !$('#g-name').value.trim();
  openSheet('sheet-group');
  if (!g) setTimeout(() => $('#g-name').focus({ preventScroll: true }), 350);
}
$('#g-name').addEventListener('input', () => { $('#btn-group-save').disabled = !$('#g-name').value.trim(); });
$('#g-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-group-save').click(); } });
$('#btn-group-save').addEventListener('click', () => {
  const name = $('#g-name').value.trim();
  if (!name) return;
  const arr = G.kind === 'place' ? state.places : state.tags;
  if (G.id) { const g = arr.find((x) => x.id === G.id); if (g) g.name = name; }
  else addGroup(G.kind, name);
  save(); haptic(10);
  requestClose();
  renderGroups();
});
$('#btn-group-delete').addEventListener('click', async () => {
  const arr = G.kind === 'place' ? state.places : state.tags;
  const g = arr.find((x) => x.id === G.id);
  if (!g) return;
  if (!(await confirmDialog(`「${g.name}」を削除しますか？`, '人物データは残ります。'))) return;
  const key = G.kind === 'place' ? 'placeIds' : 'tagIds';
  arr.splice(arr.indexOf(g), 1);
  state.people.forEach((p) => { p[key] = (p[key] || []).filter((x) => x !== g.id); });
  if (filter.placeId === g.id) filter.placeId = null;
  filter.tagIds.delete(g.id);
  save(); haptic(12);
  requestClose();
  renderGroups();
});
$('#btn-add-place').addEventListener('click', () => openGroupEdit('place', null));
$('#btn-add-tag').addEventListener('click', () => openGroupEdit('tag', null));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-gedit]');
  if (!b) return;
  const [kind, id] = b.dataset.gedit.split(':');
  openGroupEdit(kind, id);
});

/* ---------- 並び替えシート ---------- */
function renderSortOptions() {
  $('#sort-options').innerHTML = SORTS.map((s) => `<button class="opt-row${state.ui.sort === s.id ? ' on' : ''}" type="button" role="radio" aria-checked="${state.ui.sort === s.id}" data-sort="${s.id}">
    <span>${s.label}${s.desc ? `<span class="desc">${s.desc}</span>` : ''}</span>
    <svg class="check" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`).join('');
  $('#opt-group-by-place').checked = !!state.ui.groupByPlace;
}
$('#btn-sort').addEventListener('click', () => { renderSortOptions(); openSheet('sheet-sort'); });
$('#sort-options').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]'); if (!b) return;
  state.ui.sort = b.dataset.sort; save(); renderSortOptions(); renderList(); haptic(5);
});
$('#opt-group-by-place').addEventListener('change', (e) => { state.ui.groupByPlace = e.target.checked; save(); renderList(); });

/* ---------- 設定 ---------- */
$('#opt-show-kana').addEventListener('change', (e) => { state.ui.showKana = e.target.checked; save(); });
$('#opt-birthday-banner').addEventListener('change', (e) => { state.ui.birthdayBanner = e.target.checked; save(); });

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `meibo-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('JSONを書き出しました');
});
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { alertDialog({ title: '読み込めません', message: 'JSONファイルの形式が正しくありません。', actions: [{ label: 'OK', value: true, bold: true }] }); return; }
  if (!data || !Array.isArray(data.people)) { alertDialog({ title: '読み込めません', message: 'このアプリで書き出したJSONではないようです。', actions: [{ label: 'OK', value: true, bold: true }] }); return; }
  const mode = await alertDialog({
    title: 'JSONを読み込む',
    message: `${data.people.length}人、場所${(data.places || []).length}件、タグ${(data.tags || []).length}件が含まれています。`,
    actions: [
      { label: '今のデータに追加（統合）', value: 'merge', bold: true },
      { label: '今のデータを置き換える', value: 'replace', danger: true },
      { label: 'キャンセル', value: null },
    ],
  });
  if (!mode) return;
  if (mode === 'replace') {
    state = normalizeState(data);
  } else {
    const incoming = normalizeState(data);
    // 場所・タグは名前で突き合わせ
    const mapIds = (srcArr, dstArr) => {
      const m = new Map();
      for (const g of srcArr) {
        let t = dstArr.find((x) => norm(x.name) === norm(g.name));
        if (!t) { t = { id: uid(), name: g.name }; dstArr.push(t); }
        m.set(g.id, t.id);
      }
      return m;
    };
    const pm = mapIds(incoming.places, state.places);
    const tm = mapIds(incoming.tags, state.tags);
    let base = state.people.length ? Math.max(...state.people.map((p) => p.order)) + 1 : 0;
    for (const p of incoming.people) {
      if (state.people.some((x) => x.id === p.id)) p.id = uid();
      p.placeIds = p.placeIds.map((x) => pm.get(x)).filter(Boolean);
      p.tagIds = p.tagIds.map((x) => tm.get(x)).filter(Boolean);
      p.order = base++;
      state.people.push(p);
    }
  }
  save();
  renderSettings();
  toast(mode === 'replace' ? '置き換えました' : '追加しました');
});

$('#btn-wipe').addEventListener('click', async () => {
  if (!(await confirmDialog('すべてのデータを削除しますか？', `${state.people.length}人の人物、場所、タグがこの端末から消えます。元に戻せません。`, '削除する'))) return;
  state = DEFAULT();
  save(); renderSettings();
  toast('削除しました');
});

/** 読み込んだデータの欠けを補う */
function normalizeState(raw) {
  const s = DEFAULT();
  s.ui = { ...s.ui, ...(raw.ui || {}) };
  s.places = (raw.places || []).filter((g) => g && g.name).map((g) => ({ id: g.id || uid(), name: String(g.name) }));
  s.tags = (raw.tags || []).filter((g) => g && g.name).map((g) => ({ id: g.id || uid(), name: String(g.name) }));
  s.people = (raw.people || []).filter((p) => p && p.name).map((p, i) => ({
    id: p.id || uid(), name: String(p.name), kana: String(p.kana || ''),
    aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
    placeIds: Array.isArray(p.placeIds) ? p.placeIds : [], tagIds: Array.isArray(p.tagIds) ? p.tagIds : [],
    color: p.color || '', birthday: p.birthday && p.birthday.month ? { year: p.birthday.year || null, month: +p.birthday.month, day: +p.birthday.day } : null,
    note: String(p.note || ''), order: typeof p.order === 'number' ? p.order : i,
    createdAt: p.createdAt || Date.now(), updatedAt: p.updatedAt || Date.now(),
  }));
  return s;
}

/* ---------- 名簿ビューの操作 ---------- */
const searchEl = $('#search');
let searchRaf = 0;
searchEl.addEventListener('input', () => {
  filter.q = searchEl.value;
  $('#search-clear').hidden = !filter.q;
  cancelAnimationFrame(searchRaf);
  searchRaf = requestAnimationFrame(renderList);
});
$('#search-clear').addEventListener('click', () => { searchEl.value = ''; filter.q = ''; $('#search-clear').hidden = true; renderList(); searchEl.focus(); });
$('#place-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-place]'); if (!b) return;
  filter.placeId = b.dataset.place || null;
  haptic(5); renderChips(); renderList();
  b.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
});
$('#tag-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]'); if (!b) return;
  const id = b.dataset.tag;
  filter.tagIds.has(id) ? filter.tagIds.delete(id) : filter.tagIds.add(id);
  haptic(5); renderChips(); renderList();
});
$('#btn-add').addEventListener('click', () => openEdit(null));
$('#btn-edit-mode').addEventListener('click', () => {
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  $('#btn-edit-mode').textContent = editMode ? '完了' : '編集';
  $('#btn-edit-mode').classList.toggle('strong', editMode);
  if (editMode && !canReorder()) toast('並び替えは「並び順: 手動」のときにできます', { duration: 3000 });
});

// タップ: pointerdown で即ハイライト、pointerup で確定。ドラッグ離脱でキャンセル。
let press = null;
listEl.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.person');
  if (!card || e.target.closest('button')) return;
  press = { el: card, x: e.clientX, y: e.clientY, id: e.pointerId };
  card.classList.add('pressed');
});
const cancelPress = () => { if (press) { press.el.classList.remove('pressed'); press = null; } };
listEl.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
});
listEl.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const id = press.el.dataset.id;
  cancelPress();
  openDetail(id);
});
listEl.addEventListener('pointercancel', cancelPress);
listEl.addEventListener('keydown', (e) => {
  const card = e.target.closest('.person');
  if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); openDetail(card.dataset.id); }
});
listEl.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { deletePerson(del.dataset.del); }
});

/* ---------- ドラッグ並び替え（人物・グループ共通） ---------- */
function makeSortable({ container, handleSelector, itemSelector, canDrag, onDrop }) {
  let drag = null;
  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest(handleSelector);
    if (!handle || e.button > 0) return;
    if (canDrag && !canDrag()) return;
    const item = handle.closest(itemSelector);
    if (!item) return;
    e.preventDefault();
    cancelPress();
    handle.setPointerCapture(e.pointerId);
    const items = $$(itemSelector, container);
    const rects = items.map((el) => el.getBoundingClientRect());
    const idx = items.indexOf(item);
    drag = { id: e.pointerId, item, items, rects, from: idx, to: idx, startY: e.clientY, grabOffset: e.clientY - rects[idx].top, lastY: e.clientY, autoRaf: 0, scrollBase: window.scrollY };
    item.classList.add('dragging');
    items.forEach((el) => { if (el !== item) el.classList.add('shifting'); });
    haptic(8);
  });
  const update = (clientY) => {
    if (!drag) return;
    const dy = clientY - drag.startY + (window.scrollY - drag.scrollBase);
    drag.item.style.transform = `translateY(${dy}px) scale(1.03)`;
    // ドラッグ中アイテムの中心位置から挿入先を決める
    const center = drag.rects[drag.from].top + drag.rects[drag.from].height / 2 + dy;
    let to = drag.from;
    for (let i = 0; i < drag.rects.length; i++) {
      if (i === drag.from) continue;
      const r = drag.rects[i];
      const mid = r.top + r.height / 2;
      if (i < drag.from && center < mid) { to = Math.min(to, i); }
      if (i > drag.from && center > mid) { to = Math.max(to, i); }
    }
    if (to !== drag.to) { drag.to = to; haptic(4); }
    const h = drag.rects[drag.from].height + gapOf();
    drag.items.forEach((el, i) => {
      if (i === drag.from) return;
      let shift = 0;
      if (i > drag.from && i <= drag.to) shift = -h;
      else if (i < drag.from && i >= drag.to) shift = h;
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const gapOf = () => {
    if (drag.rects.length < 2) return 0;
    const a = drag.rects[0], b = drag.rects[1];
    return Math.max(0, b.top - a.bottom);
  };
  const autoScroll = () => {
    if (!drag) return;
    const y = drag.lastY, vh = window.innerHeight, edge = 80;
    let delta = 0;
    if (y < edge + 120) delta = -Math.ceil((edge + 120 - y) / 8);
    else if (y > vh - edge - 60) delta = Math.ceil((y - (vh - edge - 60)) / 8);
    if (delta) { window.scrollBy(0, delta); update(drag.lastY); }
    drag.autoRaf = requestAnimationFrame(autoScroll);
  };
  container.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.lastY = e.clientY;
    if (!drag.autoRaf) drag.autoRaf = requestAnimationFrame(autoScroll);
    update(e.clientY);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    cancelAnimationFrame(drag.autoRaf);
    const { item, items, from, to } = drag;
    drag = null;
    items.forEach((el) => { el.style.transform = ''; el.classList.remove('shifting'); });
    item.classList.remove('dragging');
    if (from !== to) { haptic(10); onDrop(item, items, from, to); }
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
}

makeSortable({
  container: listEl, handleSelector: '[data-handle]', itemSelector: '.person',
  canDrag: () => editMode && canReorder(),
  onDrop: (item, items, from, to) => {
    // 表示中リスト（絞り込み後）の並びを、全体の order に反映する
    const visible = items.map((el) => personById(el.dataset.id)).filter(Boolean);
    const moved = visible.splice(from, 1)[0];
    visible.splice(to, 0, moved);
    const orders = visible.map((p) => p.order).sort((a, b) => a - b);
    visible.forEach((p, i) => { p.order = orders[i]; });
    save();
    renderList();
  },
});
['#place-list', '#tag-list'].forEach((sel) => {
  makeSortable({
    container: $(sel), handleSelector: '[data-ghandle]', itemSelector: '.g-row',
    onDrop: (item, items, from, to) => {
      const arr = sel === '#place-list' ? state.places : state.tags;
      const moved = arr.splice(from, 1)[0];
      arr.splice(to, 0, moved);
      save(); renderGroups();
    },
  });
});

/* ---------- スクロールでトップバーのタイトルを切替 ---------- */
let scrollRaf = 0;
window.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const on = window.scrollY > 36;
    $$('.topbar').forEach((t) => t.classList.toggle('scrolled', on));
  });
}, { passive: true });

/* ---------- キーボードショートカット（デスクトップ） ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if ($('#alert').hidden === false) return; if (sheetStack.length) requestClose(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !sheetStack.length) { e.preventDefault(); showTab('people'); searchEl.focus(); }
});

/* ---------- 起動 ---------- */
(async () => {
  const loaded = await storage.load();
  if (loaded) state = normalizeState(loaded);
  renderPeopleView();
  renderSettings();

  // 永続ストレージを要求（ブラウザ側の自動削除を防ぐ）
  const st = $('#storage-status');
  try {
    if (navigator.storage?.persist) {
      const ok = await navigator.storage.persist();
      st.textContent = ok ? '保護されています' : '端末内（保護なし）';
    } else st.textContent = '端末内';
  } catch (_) { st.textContent = '端末内'; }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

})();
