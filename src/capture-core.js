/*
 * ReproKit in-page recorder.
 * Runs in the page's MAIN world so it can see console calls, fetch/XHR and DOM.
 * Keeps rolling buffers of the last N minutes and hands them to bridge.js on request.
 * `rrweb` is passed in from the build wrapper (never exposed as a page global).
 */
(function (rrweb) {
  'use strict';

  var CFG = { windowMs: 2 * 60 * 1000 };
  var MAX_LOGS = 1500, MAX_NET = 600, MAX_ACTIONS = 600;
  var BODY_LIMIT = 20000;          // max chars kept per request/response body
  var ARG_LIMIT = 4000;            // max chars per console message
  var SEGMENT_EVENT_CAP = 20000;   // force a new rrweb checkpoint past this

  var pageId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var pageStartedAt = Date.now();
  var seq = 0;
  var logs = [], network = [], actions = [];
  var segments = [];

  function now() { return Date.now(); }
  function nid() { return pageId.slice(0, 6) + '-' + (++seq); }
  function safe(fn) { try { return fn(); } catch (_) { return undefined; } }
  function truncate(s, n) {
    if (s == null) return s;
    s = String(s);
    n = n || BODY_LIMIT;
    return s.length > n ? s.slice(0, n) + '\n… [truncated ' + (s.length - n) + ' chars]' : s;
  }
  function trim(arr, max) {
    var cutoff = now() - CFG.windowMs;
    var drop = 0;
    while (drop < arr.length && (arr.length - drop > max || arr[drop].t < cutoff)) drop++;
    if (drop) arr.splice(0, drop);
  }

  /* ---------------- Redaction ---------------- */
  var SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
  var SENSITIVE_KEY = /pass(word|wd)?$|passwd|secret|token|api[-_]?key|authorization|credit.?card|card.?number|cvv|cvc|ssn|private.?key/i;
  var REDACTED = '[redacted]';

  function redactHeaders(obj) {
    var out = {};
    for (var k in obj) out[k] = SENSITIVE_HEADER.test(k) ? REDACTED : obj[k];
    return out;
  }
  function redactDeep(v, depth) {
    if (depth > 8 || v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(function (x) { return redactDeep(x, depth + 1); });
    var out = {};
    for (var k in v) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactDeep(v[k], depth + 1);
    return out;
  }
  function redactBody(s) {
    if (s == null || s === '') return s;
    s = String(s);
    var t = s.trim();
    if (t[0] === '{' || t[0] === '[') {
      try { return truncate(JSON.stringify(redactDeep(JSON.parse(t), 0))); } catch (_) {}
    }
    if (/^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(t)) {
      try {
        var p = new URLSearchParams(t);
        p.forEach(function (_v, k) { if (SENSITIVE_KEY.test(k)) p.set(k, REDACTED); });
        return truncate(p.toString());
      } catch (_) {}
    }
    return truncate(s);
  }
  function redactUrl(u) {
    try {
      var url = new URL(u, location.href);
      var changed = false;
      url.searchParams.forEach(function (_v, k) { if (SENSITIVE_KEY.test(k)) { url.searchParams.set(k, 'REDACTED'); } });
      return url.href;
    } catch (_) { return String(u); }
  }

  /* ---------------- Serialization for console args ---------------- */
  function plain(v, depth, seen) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function') return 'ƒ ' + (v.name || 'anonymous') + '()';
      if (typeof v === 'bigint') return v.toString() + 'n';
      if (typeof v === 'symbol') return v.toString();
      if (v === undefined) return '[undefined]';
      return v;
    }
    if (seen.indexOf(v) !== -1) return '[Circular]';
    if (v instanceof Error) return v.name + ': ' + v.message;
    if (typeof Element !== 'undefined' && v instanceof Element) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
    if (depth >= 4) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]';
    seen.push(v);
    var out;
    if (Array.isArray(v)) {
      out = v.slice(0, 50).map(function (x) { return plain(x, depth + 1, seen); });
      if (v.length > 50) out.push('… ' + (v.length - 50) + ' more');
    } else {
      out = {};
      var keys = Object.keys(v), i = 0;
      for (; i < keys.length && i < 50; i++) {
        var k = keys[i];
        out[k] = SENSITIVE_KEY.test(k) ? REDACTED : safe(function () { return plain(v[k], depth + 1, seen); });
      }
      if (keys.length > 50) out['…'] = (keys.length - 50) + ' more keys';
    }
    seen.pop();
    return out;
  }
  function fmt(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.name + ': ' + arg.message + (arg.stack ? '\n' + arg.stack.split('\n').slice(1, 10).join('\n') : '');
    var p = safe(function () { return plain(arg, 0, []); });
    if (typeof p === 'string') return p;
    if (typeof p === 'number' || typeof p === 'boolean') return String(p);
    return safe(function () { return JSON.stringify(p, null, 2); }) || String(arg);
  }

  /* ---------------- Console ---------------- */
  function pushLog(level, args, extra) {
    var msg = '';
    for (var i = 0; i < args.length; i++) msg += (i ? ' ' : '') + fmt(args[i]);
    var entry = { id: nid(), t: now(), level: level, message: truncate(msg, ARG_LIMIT), url: redactUrl(location.href) };
    if (extra) for (var k in extra) entry[k] = extra[k];
    logs.push(entry);
    trim(logs, MAX_LOGS);
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      var args = arguments;
      safe(function () { pushLog(level, args); });
      return orig.apply(this, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    safe(function () {
      var tgt = e.target;
      if (tgt && tgt !== window && tgt.nodeType === 1) {
        var src = tgt.currentSrc || tgt.src || tgt.href || '';
        pushLog('error', ['Failed to load ' + tgt.tagName.toLowerCase() + ': ' + src], { kind: 'resource' });
        return;
      }
      var where = e.filename ? ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')' : '';
      var stack = e.error && e.error.stack ? '\n' + String(e.error.stack).split('\n').slice(1, 10).join('\n') : '';
      pushLog('error', ['Uncaught ' + (e.message || 'error') + where + stack], { kind: 'uncaught' });
    });
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    safe(function () {
      var r = e.reason;
      pushLog('error', ['Unhandled promise rejection: ' + fmt(r)], { kind: 'uncaught' });
    });
  });

  /* ---------------- Network ---------------- */
  function headersToObj(h) {
    var o = {};
    if (!h) return o;
    safe(function () {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { o[String(k).toLowerCase()] = String(v); });
      else if (Array.isArray(h)) h.forEach(function (p) { o[String(p[0]).toLowerCase()] = String(p[1]); });
      else for (var k in h) o[k.toLowerCase()] = String(h[k]);
    });
    return o;
  }
  function bodyToString(b) {
    if (b == null) return null;
    if (typeof b === 'string') return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (typeof FormData !== 'undefined' && b instanceof FormData) {
      var parts = [];
      b.forEach(function (v, k) { parts.push(k + '=' + (typeof v === 'string' ? v : '[file ' + (v.name || '') + ']')); });
      return parts.join('&');
    }
    if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + ' bytes]';
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return '[binary ' + (b.byteLength || 0) + ' bytes]';
    return '[' + Object.prototype.toString.call(b).slice(8, -1) + ']';
  }
  function isTextual(mime) {
    mime = (mime || '').toLowerCase();
    if (mime.indexOf('event-stream') !== -1) return false;
    return !mime || /json|text\/|xml|javascript|graphql|x-www-form-urlencoded/.test(mime);
  }
  function pushNet(entry) {
    network.push(entry);
    trim(network, MAX_NET);
  }
  function readLimited(res) {
    // Read at most BODY_LIMIT chars from a cloned response, then cancel (safe for big/streaming bodies).
    return new Promise(function (resolve) {
      var clone, reader, decoder = new TextDecoder(), text = '';
      try { clone = res.clone(); } catch (_) { return resolve(null); }
      if (!clone.body || !clone.body.getReader) return clone.text().then(resolve, function () { resolve(null); });
      reader = clone.body.getReader();
      function pump() {
        reader.read().then(function (r) {
          if (r.done) { text += decoder.decode(); return resolve(text); }
          text += decoder.decode(r.value, { stream: true });
          if (text.length > BODY_LIMIT) { safe(function () { reader.cancel(); }); return resolve(text); }
          pump();
        }, function () { resolve(text || null); });
      }
      pump();
    });
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    safe(function () {
      window.fetch = function (input, init) {
        var started = now(), perf = performance.now();
        var method = 'GET', url = '', reqHeaders = {}, reqBody = null;
        safe(function () {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            method = input.method; url = input.url; reqHeaders = headersToObj(input.headers);
          } else url = String(input && input.href ? input.href : input);
          if (init) {
            if (init.method) method = init.method;
            if (init.headers) { var hh = headersToObj(new Headers(init.headers)); for (var k in hh) reqHeaders[k] = hh[k]; }
            if (init.body != null) reqBody = bodyToString(init.body);
          }
        });
        var entry = {
          id: nid(), t: started, type: 'fetch', method: String(method).toUpperCase(), url: redactUrl(url),
          reqHeaders: redactHeaders(reqHeaders), reqBody: redactBody(reqBody),
          status: 0, statusText: '', resHeaders: {}, resBody: null, mimeType: '', duration: null, error: null, pending: true
        };
        pushNet(entry);
        var p = origFetch.apply(this, arguments);
        p.then(function (res) {
          safe(function () {
            entry.status = res.status; entry.statusText = res.statusText;
            entry.resHeaders = redactHeaders(headersToObj(res.headers));
            entry.mimeType = res.headers.get('content-type') || '';
            entry.duration = Math.round(performance.now() - perf);
            entry.pending = false;
            if (isTextual(entry.mimeType) && res.type !== 'opaque') {
              readLimited(res).then(function (txt) { if (txt != null) entry.resBody = redactBody(txt); });
            }
          });
        }, function (err) {
          entry.error = String((err && err.message) || err || 'Network error');
          entry.duration = Math.round(performance.now() - perf);
          entry.pending = false;
        });
        return p;
      };
    });
  }

  var XP = window.XMLHttpRequest && XMLHttpRequest.prototype;
  if (XP) {
    var xmeta = new WeakMap();
    var oOpen = XP.open, oSend = XP.send, oSet = XP.setRequestHeader;
    XP.open = function (method, url) {
      safe(function () { xmeta.set(this, { method: String(method).toUpperCase(), url: String(url), reqHeaders: {} }); }.bind(this));
      return oOpen.apply(this, arguments);
    };
    XP.setRequestHeader = function (k, v) {
      var m = xmeta.get(this);
      if (m) m.reqHeaders[String(k).toLowerCase()] = String(v);
      return oSet.apply(this, arguments);
    };
    XP.send = function (body) {
      var xhr = this, m = xmeta.get(this);
      if (m) safe(function () {
        var perf = performance.now();
        var abs = m.url; safe(function () { abs = new URL(m.url, location.href).href; });
        var entry = {
          id: nid(), t: now(), type: 'xhr', method: m.method, url: redactUrl(abs),
          reqHeaders: redactHeaders(m.reqHeaders), reqBody: redactBody(bodyToString(body)),
          status: 0, statusText: '', resHeaders: {}, resBody: null, mimeType: '', duration: null, error: null, pending: true
        };
        pushNet(entry);
        xhr.addEventListener('loadend', function () {
          safe(function () {
            entry.status = xhr.status; entry.statusText = xhr.statusText;
            entry.duration = Math.round(performance.now() - perf);
            entry.pending = false;
            var raw = xhr.getAllResponseHeaders() || '', rh = {};
            raw.trim().split(/[\r\n]+/).forEach(function (line) {
              var i = line.indexOf(':'); if (i > 0) rh[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            });
            entry.resHeaders = redactHeaders(rh);
            entry.mimeType = rh['content-type'] || '';
            if (xhr.status === 0) entry.error = 'Request failed (network error, CORS or aborted)';
            if ((xhr.responseType === '' || xhr.responseType === 'text') && isTextual(entry.mimeType)) entry.resBody = redactBody(xhr.responseText);
            else if (xhr.responseType === 'json' && xhr.response != null) entry.resBody = redactBody(JSON.stringify(xhr.response));
          });
        });
      });
      return oSend.apply(this, arguments);
    };
  }

  /* ---------------- User actions ---------------- */
  var INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[onclick],[data-testid],[data-test],[data-cy],[data-qa]';
  var TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'); }
  function looksGenerated(id) { return /\d{4,}|^[a-f0-9-]{16,}$|^(ember|react|radix|headlessui|mui|:r)/i.test(id); }
  function textOf(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
  function fieldLabel(el) {
    var l = safe(function () { return el.labels && el.labels[0] ? textOf(el.labels[0]) : ''; });
    if (l) return l;
    var by = el.getAttribute('aria-labelledby');
    if (by) { var ref = document.getElementById(by.split(' ')[0]); if (ref) return textOf(ref); }
    return '';
  }
  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r) return r;
    var tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'button' || (tag === 'input' && /^(submit|button|reset|image)$/.test(type))) return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (/^(|text|email|search|tel|url|password|number)$/.test(type)) return 'textbox';
    }
    if (tag === 'summary') return 'button';
    return null;
  }
  function nameOf(el) {
    return (el.getAttribute('aria-label') || fieldLabel(el) || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.tagName === 'INPUT' && /^(submit|button)$/i.test(el.type) ? el.value : '') || textOf(el) ||
      el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 80);
  }
  function selectorFor(el) {
    for (var i = 0; i < TESTID_ATTRS.length; i++) {
      var v = el.getAttribute(TESTID_ATTRS[i]);
      if (v) return '[' + TESTID_ATTRS[i] + '="' + v.replace(/"/g, '\\"') + '"]';
    }
    if (el.id && !looksGenerated(el.id)) return '#' + cssEsc(el.id);
    var tag = el.tagName.toLowerCase();
    var nm = el.getAttribute('name');
    if (nm && /^(input|select|textarea|button)$/.test(tag)) return tag + '[name="' + nm.replace(/"/g, '\\"') + '"]';
    var parts = [], cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 5) {
      var part = cur.tagName.toLowerCase();
      if (cur.id && !looksGenerated(cur.id)) { parts.unshift('#' + cssEsc(cur.id)); break; }
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent; depth++;
    }
    return parts.join(' > ');
  }
  function describe(el) {
    var testIdAttr = null, testId = null;
    for (var i = 0; i < TESTID_ATTRS.length; i++) {
      var v = el.getAttribute(TESTID_ATTRS[i]);
      if (v) { testIdAttr = TESTID_ATTRS[i]; testId = v; break; }
    }
    return {
      selector: safe(function () { return selectorFor(el); }) || el.tagName.toLowerCase(),
      tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el),
      fieldLabel: fieldLabel(el) || el.getAttribute('aria-label') || '',
      placeholder: el.getAttribute('placeholder') || '',
      testId: testId, testIdAttr: testIdAttr,
      inputType: el.tagName === 'INPUT' ? (el.type || 'text') : null
    };
  }
  function isSensitiveField(el) {
    var t = (el.type || '').toLowerCase();
    var hint = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label')].join(' ');
    return t === 'password' || /cc-|card|cvc|cvv|ssn|secret|token|otp|one-time/i.test(hint);
  }
  function pushAction(a) {
    a.id = nid(); a.t = now(); a.url = redactUrl(location.href);
    if (a.to) a.to = redactUrl(a.to);
    actions.push(a);
    trim(actions, MAX_ACTIONS);
  }
  function pick(target) {
    if (!target || target.nodeType !== 1) return null;
    return (target.closest && target.closest(INTERACTIVE)) || target;
  }

  document.addEventListener('click', function (e) {
    safe(function () {
      var el = pick(e.target); if (!el) return;
      if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && /^(text|email|search|tel|url|password|number)$/i.test(el.type))) return;
      var d = describe(el); d.type = 'click';
      pushAction(d);
    });
  }, true);

  document.addEventListener('input', function (e) {
    safe(function () {
      var el = e.target;
      if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) return;
      if (el.tagName === 'INPUT' && /^(checkbox|radio|file|range|color)$/i.test(el.type)) return;
      var masked = isSensitiveField(el);
      var value = masked ? '' : truncate(el.isContentEditable ? el.textContent : el.value, 300);
      var last = actions[actions.length - 1];
      var d = describe(el);
      if (last && last.type === 'input' && last.selector === d.selector) { last.value = value; last.masked = masked; last.t = now(); return; }
      d.type = 'input'; d.value = value; d.masked = masked;
      pushAction(d);
    });
  }, true);

  document.addEventListener('change', function (e) {
    safe(function () {
      var el = e.target; if (!el || el.nodeType !== 1) return;
      var d = describe(el);
      if (el.tagName === 'SELECT') {
        var opt = el.options[el.selectedIndex];
        d.type = 'select'; d.value = opt ? (opt.label || opt.text) : el.value; d.optionValue = el.value;
      } else if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) {
        d.type = 'check'; d.checked = !!el.checked;
      } else if (el.tagName === 'INPUT' && el.type === 'file') {
        d.type = 'upload'; d.value = Array.prototype.map.call(el.files || [], function (f) { return f.name; }).join(', ');
      } else return;
      pushAction(d);
    });
  }, true);

  document.addEventListener('keydown', function (e) {
    safe(function () {
      if (!/^(Enter|Escape|Tab)$/.test(e.key) || e.isComposing) return;
      if (e.key === 'Tab') return; // too noisy for repro steps
      var el = e.target && e.target.nodeType === 1 ? e.target : document.body;
      var d = describe(el); d.type = 'key'; d.key = e.key;
      pushAction(d);
    });
  }, true);

  function navAction(how) { safe(function () { pushAction({ type: 'navigate', how: how, to: location.href }); }); }
  ['pushState', 'replaceState'].forEach(function (fnName) {
    var orig = history[fnName];
    if (typeof orig !== 'function') return;
    history[fnName] = function () {
      var before = location.href;
      var r = orig.apply(this, arguments);
      if (location.href !== before) navAction(fnName === 'pushState' ? 'push' : 'replace');
      return r;
    };
  });
  window.addEventListener('popstate', function () { navAction('back/forward'); });
  window.addEventListener('hashchange', function () {
    var last = actions[actions.length - 1];
    if (last && last.type === 'navigate' && last.to === location.href) return;
    navAction('hash');
  });
  pushAction({ type: 'load', to: location.href });

  /* ---------------- DOM replay (rrweb) ---------------- */
  function trimSegments() {
    var cutoff = now() - CFG.windowMs;
    while (segments.length > 1 && segments[1].length && segments[1][0].timestamp <= cutoff) segments.shift();
  }
  var checkpointPending = false;
  safe(function () {
    if (!rrweb || !rrweb.record) return;
    rrweb.record({
      emit: function (ev, isCheckout) {
        if (isCheckout || !segments.length) segments.push([]);
        var seg = segments[segments.length - 1];
        seg.push(ev);
        if (isCheckout) trimSegments();
        if (seg.length > SEGMENT_EVENT_CAP && !checkpointPending) {
          checkpointPending = true;
          setTimeout(function () { checkpointPending = false; safe(function () { rrweb.record.takeFullSnapshot(true); }); }, 0);
        }
      },
      checkoutEveryNms: 30 * 1000,
      blockClass: 'reprokit-block',
      maskTextClass: 'reprokit-mask',
      maskInputOptions: { password: true },
      maskInputFn: function (text, el) { return el && isSensitiveField(el) ? '•'.repeat(Math.min(text.length, 12)) : text; },
      inlineStylesheet: true,
      collectFonts: false,
      recordCanvas: false,
      sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last' },
      slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaAuthorship: true, headMetaVerification: true }
    });
  });

  /* ---------------- Snapshot & bridge protocol ---------------- */
  function environment() {
    var nav = navigator;
    return {
      url: redactUrl(location.href), title: document.title, referrer: document.referrer ? redactUrl(document.referrer) : '',
      userAgent: nav.userAgent, language: nav.language, languages: (nav.languages || []).slice(0, 5),
      platform: (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '',
      mobile: !!(nav.userAgentData && nav.userAgentData.mobile),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      screen: { w: screen.width, h: screen.height },
      dpr: window.devicePixelRatio || 1,
      timezone: safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }) || '',
      online: nav.onLine,
      connection: nav.connection ? { type: nav.connection.effectiveType, downlink: nav.connection.downlink, rtt: nav.connection.rtt } : null,
      cookiesEnabled: nav.cookieEnabled,
      memoryGB: nav.deviceMemory || null,
      cores: nav.hardwareConcurrency || null
    };
  }
  function snapshot() {
    trim(logs, MAX_LOGS); trim(network, MAX_NET); trim(actions, MAX_ACTIONS); trimSegments();
    var events = [];
    for (var i = 0; i < segments.length; i++) events = events.concat(segments[i]);
    return {
      pageId: pageId, pageStartedAt: pageStartedAt, capturedAt: now(), windowMs: CFG.windowMs,
      env: environment(),
      logs: logs.slice(), network: network.map(function (n) { return Object.assign({}, n); }),
      actions: actions.slice(), events: events
    };
  }
  function reply(name, obj) {
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(obj) }));
  }
  document.addEventListener('__reprokit_collect', function () {
    safe(function () { reply('__reprokit_data', snapshot()); });
  });
  document.addEventListener('__reprokit_config', function (e) {
    safe(function () {
      var c = JSON.parse(e.detail);
      if (c && c.windowMs >= 15000 && c.windowMs <= 30 * 60 * 1000) CFG.windowMs = c.windowMs;
    });
  });
  window.addEventListener('pagehide', function () {
    // Hand the buffer off before a full navigation so multi-page bugs survive.
    safe(function () { reply('__reprokit_stash', snapshot()); });
  });
  document.dispatchEvent(new CustomEvent('__reprokit_ready'));
})(typeof __rkScope !== 'undefined' ? __rkScope.rrweb : null);
