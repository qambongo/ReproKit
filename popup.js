(async () => {
  const $ = (s) => document.querySelector(s);
  const status = $('#status');
  const show = (msg) => { status.textContent = msg; status.hidden = !msg; };

  const { settings = {} } = await chrome.storage.local.get('settings');
  const windowMs = settings.windowMs || 120000;
  const setSub = (ms) => { $('#captureSub').textContent = `Saves the last ${ms / 60000} minute${ms === 60000 ? '' : 's'} of this tab`; };
  setSub(windowMs);
  const radio = document.querySelector(`input[name=win][value="${windowMs}"]`);
  if (radio) radio.checked = true;
  document.querySelectorAll('input[name=win]').forEach((r) => r.addEventListener('change', async () => {
    const ms = Number(r.value);
    await chrome.storage.local.set({ settings: { ...settings, windowMs: ms } });
    setSub(ms);
  }));

  $('#capture').addEventListener('click', async () => {
    const btn = $('#capture');
    btn.disabled = true;
    show('');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'reprokit:capture' });
      if (res && res.ok) window.close();
      else show((res && res.error) || 'Capture failed. Reload the page and try again.');
    } catch (e) {
      show('Capture failed: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#record').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const params = new URLSearchParams();
    if (tab && tab.url) params.set('url', tab.url);
    if (tab && tab.title) params.set('title', tab.title);
    await chrome.tabs.create({ url: chrome.runtime.getURL('recorder.html') + '?' + params.toString() });
    window.close();
  });

  $('#shareSettings').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('share-settings.html') });
    window.close();
  });

  const list = $('#recent');
  let items = [];
  try { items = await ReproDB.getAll('summaries'); } catch (_) {}
  items.sort((a, b) => b.createdAt - a.createdAt);
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Reports you capture show up here.';
    list.append(li);
  }
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  items.slice(0, 30).forEach((r) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = chrome.runtime.getURL('report.html?id=' + r.id);
    a.target = '_blank';
    const t = document.createElement('span'); t.className = 'r-title'; t.textContent = r.title;
    const m = document.createElement('span'); m.className = 'r-meta';
    const when = document.createElement('span'); when.textContent = fmt.format(r.createdAt);
    m.append(when);
    if (r.errors) { const e = document.createElement('span'); e.className = 'bad'; e.textContent = r.errors + ' error' + (r.errors > 1 ? 's' : ''); m.append(e); }
    if (r.failed) { const f = document.createElement('span'); f.className = 'bad'; f.textContent = r.failed + ' failed request' + (r.failed > 1 ? 's' : ''); m.append(f); }
    a.append(t, m);
    a.addEventListener('click', (ev) => { ev.preventDefault(); chrome.tabs.create({ url: a.href }); window.close(); });
    li.append(a);
    list.append(li);
  });
})();
