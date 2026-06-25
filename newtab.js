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
let tvView = 'active';     // Tab Vault view: 'active' | 'archive' | 'recent' | 'double'
const TV_CAP = 30;         // max lists kept per view (active / archive)

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
  wireTabVault();
  wireTabSearch();
  render();
  renderTabVault();
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
/* ---------------- Tab Vault ---------------- */

function wireTabVault() {
  const vault = document.getElementById('tabvault');

  // Click the side tab to open/close. Always starts closed (not persisted).
  document.getElementById('tv-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    vault.classList.toggle('open');
  });

  // Close when clicking anywhere outside the panel, or on Escape. Clicks inside
  // our own dropdown (#context-menu, e.g. Backup / This group) don't count.
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if (vault.classList.contains('open') && !vault.contains(e.target) && !menu.contains(e.target)) {
      vault.classList.remove('open');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') vault.classList.remove('open');
  });

  // Active / Archive switch.
  document.getElementById('tv-view-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    tvView = btn.dataset.view;
    syncTvViewUI();
    renderTabVault();
  });

  // Backup dropdown: copy open tabs into the active list (optionally close them).
  document.getElementById('tv-backup').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu(r.left, r.bottom, [
      { label: 'Copy all tabs', action: () => backupCurrentWindow(false) },
      { label: 'Copy all tabs & close', action: () => backupCurrentWindow(true) }
    ]);
  });

  document.getElementById('tv-search').addEventListener('input', renderTabVault);
}

function syncTvViewUI() {
  document.querySelectorAll('#tv-view-seg button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === tvView);
  });
  // "Backup" copies open tabs into Active — irrelevant in the read-only
  // Recent and Double views.
  const readOnly = tvView === 'recent' || tvView === 'double';
  document.getElementById('tv-backup').style.display = readOnly ? 'none' : '';
}

/* The capturable tabs in the current window (skips chrome://, the extension's
   own pages, and this New Tab page). */
async function capturableTabs() {
  const [allTabs, myTab] = await Promise.all([
    chrome.tabs.query({ currentWindow: true }),
    chrome.tabs.getCurrent().catch(() => null)
  ]);
  const myId = myTab ? myTab.id : -1;
  return allTabs.filter(t =>
    t.id !== myId &&
    t.url &&
    !t.url.startsWith('chrome://') &&
    !t.url.startsWith('chrome-extension://')
  );
}

// Backup the current window into a new ACTIVE list. close=true also closes the
// captured tabs (the old "snapshot" behavior). No dedup here — the user may
// intentionally back up the same window more than once.
async function backupCurrentWindow(close) {
  const [toCapture, win] = await Promise.all([
    capturableTabs(),
    chrome.windows.getCurrent().catch(() => null)
  ]);
  if (toCapture.length === 0) {
    window.alert('No capturable tabs in this window.');
    return;
  }

  const now = new Date();
  const label =
    now.toLocaleDateString([], { day: 'numeric', month: 'short' }) +
    ' · ' +
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const list = {
    id: Store.uid('tl'),
    label,
    savedAt: Date.now(),
    archived: false,
    // Remember the window's place/size so "Open in new window" can restore it
    // on the same monitor (multi-monitor setups).
    win: win ? { left: win.left, top: win.top, width: win.width, height: win.height, state: win.state } : null,
    tabs: toCapture.map(t => ({
      url: t.url,
      title: t.title || hostnameOf(t.url),
      favicon: t.favIconUrl || ''
    }))
  };

  if (!state.tabLists) state.tabLists = [];
  state.tabLists.unshift(list);
  trimLists();
  await Store.save(state);

  if (close) await chrome.tabs.remove(toCapture.map(t => t.id));
  tvView = 'active';
  syncTvViewUI();
  renderTabVault();
}

// Open a set of tabs in the CURRENT window (first active, rest discarded once
// loaded so they don't all eat memory).
async function openTabsHere(tabs) {
  if (!tabs || tabs.length === 0) return;
  await chrome.tabs.create({ url: tabs[0].url, active: true });
  const backgroundIds = [];
  for (const t of tabs.slice(1)) {
    const tab = await chrome.tabs.create({ url: t.url, active: false });
    backgroundIds.push(tab.id);
  }
  if (backgroundIds.length > 0) {
    chrome.runtime.sendMessage({ type: 'discard-after-load', tabIds: backgroundIds }).catch(() => {});
  }
}

// Open a set of tabs in a NEW window, restoring the saved position/size when we
// have one (all but the first are discarded once loaded). Chrome won't accept
// explicit bounds together with a maximized/fullscreen state, so we pick one.
async function openTabsNewWindow(tabs, win) {
  if (!tabs || tabs.length === 0) return;
  const opts = { url: tabs.map(t => t.url), focused: true };
  if (win && (win.state === 'maximized' || win.state === 'fullscreen')) {
    opts.state = win.state;
  } else if (win && Number.isFinite(win.left)) {
    opts.left = win.left; opts.top = win.top; opts.width = win.width; opts.height = win.height;
  }
  const w = await chrome.windows.create(opts);
  const bgIds = (w.tabs || []).slice(1).map(t => t.id);
  if (bgIds.length > 0) {
    chrome.runtime.sendMessage({ type: 'discard-after-load', tabIds: bgIds }).catch(() => {});
  }
}

const openInThisWindow = (list) => openTabsHere(list.tabs);
const openInNewWindow = (list) => openTabsNewWindow(list.tabs, list.win);

// Unordered set of URLs — the identity used to dedupe archive entries.
function urlKey(list) {
  return [...new Set((list.tabs || []).map(t => t.url))].sort().join('\n');
}

// Move an ACTIVE list into the archive. If an archive entry with identical
// content (same URL set) already exists, drop the incoming one and just bump
// the existing entry to the top instead of creating a duplicate.
async function archiveList(list) {
  const key = urlKey(list);
  const dup = (state.tabLists || []).find(l => l.archived && l !== list && urlKey(l) === key);
  if (dup) {
    state.tabLists = state.tabLists.filter(l => l.id !== list.id);
    dup.savedAt = Date.now();
  } else {
    list.archived = true;
    list.savedAt = Date.now();
  }
  trimLists();
  await Store.save(state);
  renderTabVault();
}

// Permanently remove a list (used from the archive view).
async function deleteTabList(id) {
  state.tabLists = (state.tabLists || []).filter(l => l.id !== id);
  await Store.save(state);
  renderTabVault();
}

// Remove the given tabs from a list (never archived). Drops the list if emptied.
async function deleteTabsFromList(list, doomed) {
  const set = new Set(doomed);
  list.tabs = list.tabs.filter(t => !set.has(t));
  if (list.tabs.length === 0) {
    state.tabLists = state.tabLists.filter(l => l.id !== list.id);
  }
  await Store.save(state);
  renderTabVault();
}

// Keep at most TV_CAP lists per view, newest (savedAt) first; oldest fall off.
function trimLists() {
  const all = state.tabLists || [];
  const active = all.filter(l => !l.archived).sort((a, b) => b.savedAt - a.savedAt).slice(0, TV_CAP);
  const archive = all.filter(l => l.archived).sort((a, b) => b.savedAt - a.savedAt).slice(0, TV_CAP);
  state.tabLists = [...active, ...archive];
}

// The dropdown shown by each list's "This group ▾" button.
function showGroupListMenu(x, y, list) {
  if (list.archived) {
    showContextMenu(x, y, [
      { label: 'Open in this window', action: () => openInThisWindow(list) },
      { label: 'Open in new window', action: () => openInNewWindow(list) },
      { separator: true },
      { label: 'Delete', danger: true, action: () => {
          if (window.confirm('Delete this archived group? This cannot be undone.')) deleteTabList(list.id);
      } }
    ]);
  } else {
    showContextMenu(x, y, [
      { label: 'Open in this window', action: async () => { await openInThisWindow(list); await archiveList(list); } },
      { label: 'Open in new window', action: async () => { await openInNewWindow(list); await archiveList(list); } },
      { separator: true },
      { label: 'Delete group', danger: true, action: () => {
          if (window.confirm('Delete this group? It will be moved to the archive.')) archiveList(list);
      } }
    ]);
  }
}

function renderTabVault() {
  const container = document.getElementById('tv-lists');
  const searchVal = document.getElementById('tv-search').value.trim().toLowerCase();

  if (tvView === 'recent') { renderRecent(container, searchVal); return; }
  if (tvView === 'double') { renderDouble(container, searchVal); return; }

  const lists = (state.tabLists || [])
    .filter(l => !!l.archived === (tvView === 'archive'))
    .sort((a, b) => b.savedAt - a.savedAt);

  container.innerHTML = '';

  const groups = lists
    .map(list => ({
      list,
      tabs: searchVal
        ? list.tabs.filter(t =>
            (t.title || '').toLowerCase().includes(searchVal) ||
            (t.url || '').toLowerCase().includes(searchVal))
        : list.tabs
    }))
    .filter(g => !searchVal || g.tabs.length > 0);

  if (groups.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'tv-empty';
    msg.textContent = searchVal
      ? 'No matches'
      : (tvView === 'archive' ? 'Archive is empty.' : 'No saved tab lists yet.');
    container.appendChild(msg);
    return;
  }

  for (const { list, tabs } of groups) {
    const sec = document.createElement('div');
    sec.className = 'tvl' + (list.archived ? ' archived' : '');

    const hdr = document.createElement('div');
    hdr.className = 'tvl-header';

    const lbl = document.createElement('span');
    lbl.className = 'tvl-label';
    lbl.textContent = list.label;
    lbl.title = list.label;

    const cnt = document.createElement('span');
    cnt.className = 'tvl-count';
    cnt.textContent = list.tabs.length + ' tabs';

    const grp = document.createElement('button');
    grp.className = 'tvl-group';
    grp.textContent = 'This group ▾';
    grp.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showGroupListMenu(r.left, r.bottom, list);
    });

    hdr.append(lbl, cnt, grp);

    const tabsEl = document.createElement('div');
    tabsEl.className = 'tvl-tabs';

    // checkbox <-> tab pairs, so the footer buttons act on the current selection
    const rows = [];
    for (const t of tabs) {
      const row = document.createElement('label');
      row.className = 'tvl-tab';
      row.title = t.title + '\n' + t.url;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tvl-tab-cb';
      cb.addEventListener('change', updateFooter);

      const img = document.createElement('img');
      img.src = faviconURL(t.url, 16);
      img.alt = '';
      img.addEventListener('error', () => img.remove());

      const title = document.createElement('span');
      title.className = 'tvl-tab-title';
      title.textContent = t.title || hostnameOf(t.url);

      row.append(cb, img, title);
      tabsEl.appendChild(row);
      rows.push({ cb, tab: t });
    }

    // Footer: bulk open / delete for the checked tabs in this group.
    const foot = document.createElement('div');
    foot.className = 'tvl-actions';

    const openSel = document.createElement('button');
    openSel.className = 'tvl-act';
    openSel.textContent = 'Open selected';
    openSel.addEventListener('click', () => {
      const sel = rows.filter(r => r.cb.checked).map(r => r.tab);
      if (sel.length > 0) openTabsHere(sel);
    });

    const delSel = document.createElement('button');
    delSel.className = 'tvl-act danger';
    delSel.textContent = 'Delete selected';
    delSel.addEventListener('click', () => {
      const sel = rows.filter(r => r.cb.checked).map(r => r.tab);
      if (sel.length === 0) return;
      if (sel.length > 1 && !window.confirm(`Delete ${sel.length} selected tabs?`)) return;
      deleteTabsFromList(list, sel);
    });

    foot.append(openSel, delSel);

    function updateFooter() {
      const any = rows.some(r => r.cb.checked);
      foot.classList.toggle('on', any);
    }

    sec.append(hdr, tabsEl, foot);
    container.appendChild(sec);
  }
}

/* Recent = Chrome's recently-closed tabs. Meant for quickly finding and
 * reopening something you just closed — click a row to restore it. The search
 * box filters this view too. */
async function renderRecent(container, searchVal) {
  container.innerHTML = '';

  let sessions = [];
  try { sessions = await chrome.sessions.getRecentlyClosed(); } catch (_) {}

  // Flatten closed single tabs and the tabs inside closed windows into one
  // newest-first list. Restore a tab by its own sessionId when present, else
  // fall back to the parent window's sessionId.
  const items = [];
  for (const s of sessions) {
    if (s.tab) {
      items.push({ tab: s.tab, sessionId: s.tab.sessionId });
    } else if (s.window && s.window.tabs) {
      for (const t of s.window.tabs) {
        items.push({ tab: t, sessionId: t.sessionId || s.window.sessionId });
      }
    }
  }

  const filtered = searchVal
    ? items.filter(({ tab }) =>
        (tab.title || '').toLowerCase().includes(searchVal) ||
        (tab.url || '').toLowerCase().includes(searchVal))
    : items;

  // The view may have changed while we awaited the sessions query.
  if (tvView !== 'recent') return;

  if (filtered.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'tv-empty';
    msg.textContent = searchVal ? 'No matches' : 'No recently closed tabs.';
    container.appendChild(msg);
    return;
  }

  const sec = document.createElement('div');
  sec.className = 'tvl';

  const tabsEl = document.createElement('div');
  tabsEl.className = 'tvl-tabs';
  tabsEl.style.maxHeight = 'none';   // let the whole panel scroll

  for (const { tab, sessionId } of filtered) {
    const row = document.createElement('div');
    row.className = 'tvl-tab';
    row.title = (tab.title || '') + '\n' + (tab.url || '');

    const img = document.createElement('img');
    img.src = tab.favIconUrl || faviconURL(tab.url, 16);
    img.alt = '';
    img.addEventListener('error', () => img.remove());

    const title = document.createElement('span');
    title.className = 'tvl-tab-title';
    title.textContent = tab.title || hostnameOf(tab.url);

    row.append(img, title);
    row.addEventListener('click', () => restoreClosed(sessionId));
    tabsEl.appendChild(row);
  }

  sec.appendChild(tabsEl);
  container.appendChild(sec);
}

// Reopen a recently-closed tab/window. Chrome drops it from the list once
// restored, so re-render to reflect that.
async function restoreClosed(sessionId) {
  if (!sessionId) return;
  try { await chrome.sessions.restore(sessionId); } catch (_) {}
  renderTabVault();
}

/* Double = duplicate open tabs. Scans every open tab in ALL windows, groups the
 * ones that share the exact same URL, and shows only the groups with more than
 * one copy. Click a row to jump to that specific tab (activating it and
 * focusing its window); the × closes just that copy. chrome://, edge://,
 * about: and extension pages are skipped so multiple New Tab pages don't read
 * as "duplicates". The search box filters by title or URL. */
async function renderDouble(container, searchVal) {
  container.innerHTML = '';

  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) {}

  // The view may have changed while we awaited the query.
  if (tvView !== 'double') return;

  const isInternal = (url) =>
    !url ||
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('chrome-extension://');

  // Stable per-window numbering so identical copies stay tellable apart.
  const winIds = [...new Set(tabs.map(t => t.windowId))].sort((a, b) => a - b);
  const winNum = new Map(winIds.map((id, i) => [id, i + 1]));

  // Group by exact URL.
  const byUrl = new Map();
  for (const t of tabs) {
    if (isInternal(t.url)) continue;
    if (!byUrl.has(t.url)) byUrl.set(t.url, []);
    byUrl.get(t.url).push(t);
  }

  // Keep only the URLs open more than once, most-duplicated first.
  let groups = [...byUrl.entries()]
    .filter(([, ts]) => ts.length >= 2)
    .map(([url, ts]) => ({ url, tabs: ts }));

  if (searchVal) {
    groups = groups.filter(g =>
      g.url.toLowerCase().includes(searchVal) ||
      g.tabs.some(t => (t.title || '').toLowerCase().includes(searchVal)));
  }

  groups.sort((a, b) => b.tabs.length - a.tabs.length);

  if (groups.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'tv-empty';
    msg.textContent = searchVal ? 'No matches' : 'No duplicate tabs open.';
    container.appendChild(msg);
    return;
  }

  for (const g of groups) {
    const sec = document.createElement('div');
    sec.className = 'tvl';

    const hdr = document.createElement('div');
    hdr.className = 'tvl-header';

    const lbl = document.createElement('span');
    lbl.className = 'tvl-label';
    lbl.textContent = g.url;                              // show the URL on screen
    lbl.title = g.tabs[0].title || hostnameOf(g.url);     // hover → page/site name

    const cnt = document.createElement('span');
    cnt.className = 'tvl-count';
    cnt.textContent = g.tabs.length + ' copies';

    hdr.append(lbl, cnt);

    const tabsEl = document.createElement('div');
    tabsEl.className = 'tvl-tabs';

    for (const t of g.tabs) {
      const row = document.createElement('div');
      row.className = 'tvl-tab';
      row.title = (t.title || '') + '\n' + (t.url || '');

      const img = document.createElement('img');
      img.src = t.favIconUrl || faviconURL(t.url, 16);
      img.alt = '';
      img.addEventListener('error', () => img.remove());

      const title = document.createElement('span');
      title.className = 'tvl-tab-title';
      title.textContent = t.title || hostnameOf(t.url);

      const win = document.createElement('span');
      win.className = 'tvl-tab-win';
      win.textContent = 'win ' + (winNum.get(t.windowId) || '?');

      const close = document.createElement('button');
      close.className = 'tvl-tab-close';
      close.textContent = '×';
      close.title = 'Close this tab';
      close.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await chrome.tabs.remove(t.id); } catch (_) {}
        // Drop ONLY the clicked copy — leave the rest of the group in place.
        row.remove();
        const left = tabsEl.querySelectorAll('.tvl-tab').length;
        cnt.textContent = left + (left === 1 ? ' copy' : ' copies');
        if (left === 0) sec.remove();
      });

      row.append(img, title, win, close);
      // Click jumps to that tab and tints the row so you can tell which copies
      // you've already opened.
      row.addEventListener('click', () => { focusTab(t); row.classList.add('opened'); });
      tabsEl.appendChild(row);
    }

    sec.append(hdr, tabsEl);
    container.appendChild(sec);
  }
}

// Jump to an already-open tab: activate it and focus its window.
async function focusTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
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

/* ---------------- Open-tab search (footer) ----------------
 *
 * Searches every open tab in every window (title + URL). Clicking a result
 * focuses that window and activates the tab. Each result shows the full title
 * (wrapped) and the full URL.
 */

const TS_CAP = 12;             // max results shown
let tsResults = [];            // current result tabs, in displayed order
let tsActive = -1;             // keyboard-highlighted index
let myTabId = -1;              // this New Tab page's own tab (excluded)

function wireTabSearch() {
  const input = document.getElementById('tabsearch-input');

  chrome.tabs.getCurrent().then(t => { if (t) myTabId = t.id; }).catch(() => {});

  input.addEventListener('input', runTabSearch);
  input.addEventListener('focus', () => { if (input.value.trim()) runTabSearch(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { clearTabSearch(); input.blur(); return; }
    if (tsResults.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveTsActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveTsActive(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const tab = tsResults[tsActive] || tsResults[0];
      if (tab) activateTab(tab);
    }
  });

  // Hide on outside click / blur (delayed so a result click still lands).
  document.addEventListener('click', (e) => {
    if (!document.getElementById('tabsearch').contains(e.target)) hideTsResults();
  });
  input.addEventListener('blur', () => setTimeout(hideTsResults, 150));
}

async function runTabSearch() {
  const q = document.getElementById('tabsearch-input').value.trim().toLowerCase();
  if (!q) { hideTsResults(); return; }

  const tabs = await chrome.tabs.query({});
  tsResults = tabs
    .filter(t => t.id !== myTabId && t.url && !t.url.startsWith('chrome://newtab'))
    .filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.url || '').toLowerCase().includes(q))
    .slice(0, TS_CAP);
  tsActive = tsResults.length ? 0 : -1;
  renderTsResults();
}

function renderTsResults() {
  const box = document.getElementById('tabsearch-results');
  box.innerHTML = '';
  box.classList.remove('hidden');

  if (tsResults.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ts-empty';
    empty.textContent = 'No open tabs match';
    box.appendChild(empty);
    return;
  }

  tsResults.forEach((tab, i) => {
    const row = document.createElement('div');
    row.className = 'ts-row' + (i === tsActive ? ' active' : '');

    const img = document.createElement('img');
    img.src = tab.favIconUrl || faviconURL(tab.url, 16);
    img.alt = '';
    img.addEventListener('error', () => { img.src = faviconURL(tab.url, 16); }, { once: true });

    const text = document.createElement('div');
    text.className = 'ts-text';
    const title = document.createElement('span');
    title.className = 'ts-title';
    title.textContent = tab.title || hostnameOf(tab.url);
    const url = document.createElement('span');
    url.className = 'ts-url';
    url.textContent = tab.url;
    text.append(title, url);

    row.append(img, text);
    row.addEventListener('click', () => activateTab(tab));
    row.addEventListener('mouseenter', () => { tsActive = i; highlightTsActive(); });
    box.appendChild(row);
  });
}

function moveTsActive(delta) {
  if (tsResults.length === 0) return;
  tsActive = (tsActive + delta + tsResults.length) % tsResults.length;
  highlightTsActive();
  const rows = document.querySelectorAll('#tabsearch-results .ts-row');
  const el = rows[tsActive];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function highlightTsActive() {
  document.querySelectorAll('#tabsearch-results .ts-row').forEach((el, i) => {
    el.classList.toggle('active', i === tsActive);
  });
}

// Focus the window and select the tab.
async function activateTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
}

function hideTsResults() {
  document.getElementById('tabsearch-results').classList.add('hidden');
}

function clearTabSearch() {
  document.getElementById('tabsearch-input').value = '';
  tsResults = [];
  tsActive = -1;
  hideTsResults();
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
