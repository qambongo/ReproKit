/* ReproKit report viewer. Runs as an extension page and inside exported standalone HTML files. */
(async function () {
  'use strict';
  var STANDALONE = !!window.__REPROKIT_REPORT__;
  var X = window.ReproExport;
  var app = document.getElementById('app');

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  /* ---------- Load ---------- */
  var report = null;
  if (STANDALONE) report = window.__REPROKIT_REPORT__;
  else {
    var id = new URLSearchParams(location.search).get('id');
    try { report = id ? await ReproDB.get('reports', id) : null; } catch (_) { report = null; }
  }
  if (!report) {
    app.append(h('div', { class: 'missing' },
      h('h1', { text: 'This report no longer exists' }),
      h('p', { text: 'It may have been deleted. Open the ReproKit popup to see your recent reports.' })));
    return;
  }

  var d = report.data || {};
  ['logs', 'network', 'actions', 'events'].forEach(function (k) { d[k] = (d[k] || []).slice(); });
  d.logs.sort(byT); d.network.sort(byT); d.actions.sort(byT);
  d.env = d.env || {};
  report.notes = report.notes || {};
  ['description', 'steps', 'expected', 'actual'].forEach(function (key) {
    if (typeof report.notes[key] !== 'string') report.notes[key] = '';
  });
  if (!report.notes.steps) report.notes.steps = X.buildSteps(report);
  report.shapes = report.shapes || [];
  function byT(a, b) { return a.t - b.t; }

  var events = d.events;
  var hasReplay = events.length > 1 && events.some(function (e) { return e.type === 2; });
  var candidates = [d.capturedAt];
  [d.logs, d.network, d.actions].forEach(function (arr) { if (arr.length) candidates.push(arr[0].t); });
  if (hasReplay) candidates.push(events[0].timestamp);
  var rangeStart = Math.min.apply(null, candidates);
  var rangeEnd = Math.max(d.capturedAt || 0, hasReplay ? events[events.length - 1].timestamp : 0, rangeStart + 1000);
  var replayStart = hasReplay ? events[0].timestamp : rangeStart;
  var replayEnd = hasReplay ? events[events.length - 1].timestamp : rangeStart;

  function clock(t) {
    var s = Math.max(0, Math.round((t - rangeStart) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function pct(t) { return ((t - rangeStart) / (rangeEnd - rangeStart) * 100).toFixed(3) + '%'; }

  /* ---------- Utilities ---------- */
  var saveTimer = null;
  function save() {
    if (STANDALONE) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      ReproDB.saveReport(report).catch(function (e) { toast('Changes were not saved: ' + e.message); });
    }, 400);
  }
  var toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }
  function download(name, content, type) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function dataUrlToBlob(u) {
    var parts = u.split(','), mime = parts[0].match(/:(.*?);/)[1], bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      var ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch (__) {}
      ta.remove();
    }
    toast(label + ' copied to clipboard');
  }
  function prettyBody(s) {
    if (!s) return s;
    var t = String(s).trim();
    if (t[0] === '{' || t[0] === '[') { try { return JSON.stringify(JSON.parse(t), null, 2); } catch (_) {} }
    return s;
  }
  var fileBase = function () { return 'reprokit-' + X.slug(report.title); };

  /* ---------- Header ---------- */
  var ua = X.parseUA(d.env.userAgent);
  var errors = d.logs.filter(X.isErrorLog);
  var warnings = d.logs.filter(function (l) { return l.level === 'warn'; });
  var failed = d.network.filter(X.isFailed);

  var titleInput = h('input', {
    class: 'title', 'aria-label': 'Report title', spellcheck: 'true',
    oninput: function (e) { report.title = e.target.value; document.title = report.title + ' · ReproKit'; save(); }
  });
  titleInput.value = report.title;
  document.title = report.title + ' · ReproKit';

  var actionsBar = h('div', { class: 'top-actions' },
    h('button', { class: 'btn primary', onclick: function () { copy(X.buildMarkdown(report), 'Ticket text'); }, title: 'Markdown with steps, environment, errors and failed requests' }, 'Copy for ticket'),
    h('button', { class: 'btn', onclick: function () {
      var code = X.buildPlaywright(report);
      download(X.slug(report.title) + '.spec.ts', code, 'text/typescript');
      copy(code, 'Playwright test');
    }, title: 'Regression test generated from the recorded actions' }, 'Playwright test'),
    h('button', { class: 'btn', onclick: function () { download(fileBase() + '.har', JSON.stringify(X.buildHar(report), null, 2), 'application/json'); toast('HAR file downloaded'); } }, 'HAR'),
    STANDALONE ? null : h('button', { class: 'btn primary', onclick: shareReport, title: 'Upload the report and copy an expiring share link.' }, 'Share link'),
    STANDALONE ? null : h('button', { class: 'btn', onclick: exportReport, title: 'Download a self-contained report file to share offline.' }, 'Download report'),
    STANDALONE ? null : h('button', { class: 'btn danger', onclick: deleteReport }, 'Delete')
  );

  var envLine = h('div', { class: 'env-line' },
    h('a', { href: d.env.url, target: '_blank', rel: 'noopener', class: 'env-url' }, X.shortUrl(d.env.url || '')),
    h('span', { text: ua.browser + ', ' + ua.os }),
    d.env.viewport ? h('span', { text: d.env.viewport.w + ' × ' + d.env.viewport.h }) : null,
    h('span', { text: X.fmtDate(report.createdAt) }),
    h('span', { class: errors.length ? 'count bad' : 'count', text: errors.length + ' console error' + (errors.length === 1 ? '' : 's') }),
    h('span', { class: failed.length ? 'count bad' : 'count', text: failed.length + ' failed request' + (failed.length === 1 ? '' : 's') }),
    STANDALONE ? h('span', { class: 'standalone-note', text: 'Exported report: edits here are not saved' }) : null
  );

  var header = h('header', { class: 'topbar' },
    h('div', { class: 'top-row' }, h('span', { class: 'brand', text: 'ReproKit' }), titleInput, actionsBar),
    envLine);

  /* ---------- Stage: replay + screenshot ---------- */
  var replayPanel = h('div', { class: 'panel', id: 'replay-panel', role: 'tabpanel' });
  var shotPanel = h('div', { class: 'panel', id: 'shot-panel', role: 'tabpanel', hidden: true });
  var videoPanel = h('div', { class: 'panel video-panel', id: 'video-panel', role: 'tabpanel', hidden: true });
  var videoViews = [['Replay', replayPanel], ['Screenshot', shotPanel]];
  if (report.video && report.video.dataUrl) {
    var recordedVideo = h('video', {
      class: 'recorded-video', controls: true, playsinline: true, preload: 'metadata',
      src: report.video.dataUrl
    });
    videoPanel.append(recordedVideo);
    if (report.video.durationMs) {
      videoPanel.append(h('p', { class: 'video-meta', text: 'Screen recording · ' + Math.round(report.video.durationMs / 1000) + ' seconds' }));
    }
    videoViews.push(['Video', videoPanel]);
  }
  var viewTabs = h('div', { class: 'viewtabs', role: 'tablist' });
  var views = videoViews;
  var viewBtns = views.map(function (v, i) {
    var b = h('button', { role: 'tab', 'aria-selected': String(i === 0), onclick: function () { showView(i); } }, v[0]);
    viewTabs.append(b);
    return b;
  });
  var shotMounted = false;
  function showView(i) {
    views.forEach(function (v, j) { v[1].hidden = i !== j; viewBtns[j].setAttribute('aria-selected', String(i === j)); });
    if (i === 1 && !shotMounted) { shotMounted = true; mountAnnotator(shotPanel); }
    if (i === 0 && player) { try { player.triggerResize(); } catch (_) {} }
  }

  /* ---------- Timeline ---------- */
  var playhead = h('div', { class: 'tl-playhead', 'aria-hidden': 'true' });
  var overlay = h('div', { class: 'tl-overlay' }, playhead);
  if (hasReplay && replayStart > rangeStart + 500) {
    overlay.prepend(h('div', { class: 'tl-noreplay', style: { left: '0', width: pct(replayStart) }, title: 'No replay for this part (the page loaded later)' }));
  }
  d.actions.forEach(function (a) {
    if (a.type === 'navigate' || a.type === 'load') overlay.append(h('div', { class: 'tl-nav', style: { left: pct(a.t) }, title: (a.type === 'load' ? 'Page load: ' : 'Navigated: ') + X.pathOf(a.to) }));
  });

  function lane(label, items, markerClass, kind) {
    var track = h('div', { class: 'tl-track' });
    items.forEach(function (it) {
      var cls = markerClass(it);
      if (!cls) return;
      track.append(h('span', {
        class: 'tl-mark ' + cls, style: { left: pct(it.t) }, 'aria-hidden': 'true',
        title: clock(it.t) + '  ' + markerTitle(kind, it),
        onclick: function (e) { e.stopPropagation(); select(kind, it.id, true); }
      }));
    });
    return h('div', { class: 'tl-lane' }, h('span', { class: 'tl-label', text: label }), track);
  }
  function markerTitle(kind, it) {
    if (kind === 'actions') return X.describeAction(it);
    if (kind === 'console') return it.message.split('\n')[0].slice(0, 160);
    return it.method + ' ' + X.shortUrl(it.url) + ' → ' + (it.error || it.status || 'pending');
  }
  var axis = h('div', { class: 'tl-axis' });
  (function () {
    var span = (rangeEnd - rangeStart) / 1000;
    var step = span <= 40 ? 5 : span <= 90 ? 10 : span <= 200 ? 30 : 60;
    for (var s = 0; s <= span; s += step) axis.append(h('span', { style: { left: pct(rangeStart + s * 1000) }, text: clock(rangeStart + s * 1000) }));
  })();

  var tlBody = h('div', { class: 'tl-body' },
    lane('Actions', d.actions, function (a) { return a.type === 'navigate' || a.type === 'load' ? null : 'm-act'; }, 'actions'),
    lane('Console', d.logs, function (l) { return l.level === 'error' ? 'm-err' : l.level === 'warn' ? 'm-warn' : 'm-log'; }, 'console'),
    lane('Network', d.network, function (n) { return X.isFailed(n) ? 'm-fail' : 'm-net'; }, 'network'),
    overlay);
  var timeline = h('section', { class: 'timeline', 'aria-label': 'Event timeline' },
    tlBody, h('div', { class: 'tl-axis-row' }, h('span'), axis));
  tlBody.addEventListener('click', function (e) {
    var track = tlBody.querySelector('.tl-track');
    var r = track.getBoundingClientRect();
    if (e.clientX < r.left) return;
    var frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seek(rangeStart + frac * (rangeEnd - rangeStart));
  });

  /* ---------- Bug details ---------- */
  function field(label, key, rows, extra) {
    var ta = h('textarea', { rows: String(rows), id: 'f-' + key, oninput: function (e) { report.notes[key] = e.target.value; save(); } });
    ta.value = report.notes[key] || '';
    return h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', { for: 'f-' + key, text: label }), extra || null), ta);
  }
  var stepsField = field('Steps to reproduce', 'steps', 7, h('button', {
    class: 'link-btn', onclick: function () {
      report.notes.steps = X.buildSteps(report);
      document.getElementById('f-steps').value = report.notes.steps; save(); toast('Steps rebuilt from recorded actions');
    }
  }, 'Rebuild from actions'));
  var details = h('section', { class: 'details', 'aria-label': 'Bug details' },
    field('Description', 'description', 4),
    stepsField,
    h('div', { class: 'field-pair' },
      field('Expected result', 'expected', 3),
      field('Actual result', 'actual', 3)));

  var stage = h('section', { class: 'stage' }, viewTabs, replayPanel, shotPanel, videoPanel, timeline, details);

  /* ---------- Inspector ---------- */
  var tabsDef = [
    { key: 'actions', label: 'Actions', count: d.actions.length },
    { key: 'console', label: 'Console', count: d.logs.length, bad: errors.length },
    { key: 'network', label: 'Network', count: d.network.length, bad: failed.length },
    { key: 'env', label: 'Environment' }
  ];
  var current = errors.length ? 'console' : failed.length ? 'network' : 'actions';
  var insTabs = h('div', { class: 'ins-tabs', role: 'tablist' });
  var tabBtns = {};
  tabsDef.forEach(function (t) {
    var b = h('button', { role: 'tab', onclick: function () { showTab(t.key); } },
      t.label,
      t.count != null ? h('span', { class: 'tab-count', text: String(t.count) }) : null,
      t.bad ? h('span', { class: 'tab-bad', text: String(t.bad), title: t.bad + (t.key === 'console' ? ' errors' : ' failed') }) : null);
    tabBtns[t.key] = b; insTabs.append(b);
  });
  var search = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter entries', oninput: applyFilter });
  var problemsBox = h('input', { type: 'checkbox', id: 'problems', onchange: applyFilter });
  var followBox = h('input', { type: 'checkbox', id: 'follow', checked: true });
  var toolbar = h('div', { class: 'ins-toolbar' }, search,
    h('label', { class: 'chk', for: 'problems' }, problemsBox, 'Problems only'),
    h('label', { class: 'chk', for: 'follow' }, followBox, 'Follow replay'));
  var lists = {};
  var rowsByKind = { actions: [], console: [], network: [] };
  var inspector = h('aside', { class: 'inspector', 'aria-label': 'Captured data' }, insTabs, toolbar);

  function row(kind, item, cells, detailFn) {
    var r = h('div', { class: 'row', 'data-id': item.id, tabindex: '0' });
    r.append(h('span', { class: 'r-time', text: clock(item.t) }));
    append(r, cells);
    var detail = null;
    function toggle() {
      if (detailFn) {
        if (!detail) { detail = detailFn(); r.after(detail); r.classList.add('open'); }
        else { detail.remove(); detail = null; r.classList.remove('open'); }
      }
      seek(item.t);
    }
    r.addEventListener('click', toggle);
    r.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    r._open = function () { if (detailFn && !detail) toggle(); else seek(item.t); };
    rowsByKind[kind].push({ t: item.t, el: r, item: item });
    return r;
  }

  var ACT_GLYPH = { click: '●', input: '⌨', select: '▾', check: '☑', key: '↵', navigate: '↗', load: '⟳', upload: '⇪' };
  lists.actions = h('div', { class: 'list', role: 'list' },
    d.actions.length ? d.actions.map(function (a) {
      return row('actions', a, [
        h('span', { class: 'r-glyph g-' + a.type, text: ACT_GLYPH[a.type] || '•', 'aria-hidden': 'true' }),
        h('span', { class: 'r-text', text: X.describeAction(a) })
      ]);
    }) : h('p', { class: 'empty', text: 'No clicks, typing or navigation were recorded in this window.' }));

  lists.console = h('div', { class: 'list mono', role: 'list' },
    d.logs.length ? d.logs.map(function (l) {
      var first = l.message.split('\n')[0];
      var multi = l.message.length > first.length || first.length > 140;
      var r = row('console', l, [
        h('span', { class: 'lvl lvl-' + l.level, text: l.level }),
        h('span', { class: 'r-text', text: first })
      ], multi ? function () { return h('pre', { class: 'detail', text: l.message }); } : null);
      r.classList.add('c-' + l.level);
      return r;
    }) : h('p', { class: 'empty', text: 'Nothing was logged to the console in this window.' }));

  lists.network = h('div', { class: 'list', role: 'list' },
    d.network.length ? d.network.map(function (n) {
      var bad = X.isFailed(n);
      var host = ''; var path = n.url;
      try { var u = new URL(n.url); host = u.host; path = u.pathname + u.search; } catch (_) {}
      var r = row('network', n, [
        h('span', { class: 'method', text: n.method }),
        h('span', { class: 'r-text url' }, h('span', { text: path }), h('span', { class: 'host', text: ' ' + host })),
        h('span', { class: 'status' + (bad ? ' bad' : '') + (n.pending ? ' pending' : ''), text: n.error ? 'failed' : n.pending ? 'pending' : String(n.status) }),
        h('span', { class: 'dur', text: n.duration != null ? n.duration + ' ms' : '' })
      ], function () { return netDetail(n); });
      if (bad) r.classList.add('bad');
      return r;
    }) : h('p', { class: 'empty', text: 'No fetch or XHR requests were made in this window.' }));

  function kv(obj) {
    var keys = Object.keys(obj || {});
    if (!keys.length) return h('p', { class: 'muted', text: 'None' });
    return h('dl', { class: 'kv' }, keys.map(function (k) { return [h('dt', { text: k }), h('dd', { text: obj[k] })]; }));
  }
  function netDetail(n) {
    return h('div', { class: 'detail net-detail' },
      h('div', { class: 'detail-actions' },
        h('button', { class: 'btn small', onclick: function (e) { e.stopPropagation(); copy(X.buildCurl(n), 'cURL command'); } }, 'Copy as cURL'),
        n.resBody ? h('button', { class: 'btn small', onclick: function (e) { e.stopPropagation(); copy(prettyBody(n.resBody), 'Response body'); } }, 'Copy response') : null),
      h('h4', { text: 'General' }),
      kv({ URL: n.url, Method: n.method, Status: n.error ? 'Failed: ' + n.error : n.status + ' ' + (n.statusText || ''), Duration: n.duration != null ? n.duration + ' ms' : 'still pending at capture', Type: n.type, 'Content type': n.mimeType || '' }),
      h('h4', { text: 'Request headers' }), kv(n.reqHeaders),
      n.reqBody ? [h('h4', { text: 'Request body' }), h('pre', { text: prettyBody(n.reqBody) })] : null,
      h('h4', { text: 'Response headers' }), kv(n.resHeaders),
      h('h4', { text: 'Response body' }),
      n.resBody ? h('pre', { text: prettyBody(n.resBody) }) : h('p', { class: 'muted', text: n.pending ? 'Not received yet.' : 'Not captured (binary, empty, streaming or cross-origin).' }));
  }

  lists.env = h('div', { class: 'list env' },
    h('dl', { class: 'kv wide' }, X.envRows(d.env).map(function (r) { return [h('dt', { text: r[0] }), h('dd', { text: r[1] })]; })),
    d.pages && d.pages.length > 1 ? [h('h4', { text: 'Pages in this replay' }),
      h('ol', { class: 'pages' }, d.pages.map(function (p) { return h('li', { text: p.url }); }))] : null,
    h('p', { class: 'muted note', text: 'Authorization, cookie and token values were redacted when this report was captured. Password fields are never recorded.' }));

  Object.keys(lists).forEach(function (k) { lists[k].hidden = true; inspector.append(lists[k]); });

  function showTab(key) {
    current = key;
    Object.keys(lists).forEach(function (k) { lists[k].hidden = k !== key; });
    Object.keys(tabBtns).forEach(function (k) { tabBtns[k].setAttribute('aria-selected', String(k === key)); });
    toolbar.hidden = key === 'env';
    problemsBox.parentElement.hidden = key === 'actions';
    applyFilter();
    lastIdx = -2;
    if (curAbs != null) highlight(curAbs);
  }
  function applyFilter() {
    var q = search.value.trim().toLowerCase(), problems = problemsBox.checked;
    var rows = rowsByKind[current] || [];
    rows.forEach(function (r) {
      var it = r.item, show = true;
      if (problems) {
        if (current === 'console') show = it.level === 'error' || it.level === 'warn';
        if (current === 'network') show = X.isFailed(it);
      }
      if (show && q) show = r.el.textContent.toLowerCase().indexOf(q) !== -1;
      r.el.hidden = !show;
      var next = r.el.nextElementSibling;
      if (next && next.classList.contains('detail')) next.hidden = !show;
    });
  }

  /* ---------- Sync ---------- */
  var player = null, curAbs = null, lastIdx = -2;
  function highlight(abs) {
    curAbs = abs;
    playhead.style.left = pct(Math.min(rangeEnd, Math.max(rangeStart, abs)));
    var rows = rowsByKind[current];
    if (!rows) return;
    var idx = -1;
    for (var i = 0; i < rows.length; i++) { if (rows[i].t <= abs) idx = i; else break; }
    if (idx === lastIdx) return;
    for (var j = 0; j < rows.length; j++) {
      rows[j].el.classList.toggle('past', j <= idx);
      rows[j].el.classList.toggle('now', j === idx);
    }
    lastIdx = idx;
    if (idx >= 0 && followBox.checked && !rows[idx].el.hidden && document.activeElement !== search) {
      rows[idx].el.scrollIntoView({ block: 'nearest' });
    }
  }
  function seek(abs) {
    if (player && hasReplay) {
      if (replayPanel.hidden) showView(0);
      try { player.goto(Math.max(0, Math.min(replayEnd, abs) - replayStart), false); } catch (_) {}
    }
    highlight(abs);
  }
  function select(kind, id, open) {
    showTab(kind);
    var r = (rowsByKind[kind] || []).find(function (x) { return x.item.id === id; });
    if (!r) return;
    r.el.hidden = false;
    r.el.scrollIntoView({ block: 'center' });
    r.el.classList.add('flash');
    setTimeout(function () { r.el.classList.remove('flash'); }, 1200);
    if (open) r.el._open();
  }

  /* ---------- Mount ---------- */
  app.append(header, h('main', { class: 'layout' }, stage, inspector), toastEl);
  showTab(current);

  function playerSize() {
    var w = Math.max(320, replayPanel.clientWidth);
    var vw = (d.env.viewport && d.env.viewport.w) || 1280, vh = (d.env.viewport && d.env.viewport.h) || 800;
    var hgt = Math.round(Math.max(240, Math.min(w * vh / vw, window.innerHeight * 0.58)));
    return { width: w, height: hgt };
  }
  if (hasReplay && window.rrwebPlayer) {
    try {
      var Player = window.rrwebPlayer.default || window.rrwebPlayer.Player || window.rrwebPlayer;
      var size = playerSize();
      player = new Player({
        target: replayPanel,
        props: {
          events: events, width: size.width, height: size.height, autoPlay: false, showController: true,
          skipInactive: true, speedOption: [1, 2, 4, 8], UNSAFE_replayCanvas: false,
          mouseTail: { strokeStyle: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3d3bd9' }
        }
      });
      player.addEventListener('ui-update-current-time', function (e) { highlight(replayStart + (e.payload || 0)); });
      var rt = null;
      window.addEventListener('resize', function () {
        clearTimeout(rt);
        rt = setTimeout(function () {
          if (replayPanel.hidden) return;
          try { player.$set(playerSize()); player.triggerResize(); } catch (_) {}
        }, 200);
      });
      // Start just before the first problem, if there is one.
      var firstProblem = errors.concat(failed).sort(byT)[0];
      highlight(replayStart);
      if (firstProblem) setTimeout(function () { seek(Math.max(replayStart, firstProblem.t - 3000)); }, 50);
    } catch (e) {
      replayPanel.append(h('p', { class: 'empty', text: 'The replay could not be loaded: ' + e.message }));
    }
  } else {
    replayPanel.append(h('div', { class: 'empty big' },
      h('strong', { text: 'No replay in this report' }),
      h('p', { text: 'ReproKit starts recording when a page loads. If the tab was open before the extension was installed, reload it, reproduce the bug and capture again.' })));
    showView(report.video && report.video.dataUrl ? 2 : report.screenshot ? 1 : 0);
  }

  /* ---------- Screenshot annotator ---------- */
  function mountAnnotator(panel) {
    if (!report.screenshot) {
      panel.append(h('p', { class: 'empty big', text: 'No screenshot was taken for this report.' }));
      return;
    }
    var COLOR = '#ff2d55';
    var tool = 'rect';
    var canvas = h('canvas', { class: 'shot-canvas', 'aria-label': 'Screenshot. Drag to annotate.' });
    var ctx = canvas.getContext('2d');
    var img = new Image();
    var lw = 3, drawing = null;
    var toolBtns = {};
    var bar = h('div', { class: 'shot-tools', role: 'toolbar', 'aria-label': 'Annotation tools' });
    [['rect', 'Box'], ['arrow', 'Arrow'], ['pen', 'Draw'], ['blur', 'Hide']].forEach(function (t) {
      var b = h('button', { class: 'tool', 'aria-pressed': String(t[0] === tool), onclick: function () {
        tool = t[0];
        Object.keys(toolBtns).forEach(function (k) { toolBtns[k].setAttribute('aria-pressed', String(k === tool)); });
      }, title: t[0] === 'blur' ? 'Pixelate sensitive areas' : null }, t[1]);
      toolBtns[t[0]] = b; bar.append(b);
    });
    bar.append(h('span', { class: 'sep' }),
      h('button', { class: 'tool', onclick: function () { report.shapes.pop(); commit(); } }, 'Undo'),
      h('button', { class: 'tool', onclick: function () { report.shapes = []; commit(); } }, 'Clear'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: function () {
        download(fileBase() + '.png', dataUrlToBlob(report.annotated || report.screenshot), 'image/png');
      } }, 'Download image'),
      h('button', { class: 'btn small', onclick: async function () {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToBlob(report.annotated || report.screenshot) })]);
          toast('Image copied to clipboard');
        } catch (_) { toast('Your browser blocked image copying. Use Download image instead.'); }
      } }, 'Copy image'));
    panel.append(bar, h('div', { class: 'shot-wrap' }, canvas));

    function drawShape(s) {
      ctx.save();
      ctx.strokeStyle = COLOR; ctx.fillStyle = COLOR; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (s.type === 'rect') {
        ctx.strokeRect(s.x, s.y, s.w, s.h);
      } else if (s.type === 'arrow') {
        var ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), head = lw * 5;
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - head * Math.cos(ang - 0.45), s.y2 - head * Math.sin(ang - 0.45));
        ctx.lineTo(s.x2 - head * Math.cos(ang + 0.45), s.y2 - head * Math.sin(ang + 0.45));
        ctx.closePath(); ctx.fill();
      } else if (s.type === 'pen') {
        ctx.beginPath();
        s.pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        ctx.stroke();
      } else if (s.type === 'blur') {
        var x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h), w = Math.abs(s.w), hh = Math.abs(s.h);
        if (w < 2 || hh < 2) { ctx.restore(); return; }
        var block = Math.max(6, Math.round(lw * 3));
        var tmp = document.createElement('canvas');
        tmp.width = Math.max(1, Math.round(w / block)); tmp.height = Math.max(1, Math.round(hh / block));
        tmp.getContext('2d').drawImage(img, x, y, w, hh, 0, 0, tmp.width, tmp.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, hh);
      }
      ctx.restore();
    }
    function redraw(extra) {
      ctx.drawImage(img, 0, 0);
      report.shapes.forEach(drawShape);
      if (extra) drawShape(extra);
    }
    function commit() {
      redraw();
      report.annotated = report.shapes.length ? canvas.toDataURL('image/png') : null;
      save();
    }
    function pt(e) {
      var r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
    }
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      var p = pt(e);
      if (tool === 'pen') drawing = { type: 'pen', pts: [p] };
      else if (tool === 'arrow') drawing = { type: 'arrow', x1: p[0], y1: p[1], x2: p[0], y2: p[1] };
      else drawing = { type: tool, x: p[0], y: p[1], w: 0, h: 0 };
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p = pt(e);
      if (drawing.type === 'pen') drawing.pts.push(p);
      else if (drawing.type === 'arrow') { drawing.x2 = p[0]; drawing.y2 = p[1]; }
      else { drawing.w = p[0] - drawing.x; drawing.h = p[1] - drawing.y; }
      redraw(drawing);
    });
    function finish() {
      if (!drawing) return;
      var s = drawing; drawing = null;
      var big = s.type === 'pen' ? s.pts.length > 2 : s.type === 'arrow' ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 8 : Math.abs(s.w) > 4 && Math.abs(s.h) > 4;
      if (big) report.shapes.push(s);
      commit();
    }
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    img.onload = function () {
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      lw = Math.max(3, Math.round(canvas.width / 450));
      redraw();
    };
    img.src = report.screenshot;
  }

  /* ---------- Export & delete ---------- */
  async function buildStandaloneHtml() {
    var files = ['vendor/rrweb-player.css', 'theme.css', 'report.css', 'vendor/rrweb-player.js', 'lib/exporters.js', 'report.js'];
    var texts = await Promise.all(files.map(async function (f) {
      var response = await fetch(chrome.runtime.getURL(f));
      if (!response.ok) throw new Error('Could not load report asset ' + f + ' (' + response.status + ')');
      return response.text();
    }));
    var safeJS = function (s) { return s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'); };
    var safeCSS = function (s) { return s.replace(/<\/(style)/gi, '<\\/$1'); };
    var json = JSON.stringify(report).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(report.title) + ' · ReproKit</title>' +
      '<style>' + safeCSS(texts[0]) + '</style><style>' + safeCSS(texts[1]) + '</style><style>' + safeCSS(texts[2]) + '</style></head>' +
      '<body><div id="app"></div><script>window.__REPROKIT_REPORT__=' + json + ';<\/script>' +
      '<script>' + safeJS(texts[3]) + '<\/script><script>' + safeJS(texts[4]) + '<\/script><script>' + safeJS(texts[5]) + '<\/script></body></html>';
  }

  async function exportReport() {
    try {
      toast('Building report file…');
      var html = await buildStandaloneHtml();
      download(fileBase() + '.html', html, 'text/html');
      toast('Report downloaded. Send the .html file to your developers.');
    } catch (e) {
      toast('Export failed: ' + e.message);
    }
  }
  async function shareReport(event) {
    var button = event.currentTarget;
    button.disabled = true;
    try {
      var stored = await chrome.storage.local.get('shareConfig');
      var config = stored.shareConfig;
      if (!config || !config.projectUrl || !config.anonKey || !config.bucket) {
        toast('Set up link sharing first.');
        await chrome.tabs.create({ url: chrome.runtime.getURL('share-settings.html') });
        return;
      }
      toast('Building report for upload…');
      var html = await buildStandaloneHtml();
      var body = new Blob([html], { type: 'text/html' });
      if (body.size > 50 * 1024 * 1024) throw new Error('This report is larger than the 50 MB upload limit.');

      var base = config.projectUrl.replace(/\/+$/, '');
      var path = 'reports/' + report.id + '-' + X.slug(report.title) + '.html';
      var encodedPath = path.split('/').map(encodeURIComponent).join('/');
      var headers = { apikey: config.anonKey };
      if (/^eyJ/.test(config.anonKey)) headers.Authorization = 'Bearer ' + config.anonKey;
      var upload = await fetch(base + '/storage/v1/object/' + encodeURIComponent(config.bucket) + '/' + encodedPath, {
        method: 'POST',
        headers: Object.assign({}, headers, { 'Content-Type': 'text/html', 'x-upsert': 'false' }),
        body: body
      });
      if (!upload.ok) {
        var uploadError = await upload.text();
        throw new Error('Upload failed (' + upload.status + '): ' + uploadError.slice(0, 300));
      }

      var expiry = [86400, 604800, 2592000].indexOf(Number(config.expirySeconds)) !== -1 ? Number(config.expirySeconds) : 604800;
      var signed = await fetch(base + '/storage/v1/object/sign/' + encodeURIComponent(config.bucket) + '/' + encodedPath, {
        method: 'POST',
        headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: expiry })
      });
      if (!signed.ok) {
        var signError = await signed.text();
        throw new Error('The report uploaded, but a share link could not be created (' + signed.status + '): ' + signError.slice(0, 300));
      }
      var result = await signed.json();
      if (!result.signedURL) throw new Error('The storage service returned no share link.');
      var link = /^https?:\/\//i.test(result.signedURL) ? result.signedURL :
        base + (result.signedURL.indexOf('/storage/v1/') === 0 ? '' : '/storage/v1') +
        (result.signedURL.charAt(0) === '/' ? '' : '/') + result.signedURL;
      try {
        await navigator.clipboard.writeText(link);
        toast('Expiring share link copied to clipboard.');
      } catch (_) {
        window.prompt('Copy this expiring share link:', link);
        toast('Share link created. Copy it from the dialog.');
      }
    } catch (e) {
      toast('Could not create share link: ' + e.message);
    } finally {
      button.disabled = false;
    }
  }
  async function deleteReport() {
    if (!confirm('Delete this report? This cannot be undone.')) return;
    await ReproDB.deleteReport(report.id);
    app.replaceChildren(h('div', { class: 'missing' }, h('h1', { text: 'Report deleted' }), h('p', { text: 'You can close this tab.' })));
  }
})();
