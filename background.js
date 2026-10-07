/* ReproKit background service worker. */
importScripts('lib/db.js');

const DEFAULT_WINDOW_MS = 120000;
const CAPTURABLE = /^https?:\/\//i;

async function getWindowMs() {
  const { settings } = await chrome.storage.local.get('settings');
  return (settings && settings.windowMs) || DEFAULT_WINDOW_MS;
}

/* Inject the recorder into tabs that were already open when the extension was installed. */
async function injectInto(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['inpage.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['bridge.js'] });
}
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(tabs.map((t) => injectInto(t.id)));
});

/* Buffers handed off right before a full page navigation, so a replay can span pages. */
async function stash(tabId, json) {
  let page;
  try { page = JSON.parse(json); } catch (_) { return; }
  const windowMs = await getWindowMs();
  const cutoff = Date.now() - windowMs;
  const existing = (await ReproDB.get('stash', tabId)) || { tabId, pages: [] };
  const pages = existing.pages.filter((p) => p.pageId !== page.pageId && p.capturedAt >= cutoff);
  pages.push(page);
  await ReproDB.put('stash', { tabId, pages: pages.slice(-3) });
}
chrome.tabs.onRemoved.addListener((tabId) => { ReproDB.del('stash', tabId).catch(() => {}); });

function mergePages(pages, windowMs) {
  pages.sort((a, b) => a.pageStartedAt - b.pageStartedAt);
  const current = pages[pages.length - 1];
  const cutoff = current.capturedAt - windowMs;
  const within = (x) => x.t >= cutoff;
  const merged = {
    env: current.env, capturedAt: current.capturedAt, windowMs,
    pages: pages.map((p) => ({ pageId: p.pageId, url: p.env.url, startedAt: p.pageStartedAt })),
    logs: [], network: [], actions: [], events: []
  };
  pages.forEach((p, i) => {
    merged.logs.push(...p.logs.filter(within));
    merged.network.push(...p.network.filter(within));
    merged.actions.push(...p.actions.filter(within));
    // Keep a previous page's replay only if its last snapshot falls in the window.
    if (i === pages.length - 1 || (p.events.length && p.events[p.events.length - 1].timestamp >= cutoff)) {
      merged.events.push(...p.events);
    }
  });
  merged.events.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

async function capture(tab) {
  if (!tab || !CAPTURABLE.test(tab.url || '')) {
    return { ok: false, error: 'ReproKit can only capture regular web pages (http or https). Browser pages and the Chrome Web Store are off-limits to extensions.' };
  }
  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    screenshot = null;
  }

  let resp = await sendToTab(tab.id, { type: 'reprokit:collect' });
  if (!resp || !resp.ok) {
    try { await injectInto(tab.id); } catch (_) {}
    return {
      ok: false,
      notRecording: true,
      error: "ReproKit wasn't recording this tab yet, so there's nothing to replay. It's recording now: reproduce the bug, then capture again."
    };
  }

  let current;
  try { current = JSON.parse(resp.payload); } catch (_) { return { ok: false, error: 'The captured data could not be read. Reload the page and try again.' }; }

  const windowMs = await getWindowMs();
  const stashed = (await ReproDB.get('stash', tab.id)) || { pages: [] };
  const pages = stashed.pages.filter((p) => p.pageId !== current.pageId).concat([current]);
  const data = mergePages(pages, windowMs);

  let host = '';
  try { host = new URL(data.env.url).host; } catch (_) {}
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const report = {
    id, createdAt: Date.now(),
    title: 'Bug on ' + (host || 'page'),
    screenshot, shapes: [], annotated: null,
    notes: { steps: '', expected: '', actual: '' },
    data
  };
  await ReproDB.saveReport(report);
  await chrome.tabs.create({ url: chrome.runtime.getURL('report.html?id=' + id), index: tab.index + 1 });
  return { ok: true, id };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'reprokit:stash' && sender.tab) {
    stash(sender.tab.id, msg.payload).catch(() => {});
    return;
  }
  if (msg.type === 'reprokit:capture') {
    (async () => {
      try { sendResponse(await capture(await activeTab())); }
      catch (e) { sendResponse({ ok: false, error: 'Capture failed: ' + (e && e.message ? e.message : e) }); }
    })();
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture') return;
  const tab = await activeTab();
  const result = await capture(tab).catch((e) => ({ ok: false, error: String(e) }));
  if (!result.ok) {
    chrome.action.setBadgeBackgroundColor({ color: '#C4321C' });
    chrome.action.setBadgeText({ text: '!', tabId: tab && tab.id });
    chrome.action.setTitle({ title: result.error, tabId: tab && tab.id });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '', tabId: tab && tab.id });
      chrome.action.setTitle({ title: 'ReproKit', tabId: tab && tab.id });
    }, 8000);
  }
});
