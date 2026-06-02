# Metro New Tab

A Windows 8 "Modern UI" (Metro) style new tab page for Chrome: colored tiles,
titled groups, drag-and-drop, live tiles, and a layout that always fits the
screen. Plain JavaScript — no build step.

## Load it (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this folder: `c:\DEPO-1\FIXED\pl\chrome\metro`
5. Open a new tab.

> After changing files, click **↻ reload** on the extension card.
> The new tab override may need a one-time confirmation from Chrome.

## Features

- **Always fits the screen — no scrollbars.** Tile size is computed (binary
  search on real layout, so drag-and-drop stays accurate) to fit both axes.
- **Two layouts** (Settings → Layout): **Columns** (Metro, horizontal) /
  **Rows** (vertical). Recomputed on resize.
- **Wrap count** setting: how many tiles per column (Columns) or per row (Rows)
  before wrapping.
- **Example content** seeded from the reference screenshot (~40 tiles, 5 titled
  groups incl. `3.parti`).
- **Groups via right-click.** Right-click (or long-press) a group title for a
  menu: **Add tile**, **Rename**, **Delete group**. (No per-group `+` icon.)
  New groups are added from **Settings → Add new group**.
- **Drag-and-drop** (SortableJS): reorder tiles and move them between groups,
  including the live clock. Saved automatically.
- **Tiles can be URL shortcuts or live tiles.** Add tile asks which:
  - **URL** → shortcut with favicon + label
  - **Live tile** → a clock (time + weekday + date)
- **Edit / Delete** any tile (incl. the clock) — right-click or long-press it.
- Per-tile **color** from the Metro accent palette.
- **Readable labels**: dark gradient + text shadow, legible on light tiles.
- Favicons via Chrome's built-in `_favicon` API — no third-party service.

### Starts empty

The app opens **blank** by default (one untitled group, no tiles). The example
layout from the reference screenshot ships separately in **`example.json`** —
load it via Settings → **Import JSON** if you want sample content.

### Settings (bottom bar → ⚙ Settings)

- **Background** color (presets + custom)
- **Darkness** — dim the whole board by an adjustable amount (0–80%)
- **Sleep in seconds** — after N idle seconds (no mouse/keys) the screen fades
  to black; any movement wakes it. `0` disables it.
- **Add new group**
- **Export JSON / Import JSON** — back up or restore the whole layout. Exports
  are named big-to-small by date/time, e.g. `2026_06_02-21_10.json`. Uses the
  File System Access API and remembers the last file you picked, so the dialogs
  reopen in that folder next time (pick your `links` folder once). Falls back to
  a normal download / file picker where the API isn't available.
- **New Metro (blank)** — clears all groups and tiles (keeps your settings)
- The extension **version** is shown at the bottom of the panel.

> A web/extension page can't be handed an absolute OS path (e.g.
> `C:\…\links`) — the browser sandbox forbids it. "Remember the last folder" is
> the closest the platform allows.

## Data & storage

v1 stores everything in `chrome.storage.local` under one key (`metroState`).
The model is **split-ready** for cross-device sync:

- **Metadata** (url, title, color, group, order) is small → will move to
  `chrome.storage.sync` later (100 KB / 8 KB-per-item limits).
- **User-uploaded images** (base64) are large → stay in `storage.local`,
  referenced by `iconRef`. Never go into sync.
- **Favicons** aren't stored at all; fetched on demand.

`store.js` carries a `SEED_VERSION`. When it changes, the example layout is
re-seeded on next load while your **settings are kept**. New settings fields are
back-filled from defaults without a reseed. Reset anytime: Settings →
**Reset to example layout**.

## Roadmap

- **Done:** fit-to-screen, columns/rows + wrap count, titled & editable groups,
  drag-and-drop, live clock as an addable tile type, add/edit/delete, readable
  labels, background picker ✅
- **Next:** add/remove/reorder groups; more live tile types (weather, RSS)
- **Later:** JSON backup/restore, dark/focus mode, smart letter-icon generation,
  variable tile sizes, cross-device sync

## Files

| File | Purpose |
|------|---------|
| `manifest.json`   | MV3 manifest, new tab override, permissions |
| `newtab.html`     | Page shell, settings panel, add/edit modal |
| `styles.css`      | Metro look (tiles, layouts, panels) |
| `store.js`        | Storage layer + empty default seed |
| `newtab.js`       | Rendering, fit, clock, drag-drop, settings, add/edit |
| `example.json`    | Optional sample layout — load via Import JSON |
| `Sortable.min.js` | Vendored drag-and-drop library |
