/*
 * newtab.js — Metro New Tab
 * Renders groups + tiles, fits everything on screen (no scrollbars), runs the
 * live clock, supports drag-and-drop, editable group titles, and an add/edit
 * modal that can create URL shortcuts or live tiles. Persisted via store.js.
 */

// Classic Windows Phone / Metro accent palette (tile colors)
const PALETTE = [
  '#a4c400', '#60a917', '#008a00', '#00aba9', '#1ba1e2', '#0050ef',
  '#6a00ff', '#aa00ff', '#f472d0', '#d80073', '#a20025', '#e51400',
  '#fa6800', '#f0a30a', '#e3c800', '#825a2c', '#6d8764', '#647687'
];

// Preset page backgrounds
const BG_PRESETS = ['#1f3a4d', '#2d2d30', '#1d1d1d', '#0b3d2e', '#3b2d4a', '#103a5c'];

let state = null;          // in-memory copy of the whole state object
let editingId = null;      // tile id being edited, or null while adding
let addGroupId = null;     // target group when adding
let modalType = 'shortcut';// 'shortcut' | 'clock' — what the modal is editing
let pickedColor = PALETTE[4];
let clockEls = [];         // {time, weekday, date} element triples for the clock
let sortables = [];        // active Sortable instances (destroyed before re-render)

init();

async function init() {
  state = await Store.load();
  applyBackground();
  applyDarkness();
  buildColorSwatches();
  buildSettingsPanel();
  document.getElementById('set-version').textContent =
    'Metro New Tab v' + chrome.runtime.getManifest().version;
  wireModal();
  wireSettings();
  render();
  startClock();

  window.addEventListener('resize', scheduleFit);

  // dismiss the context menu on outside click / Escape / resize
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
  window.addEventListener('resize', hideContextMenu);

  setupSleep();
}

/* ---------------- Rendering ---------------- */

function render() {
  clockEls = [];
  destroySortables();

  const board = document.getElementById('board');
  board.innerHTML = '';

  const groups = [...state.groups].sort((a, b) => a.order - b.order);
  for (const g of groups) {
    const section = document.createElement('section');
    section.className = 'group';

    const title = document.createElement('h2');
    title.className = 'group-title';
    title.textContent = g.title || '';
    title.addEventListener('contextmenu', (e) => { e.preventDefault(); showGroupMenu(e.clientX, e.clientY, g, title); });
    attachLongPress(title, () => {
      const r = title.getBoundingClientRect();
      showGroupMenu(r.left, r.bottom, g, title);
    });
    section.appendChild(title);

    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    tiles.dataset.group = g.id;

    const groupTiles = state.tiles
      .filter(t => t.groupId === g.id)
      .sort((a, b) => a.order - b.order);
    for (const t of groupTiles) tiles.appendChild(renderTile(t));

    section.appendChild(tiles);
    board.appendChild(section);
  }

  initDnD();
  fit();
}

function renderTile(tile) {
  if (tile.type === 'clock') return renderClock(tile);

  const el = document.createElement('a');
  el.className = 'tile shortcut';
  el.href = tile.url;
  el.style.background = tile.color;
  el.dataset.id = tile.id;

  const letter = document.createElement('span');
  letter.className = 'letter';
  letter.textContent = letterFor(tile);
  el.appendChild(letter);

  const img = document.createElement('img');
  img.className = 'favicon';
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = faviconURL(tile.url, 32);
  img.addEventListener('load', () => { if (img.naturalWidth > 0) letter.style.display = 'none'; });
  img.addEventListener('error', () => img.remove());
  el.appendChild(img);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = tile.title || hostnameOf(tile.url);
  el.appendChild(label);

  el.addEventListener('contextmenu', (e) => { e.preventDefault(); openEdit(tile); });
  attachLongPress(el, () => openEdit(tile));
  return el;
}

function renderClock(tile) {
  const el = document.createElement('div');
  el.className = 'tile clock';
  el.style.background = tile.color;
  el.dataset.id = tile.id;

  const time = document.createElement('div'); time.className = 'time';
  const weekday = document.createElement('div'); weekday.className = 'weekday';
  const date = document.createElement('div'); date.className = 'date';
  el.append(time, weekday, date);
  clockEls.push({ time, weekday, date });

  el.addEventListener('contextmenu', (e) => { e.preventDefault(); openEdit(tile); });
  attachLongPress(el, () => openEdit(tile));
  return el;
}

/* ---------------- Fit to screen (no scrollbars) ---------------- */

let fitPending = false;
function scheduleFit() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => { fitPending = false; if (state) fit(); });
}

/* Binary-search the tile size so the whole board fits both axes. Uses real
   layout sizing (not transform) so drag-and-drop coordinates stay correct. */
function fit() {
  const board = document.getElementById('board');
  const columns = state.settings.orientation !== 'rows';
  board.classList.toggle('columns', columns);
  board.classList.toggle('rows', !columns);
  board.style.setProperty('--rows', state.settings.colWrap || 4);
  board.style.setProperty('--cols', state.settings.rowWrap || 8);

  // measure from the top-left so overflow is reported on the right/bottom
  board.style.justifyContent = 'flex-start';
  board.style.alignItems = 'flex-start';

  const availW = board.clientWidth;
  const availH = board.clientHeight;

  let lo = 44, hi = 280;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    board.style.setProperty('--tile', mid + 'px');
    if (board.scrollWidth <= availW && board.scrollHeight <= availH) lo = mid;
    else hi = mid;
  }
  board.style.setProperty('--tile', Math.floor(lo) + 'px');

  // now that it fits, center the content
  board.style.justifyContent = 'center';
  board.style.alignItems = columns ? 'flex-start' : 'center';
}

/* ---------------- Drag & drop ---------------- */

function destroySortables() {
  sortables.forEach(s => s.destroy());
  sortables = [];
}

function initDnD() {
  document.querySelectorAll('.tiles').forEach(container => {
    sortables.push(Sortable.create(container, {
      group: 'metro-tiles',
      draggable: '.tile:not(.add)',  // shortcuts AND the clock can be moved
      filter: '.add',
      animation: 150,
      ghostClass: 'drag-ghost',
      chosenClass: 'drag-chosen',
      onEnd: handleDrop
    }));
  });
}

function handleDrop() {
  persistFromDOM();
  fit();
}

function persistFromDOM() {
  document.querySelectorAll('.tiles').forEach(container => {
    const gid = container.dataset.group;
    let order = 0;
    container.querySelectorAll('.tile[data-id]').forEach(el => {
      const tile = state.tiles.find(t => t.id === el.dataset.id);
      if (tile) { tile.groupId = gid; tile.order = order++; }
    });
  });
  Store.save(state);
}

/* ---------------- Group title editing ---------------- */

function startTitleEdit(el, group) {
  el.contentEditable = 'true';
  el.classList.add('editing');
  el.textContent = group.title || '';
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = async (commit) => {
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    el.classList.remove('editing');
    if (commit) {
      group.title = el.textContent.trim();
      await Store.save(state);
    }
    el.textContent = group.title || '';
    fit();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}

/* ---------------- Context menu (groups) ---------------- */

function showContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  items.forEach(it => {
    if (it.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { hideContextMenu(); it.action(); });
    menu.appendChild(b);
  });
  menu.classList.remove('hidden');
  // keep it on screen
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 6) + 'px';
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

function showGroupMenu(x, y, group, titleEl) {
  showContextMenu(x, y, [
    { label: 'Add tile', action: () => openAdd(group.id) },
    { label: 'Rename', action: () => startTitleEdit(titleEl, group) },
    { separator: true },
    { label: 'Delete group', danger: true, action: () => deleteGroup(group) }
  ]);
}

async function deleteGroup(group) {
  const count = state.tiles.filter(t => t.groupId === group.id).length;
  const name = group.title || 'untitled';
  const msg = count
    ? `Delete group "${name}" and its ${count} tile(s)?`
    : `Delete group "${name}"?`;
  if (!window.confirm(msg)) return;
  state.groups = state.groups.filter(g => g.id !== group.id);
  state.tiles = state.tiles.filter(t => t.groupId !== group.id);
  await Store.save(state);
  render();
}

/* Long-press (hold ~500ms without moving) -> callback. Cancels on move so it
   never fights drag-and-drop. */
function attachLongPress(el, cb) {
  let timer = null;
  let fired = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return; // left/touch only
    fired = false;
    cancel();
    timer = setTimeout(() => { timer = null; fired = true; cb(); }, 500);
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointermove', cancel);
  el.addEventListener('pointerleave', cancel);
  // if the long-press fired, swallow the click that would otherwise follow
  // (e.g. navigating an <a> tile)
  el.addEventListener('click', (e) => {
    if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
  });
}

/* ---------------- Live clock ---------------- */

function startClock() {
  tick();
  setInterval(tick, 1000);
}

function tick() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const weekday = now.toLocaleDateString([], { weekday: 'long' });
  const date = now.toLocaleDateString([], { day: 'numeric', month: 'long' });
  for (const c of clockEls) {
    c.time.textContent = time;
    c.weekday.textContent = weekday;
    c.date.textContent = date;
  }
}

/* ---------------- Favicon / helpers ---------------- */

function faviconURL(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url || ''; }
}

function letterFor(tile) {
  const base = (tile.title || hostnameOf(tile.url) || '?').trim();
  return base.charAt(0).toUpperCase();
}

/* ---------------- Background / darkness ---------------- */

function applyBackground() {
  document.body.style.background = state.settings.bgColor;
}

function applyDarkness() {
  const d = Math.max(0, Math.min(0.8, state.settings.darkness || 0));
  document.getElementById('dim-overlay').style.opacity = d;
}

/* ---------------- Sleep (fade to black when idle) ---------------- */

let sleepTimer = null;

function setupSleep() {
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(ev => {
    document.addEventListener(ev, resetSleep, { passive: true });
  });
  resetSleep();
}

function resetSleep() {
  hideSleep();
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  const s = state.settings.sleepSeconds || 0;
  if (s > 0) sleepTimer = setTimeout(showSleep, s * 1000);
}

function showSleep() { document.getElementById('sleep-overlay').classList.add('on'); }
function hideSleep() { document.getElementById('sleep-overlay').classList.remove('on'); }

/* ---------------- Group ops ---------------- */

async function addGroup() {
  const order = state.groups.length ? Math.max(...state.groups.map(g => g.order)) + 1 : 0;
  state.groups.push({ id: Store.uid('g'), title: 'New group', order });
  await Store.save(state);
  render();
}

// Blank slate: clears all groups/tiles, keeps settings. Leaves one empty group.
async function newMetro() {
  if (!window.confirm('Start a new empty Metro? This removes all groups and tiles.')) return;
  state.groups = [{ id: Store.uid('g'), title: '', order: 0 }];
  state.tiles = [];
  await Store.save(state);
  render();
}

/* ---------------- Export / import ----------------
 *
 * A web/extension page can't be handed an absolute OS path (e.g. C:\...\links)
 * for security reasons. The closest we can do: use the File System Access API
 * and remember the last file the user picked, so the Save/Open dialogs reopen
 * in that same folder next time. Pick your "links" folder once and it sticks.
 * Falls back to a plain download / file input where the API isn't available.
 */

const JSON_TYPES = [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];

// e.g. "2026_06_02-21_10.json" (big-to-small: year → minute)
function timestampName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}-${p(d.getHours())}_${p(d.getMinutes())}.json`;
}

async function exportJson() {
  const name = timestampName();
  const data = JSON.stringify(state, null, 2);

  if ('showSaveFilePicker' in window) {
    try {
      const startIn = (await idbGet('lastFile')) || 'documents';
      const handle = await window.showSaveFilePicker({ suggestedName: name, startIn, types: JSON_TYPES });
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
      idbSet('lastFile', handle).catch(() => {}); // remember the folder for next time
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled
      // otherwise fall through to download
    }
  }
  downloadJson(name, data);
}

function downloadJson(name, data) {
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function importJsonFlow() {
  if ('showOpenFilePicker' in window) {
    try {
      const startIn = (await idbGet('lastFile')) || 'documents';
      const [handle] = await window.showOpenFilePicker({ startIn, types: JSON_TYPES, multiple: false });
      idbSet('lastFile', handle).catch(() => {});
      await applyImport(await (await handle.getFile()).text());
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // fall through to the hidden <input type=file>
    }
  }
  document.getElementById('import-file').click();
}

// Fallback path: a File object from the hidden <input type=file>.
function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => applyImport(reader.result).catch(err => window.alert('Import failed: ' + err.message));
  reader.readAsText(file);
}

async function applyImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.tiles)) {
      throw new Error('Missing groups/tiles');
    }
  } catch (err) {
    window.alert('Import failed: ' + err.message);
    return;
  }
  await Store.importState(parsed);
  location.reload();
}

/* Tiny IndexedDB store for the remembered file handle (handles can't go in
   chrome.storage — they aren't JSON). */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('metro-fs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction('handles', 'readonly').objectStore('handles').get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------------- Settings panel ---------------- */

function wireSettings() {
  const panel = document.getElementById('settings-panel');
  document.getElementById('settings-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
    syncSettingsUI();
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') &&
        !panel.contains(e.target) && e.target.id !== 'settings-btn') {
      panel.classList.add('hidden');
    }
  });

  document.getElementById('layout-seg').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-layout]');
    if (!btn) return;
    state.settings.orientation = btn.dataset.layout;
    await Store.save(state);
    fit();
    syncSettingsUI();
  });

  document.getElementById('wrap-num').addEventListener('change', async (e) => {
    let n = parseInt(e.target.value, 10);
    if (!Number.isFinite(n)) return;
    n = Math.max(1, Math.min(20, n));
    e.target.value = n;
    if (state.settings.orientation === 'rows') state.settings.rowWrap = n;
    else state.settings.colWrap = n;
    await Store.save(state);
    fit();
  });

  document.getElementById('bg-color').addEventListener('input', (e) => setBackground(e.target.value));

  document.getElementById('darkness').addEventListener('input', async (e) => {
    state.settings.darkness = (parseInt(e.target.value, 10) || 0) / 100;
    applyDarkness();
    syncSettingsUI();
    await Store.save(state);
  });

  document.getElementById('sleep-num').addEventListener('change', async (e) => {
    let n = parseInt(e.target.value, 10);
    if (!Number.isFinite(n) || n < 0) n = 0;
    e.target.value = n;
    state.settings.sleepSeconds = n;
    await Store.save(state);
    resetSleep();
  });

  document.getElementById('addgroup-btn').addEventListener('click', addGroup);
  document.getElementById('export-btn').addEventListener('click', exportJson);
  document.getElementById('import-btn').addEventListener('click', importJsonFlow);
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importJson(file);
    e.target.value = ''; // allow re-importing the same file
  });

  document.getElementById('new-metro-btn').addEventListener('click', newMetro);
}

function buildSettingsPanel() {
  const wrap = document.getElementById('bg-swatches');
  wrap.innerHTML = '';
  for (const c of BG_PRESETS) {
    const sw = document.createElement('div');
    sw.className = 'bg-sw';
    sw.style.background = c;
    sw.dataset.color = c;
    sw.addEventListener('click', () => setBackground(c));
    wrap.appendChild(sw);
  }
}

async function setBackground(color) {
  state.settings.bgColor = color;
  applyBackground();
  syncSettingsUI();
  await Store.save(state);
}

function syncSettingsUI() {
  const orientation = state.settings.orientation || 'columns';
  document.querySelectorAll('#layout-seg button').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === orientation);
  });
  document.querySelectorAll('#bg-swatches .bg-sw').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === state.settings.bgColor);
  });
  document.getElementById('bg-color').value = toHex(state.settings.bgColor);

  const rows = orientation === 'rows';
  document.getElementById('wrap-label').textContent = rows ? 'Tiles per row' : 'Tiles per column';
  document.getElementById('wrap-num').value = rows ? state.settings.rowWrap : state.settings.colWrap;

  const dk = Math.round((state.settings.darkness || 0) * 100);
  document.getElementById('darkness').value = dk;
  document.getElementById('darkness-val').textContent = dk + '%';
  document.getElementById('sleep-num').value = state.settings.sleepSeconds || 0;
}

function toHex(c) {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#1f3a4d';
}

/* ---------------- Add / edit modal ---------------- */

function wireModal() {
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveModal);
  document.getElementById('modal-delete').addEventListener('click', deleteTile);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  document.getElementById('type-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (btn) setModalType(btn.dataset.type);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('modal-backdrop').classList.contains('hidden')) {
      closeModal();
    }
  });
}

function setModalType(type) {
  modalType = type;
  document.querySelectorAll('#type-seg button').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  const isShortcut = type === 'shortcut';
  document.getElementById('row-url').classList.toggle('hidden', !isShortcut);
  document.getElementById('row-title').classList.toggle('hidden', !isShortcut);
  document.getElementById('row-live').classList.toggle('hidden', isShortcut);
}

function buildColorSwatches() {
  const wrap = document.getElementById('color-swatches');
  wrap.innerHTML = '';
  for (const c of PALETTE) {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = c;
    s.dataset.color = c;
    s.addEventListener('click', () => { pickedColor = c; selectSwatch(c); });
    wrap.appendChild(s);
  }
}

function selectSwatch(c) {
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === c);
  });
}

function openAdd(groupId) {
  editingId = null;
  addGroupId = groupId;
  pickedColor = PALETTE[4];
  document.getElementById('modal-title').textContent = 'Add Tile';
  document.getElementById('type-row').classList.remove('hidden');
  document.getElementById('f-url').value = '';
  document.getElementById('f-title').value = '';
  document.getElementById('modal-delete').classList.add('hidden');
  setModalType('shortcut');
  selectSwatch(pickedColor);
  showModal();
  document.getElementById('f-url').focus();
}

function openEdit(tile) {
  editingId = tile.id;
  pickedColor = tile.color;
  document.getElementById('modal-title').textContent = 'Edit Tile';
  document.getElementById('type-row').classList.add('hidden'); // type is fixed when editing
  document.getElementById('f-url').value = tile.url || '';
  document.getElementById('f-title').value = tile.title || '';
  document.getElementById('modal-delete').classList.remove('hidden');
  setModalType(tile.type === 'clock' ? 'clock' : 'shortcut');
  selectSwatch(pickedColor);
  showModal();
}

async function saveModal() {
  if (modalType === 'clock') {
    if (editingId) {
      const t = state.tiles.find(x => x.id === editingId);
      if (t) t.color = pickedColor;
    } else {
      const order = state.tiles.filter(t => t.groupId === addGroupId).length;
      state.tiles.push({ id: Store.uid('clock'), type: 'clock', color: pickedColor, groupId: addGroupId, order });
    }
  } else {
    let url = document.getElementById('f-url').value.trim();
    const title = document.getElementById('f-title').value.trim();
    if (!url) { document.getElementById('f-url').focus(); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    if (editingId) {
      const t = state.tiles.find(x => x.id === editingId);
      if (t) { t.url = url; t.title = title; t.color = pickedColor; }
    } else {
      const order = state.tiles.filter(t => t.groupId === addGroupId).length;
      state.tiles.push({
        id: Store.uid(), type: 'shortcut', url, title,
        color: pickedColor, groupId: addGroupId, order,
        iconType: 'favicon', iconRef: null
      });
    }
  }

  await Store.save(state);
  closeModal();
  render();
}

async function deleteTile() {
  if (!editingId) return;
  state.tiles = state.tiles.filter(t => t.id !== editingId);
  await Store.save(state);
  closeModal();
  render();
}

function showModal() {
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  editingId = null;
  addGroupId = null;
}
