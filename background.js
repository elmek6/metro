/*
 * background.js — Metro New Tab service worker
 *
 * Tracks tabs that should be discarded once they finish loading.
 * newtab.js posts { type:'discard-after-load', tabIds:[...] } via
 * chrome.runtime.sendMessage, and we watch onUpdated until each tab
 * reaches status:'complete', then immediately discard it.
 */

const pendingDiscard = new Set();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'discard-after-load') return;
  for (const id of msg.tabIds) pendingDiscard.add(id);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!pendingDiscard.has(tabId)) return;
  if (info.status !== 'complete') return;
  pendingDiscard.delete(tabId);
  chrome.tabs.discard(tabId).catch(() => {});
});
