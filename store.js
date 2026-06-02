/*
 * store.js — storage layer for Metro New Tab
 *
 * v1 keeps everything in chrome.storage.local for simplicity, but the data
 * model is already "split-ready" for cross-device sync:
 *   - Tile METADATA (url, title, color, group, order, iconType, iconRef)
 *     is small and will later live in chrome.storage.sync.
 *   - User-uploaded IMAGES (base64) are large and will live in
 *     chrome.storage.local keyed by iconRef, never in sync.
 * Favicons are not stored at all — fetched on demand via Chrome's _favicon API.
 *
 * The app starts EMPTY by default (one untitled group, no tiles). Example
 * content ships separately in example.json — load it via Settings → Import JSON.
 *
 * SEED_VERSION: bump when the default state shape changes. On load, if the
 * stored seedVersion differs, the default is re-seeded while the user's settings
 * are preserved. Missing settings fields are always back-filled.
 */
const Store = (() => {
  const KEY = 'metroState';
  const SEED_VERSION = 4;

  const DEFAULT_SETTINGS = {
    bgColor: '#1f3a4d',
    orientation: 'columns', // 'columns' (horizontal) | 'rows' (vertical)
    colWrap: 4,             // columns layout: tiles stacked per column before wrapping
    rowWrap: 8,             // rows layout: tiles per row before wrapping
    darkness: 0,            // 0..0.8 — dimming overlay opacity
    sleepSeconds: 0         // 0 = off; otherwise fade to black after N idle seconds
  };

  // short unique id
  const uid = (p = 't') => p + '_' + Math.random().toString(36).slice(2, 9);

  // Empty default: a single untitled group, no tiles.
  function seed() {
    return {
      seedVersion: SEED_VERSION,
      settings: { ...DEFAULT_SETTINGS },
      groups: [{ id: uid('g'), title: '', order: 0 }],
      tiles: []
    };
  }

  async function load() {
    const got = await chrome.storage.local.get(KEY);
    let state = got && got[KEY];

    if (!state || state.seedVersion !== SEED_VERSION) {
      const fresh = seed();
      if (state && state.settings) fresh.settings = { ...fresh.settings, ...state.settings };
      state = fresh;
      await chrome.storage.local.set({ [KEY]: state });
    }

    // back-fill any newly added settings fields
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
    return state;
  }

  async function save(state) {
    await chrome.storage.local.set({ [KEY]: state });
  }

  async function reset() {
    await chrome.storage.local.remove(KEY);
  }

  // Replace the whole state from an imported object. Forces the current
  // seedVersion (so load() won't reseed over it) and back-fills settings.
  async function importState(parsed) {
    parsed.seedVersion = SEED_VERSION;
    parsed.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
    await chrome.storage.local.set({ [KEY]: parsed });
  }

  return { load, save, reset, importState, uid };
})();
