/*
 * ReproKit bridge (isolated content-script world).
 * Talks to the in-page recorder through synchronous DOM events and to the
 * extension through chrome.runtime messaging.
 */
(() => {
  if (window.__reprokitBridge) return;
  window.__reprokitBridge = true;

  const sendConfig = (settings) => {
    const windowMs = (settings && settings.windowMs) || 120000;
    document.dispatchEvent(new CustomEvent('__reprokit_config', { detail: JSON.stringify({ windowMs }) }));
  };
  const loadConfig = () => chrome.storage.local.get('settings').then((r) => sendConfig(r.settings)).catch(() => {});
  loadConfig();
  document.addEventListener('__reprokit_ready', loadConfig);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) sendConfig(changes.settings.newValue);
  });

  // Ask the recorder for its buffer. Dispatch is synchronous, so the reply
  // arrives before dispatchEvent returns.
  function collect() {
    let data = null;
    const onData = (e) => { data = e.detail; };
    document.addEventListener('__reprokit_data', onData, { once: true });
    document.dispatchEvent(new CustomEvent('__reprokit_collect'));
    document.removeEventListener('__reprokit_data', onData);
    return data;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'reprokit:collect') {
      const data = collect();
      if (!data) sendResponse({ ok: false, error: 'not-recording' });
      else sendResponse({ ok: true, payload: data });
    } else if (msg.type === 'reprokit:ping') {
      sendResponse({ ok: true });
    }
  });

  // Before a full page navigation, hand the buffer to the background worker.
  document.addEventListener('__reprokit_stash', (e) => {
    try { chrome.runtime.sendMessage({ type: 'reprokit:stash', payload: e.detail }); } catch (_) {}
  });
})();
