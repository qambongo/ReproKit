/* ReproKit exporters: pure functions shared by the report page and the standalone HTML export. */
(function (root) {
  'use strict';

  function q(s) { return JSON.stringify(String(s == null ? '' : s)); }
  function sq(s) { return "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'"; }
  function shellQ(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  function isFailed(n) { return !!n.error || n.status >= 400; }
  function isErrorLog(l) { return l.level === 'error'; }

  function parseUA(ua) {
    ua = ua || '';
    var browser = 'Unknown browser', os = 'Unknown OS', m;
    if ((m = ua.match(/Edg\/([\d.]+)/))) browser = 'Edge ' + m[1].split('.')[0];
    else if ((m = ua.match(/OPR\/([\d.]+)/))) browser = 'Opera ' + m[1].split('.')[0];
    else if ((m = ua.match(/Firefox\/([\d.]+)/))) browser = 'Firefox ' + m[1].split('.')[0];
    else if ((m = ua.match(/Chrome\/([\d.]+)/))) browser = 'Chrome ' + m[1].split('.')[0];
    else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) browser = 'Safari ' + m[1];
    if ((m = ua.match(/Windows NT ([\d.]+)/))) os = 'Windows ' + ({ '10.0': '10/11', '6.3': '8.1', '6.1': '7' }[m[1]] || m[1]);
    else if ((m = ua.match(/Android ([\d.]+)/))) os = 'Android ' + m[1];
    else if ((m = ua.match(/(iPhone|iPad); CPU (?:iPhone )?OS ([\d_]+)/))) os = 'iOS ' + m[2].replace(/_/g, '.');
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    return { browser: browser, os: os };
  }

  function envRows(env) {
    env = env || {};
    var ua = parseUA(env.userAgent);
    var rows = [
      ['Page', env.url], ['Title', env.title], ['Browser', ua.browser], ['OS', ua.os],
      ['Viewport', env.viewport ? env.viewport.w + ' × ' + env.viewport.h : ''],
      ['Screen', env.screen ? env.screen.w + ' × ' + env.screen.h + ' @' + env.dpr + 'x' : ''],
      ['Language', env.language], ['Time zone', env.timezone],
      ['Network', env.connection ? env.connection.type + ', ' + env.connection.downlink + ' Mbps, ' + env.connection.rtt + ' ms RTT' : (env.online === false ? 'Offline' : '')],
      ['Device', [env.cores ? env.cores + ' cores' : '', env.memoryGB ? env.memoryGB + ' GB RAM' : ''].filter(Boolean).join(', ')],
      ['Referrer', env.referrer], ['User agent', env.userAgent]
    ];
    return rows.filter(function (r) { return r[1]; });
  }

  function pathOf(url) {
    try { var u = new URL(url); return u.pathname + u.search + u.hash; } catch (_) { return url; }
  }
  function shortUrl(url) {
    try { var u = new URL(url); return u.host + u.pathname; } catch (_) { return url; }
  }

  function targetName(a) {
    var n = a.fieldLabel || a.name || a.placeholder || a.testId || a.selector || 'element';
    return n.length > 60 ? n.slice(0, 57) + '…' : n;
  }
  function roleNoun(a) {
    var r = a.role;
    if (r === 'textbox') return 'field';
    if (r === 'combobox') return 'dropdown';
    if (r) return r;
    return a.tag === 'img' ? 'image' : 'element';
  }

  // past=true for the activity log ("Clicked…"), false for repro steps ("Click…").
  function describeAction(a, imperative) {
    var v = imperative ? { open: 'Go to ', nav: 'Navigate to ', click: 'Click', type: 'Type', clear: 'Clear', sel: 'Select', chk: 'Check', unchk: 'Uncheck', att: 'Attach', press: 'Press' }
                       : { open: 'Opened ', nav: 'Navigated to ', click: 'Clicked', type: 'Typed', clear: 'Cleared', sel: 'Selected', chk: 'Checked', unchk: 'Unchecked', att: 'Attached', press: 'Pressed' };
    switch (a.type) {
      case 'load': return v.open + a.to;
      case 'navigate': return v.nav + pathOf(a.to) + (a.how === 'back/forward' ? ' (back/forward)' : '');
      case 'click': return v.click + ' the "' + targetName(a) + '" ' + roleNoun(a);
      case 'input': return a.masked ? v.type + ' a hidden value in the "' + targetName(a) + '" field' :
        (a.value ? v.type + ' "' + a.value + '" in the "' + targetName(a) + '" field' : v.clear + ' the "' + targetName(a) + '" field');
      case 'select': return v.sel + ' "' + a.value + '" in the "' + targetName(a) + '" dropdown';
      case 'check': return (a.checked ? v.chk : v.unchk) + ' "' + targetName(a) + '"';
      case 'upload': return v.att + ' ' + (a.value || 'a file') + ' to "' + targetName(a) + '"';
      case 'key': return v.press + ' ' + a.key + (a.role === 'textbox' ? ' in the "' + targetName(a) + '" field' : '');
      default: return a.type;
    }
  }

  // Collapse noise: repeated navigations, navigation caused by an immediately preceding click, duplicate loads.
  function meaningfulActions(actions) {
    var out = [];
    (actions || []).forEach(function (a) {
      var prev = out[out.length - 1];
      if (a.type === 'navigate' && prev && prev.type === 'navigate' && a.t - prev.t < 1500) { out[out.length - 1] = a; return; }
      if (a.type === 'load' && prev && prev.type === 'navigate' && prev.to === a.to) { out[out.length - 1] = a; return; }
      if (a.type === 'click' && a.role === 'textbox') return;
      out.push(a);
    });
    return out;
  }

  function causedByUser(list, i) {
    var a = list[i], prev = list[i - 1];
    return prev && (prev.type === 'click' || prev.type === 'key' || prev.type === 'select') && a.t - prev.t < 3000;
  }

  function buildSteps(report) {
    var d = report.data || {}, list = meaningfulActions(d.actions);
    var lines = [];
    var start = list.length ? list[0].url : (d.env && d.env.url);
    if (!list.length || list[0].type !== 'load') lines.push('Go to ' + start);
    list.forEach(function (a, i) {
      if ((a.type === 'navigate' || a.type === 'load') && causedByUser(list, i)) {
        lines.push('→ Page went to ' + pathOf(a.to));
        return;
      }
      if (a.type === 'load') { lines.push('Go to ' + a.to); return; }
      lines.push(describeAction(a, true));
    });
    var n = 0;
    return lines.map(function (l) { return l.indexOf('→') === 0 ? '   ' + l : (++n) + '. ' + l; }).join('\n');
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    var pad = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function buildMarkdown(report) {
    var d = report.data || {}, env = d.env || {}, ua = parseUA(env.userAgent), notes = report.notes || {};
    var errors = (d.logs || []).filter(isErrorLog);
    var failed = (d.network || []).filter(isFailed);
    var out = [];
    out.push('## ' + (report.title || 'Bug report'));
    out.push('');
    out.push('**Page:** ' + env.url);
    out.push('**Environment:** ' + ua.browser + ' on ' + ua.os + ', viewport ' + (env.viewport ? env.viewport.w + '×' + env.viewport.h : '?') + ', ' + (env.language || ''));
    out.push('**Captured:** ' + fmtDate(report.createdAt) + ' (' + (env.timezone || 'local time') + ')');
    if (notes.description) {
      out.push('');
      out.push('### Description');
      out.push(notes.description);
    }
    out.push('');
    out.push('### Steps to reproduce');
    out.push(notes.steps || buildSteps(report));
    out.push('');
    out.push('### Expected result');
    out.push(notes.expected || '_Not specified_');
    out.push('');
    out.push('### Actual result');
    out.push(notes.actual || '_Not specified_');
    if (errors.length) {
      out.push('');
      out.push('### Console errors (' + errors.length + ')');
      out.push('```');
      errors.slice(-10).forEach(function (e) { out.push(e.message.split('\n').slice(0, 4).join('\n')); });
      if (errors.length > 10) out.push('… and ' + (errors.length - 10) + ' more');
      out.push('```');
    }
    if (failed.length) {
      out.push('');
      out.push('### Failed requests (' + failed.length + ')');
      out.push('| Method | URL | Status | Time |');
      out.push('|---|---|---|---|');
      failed.slice(-15).forEach(function (n) {
        out.push('| ' + n.method + ' | `' + shortUrl(n.url).replace(/\|/g, '%7C') + '` | ' + (n.error ? 'failed: ' + n.error : n.status + ' ' + (n.statusText || '')) + ' | ' + (n.duration != null ? n.duration + ' ms' : '–') + ' |');
      });
    }
    out.push('');
    out.push('_Full replay, screen recording, console and network log in the attached ReproKit report._');
    return out.join('\n');
  }

  function objToHar(o) {
    return Object.keys(o || {}).map(function (k) { return { name: k, value: String(o[k]) }; });
  }
  function buildHar(report) {
    var d = report.data || {};
    return {
      log: {
        version: '1.2',
        creator: { name: 'ReproKit', version: '1.0.0', comment: 'Sensitive headers and fields are redacted at capture time.' },
        pages: [],
        entries: (d.network || []).map(function (n) {
          var qs = [];
          try { new URL(n.url).searchParams.forEach(function (v, k) { qs.push({ name: k, value: v }); }); } catch (_) {}
          var req = {
            method: n.method, url: n.url, httpVersion: 'HTTP/1.1', cookies: [], headers: objToHar(n.reqHeaders),
            queryString: qs, headersSize: -1, bodySize: n.reqBody ? n.reqBody.length : 0
          };
          if (n.reqBody) req.postData = { mimeType: (n.reqHeaders && n.reqHeaders['content-type']) || '', text: n.reqBody };
          var entry = {
            startedDateTime: new Date(n.t).toISOString(), time: n.duration || 0, request: req,
            response: {
              status: n.status || 0, statusText: n.statusText || '', httpVersion: 'HTTP/1.1', cookies: [],
              headers: objToHar(n.resHeaders), redirectURL: '', headersSize: -1, bodySize: -1,
              content: { size: n.resBody ? n.resBody.length : 0, mimeType: n.mimeType || '', text: n.resBody || '' }
            },
            cache: {}, timings: { send: 0, wait: n.duration || 0, receive: 0 }
          };
          if (n.error) entry.response._error = n.error;
          if (n.pending) entry.comment = 'Request was still pending when the bug was captured';
          return entry;
        })
      }
    };
  }

  function buildCurl(n) {
    var parts = ['curl', shellQ(n.url)];
    if (n.method && n.method !== 'GET') parts.push('-X ' + n.method);
    Object.keys(n.reqHeaders || {}).forEach(function (k) {
      var v = n.reqHeaders[k];
      parts.push('-H ' + shellQ(k + ': ' + (v === '[redacted]' ? '<' + k.toUpperCase() + '>' : v)));
    });
    if (n.reqBody && !/^\[(binary|Blob)/.test(n.reqBody)) parts.push('--data-raw ' + shellQ(n.reqBody));
    return parts.join(' \\\n  ');
  }

  /* ---------- Playwright ---------- */
  function locatorFor(a) {
    if (a.testId) {
      return a.testIdAttr === 'data-testid' ? 'page.getByTestId(' + sq(a.testId) + ')' : 'page.locator(' + sq('[' + a.testIdAttr + '="' + a.testId + '"]') + ')';
    }
    var nameable = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'option'];
    if (a.role && nameable.indexOf(a.role) !== -1 && a.name) return 'page.getByRole(' + sq(a.role) + ', { name: ' + sq(a.name) + ' })';
    if ((a.role === 'textbox' || a.role === 'combobox') && a.fieldLabel) return 'page.getByLabel(' + sq(a.fieldLabel) + ')';
    if (a.role === 'textbox' && a.placeholder) return 'page.getByPlaceholder(' + sq(a.placeholder) + ')';
    return 'page.locator(' + sq(a.selector) + ')';
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

  function buildPlaywright(report) {
    var d = report.data || {}, list = meaningfulActions(d.actions), env = d.env || {};
    var errors = (d.logs || []).filter(isErrorLog);
    var failed = (d.network || []).filter(isFailed);
    var title = report.title || 'Bug reproduction';
    var L = [];
    L.push("import { test, expect } from '@playwright/test';");
    L.push('');
    L.push('// Generated by ReproKit from a bug captured ' + fmtDate(report.createdAt) + '.');
    L.push('// Review selectors and fill in hidden values before committing.');
    L.push('test(' + sq(title) + ', async ({ page }) => {');
    if (env.viewport) L.push('  await page.setViewportSize({ width: ' + env.viewport.w + ', height: ' + env.viewport.h + ' });');
    L.push('  const consoleErrors: string[] = [];');
    L.push('  const failedRequests: string[] = [];');
    L.push("  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });");
    L.push("  page.on('pageerror', (err) => consoleErrors.push(err.message));");
    var watched = [];
    failed.forEach(function (n) {
      var key = n.method + ' ' + (function () { try { return new URL(n.url).pathname; } catch (_) { return n.url; } })();
      if (watched.indexOf(key) === -1) watched.push(key);
    });
    L.push('  // Requests that failed in the original session, plus any server error.');
    L.push('  const watched = ' + JSON.stringify(watched) + ';');
    L.push("  page.on('response', (res) => {");
    L.push("    const key = `${res.request().method()} ${new URL(res.url()).pathname}`;");
    L.push('    if (res.status() >= 500 || (watched.includes(key) && res.status() >= 400)) failedRequests.push(`${res.status()} ${key}`);');
    L.push('  });');
    L.push('');
    var start = list.length ? (list[0].type === 'load' ? list[0].to : list[0].url) : env.url;
    L.push('  await page.goto(' + sq(start) + ');');
    list.forEach(function (a, i) {
      if (i === 0 && a.type === 'load') return;
      var loc = a.type === 'navigate' || a.type === 'load' ? '' : locatorFor(a);
      switch (a.type) {
        case 'load':
        case 'navigate':
          if (causedByUser(list, i)) L.push('  await expect(page).toHaveURL(/' + escapeRegex(pathOf(a.to).split('?')[0]) + '/);');
          else if (a.how === 'back/forward') L.push('  await page.goBack();');
          else L.push('  await page.goto(' + sq(a.to) + ');');
          break;
        case 'click': L.push('  await ' + loc + '.click();'); break;
        case 'input':
          if (a.masked) L.push('  await ' + loc + ".fill(process.env.REPRO_SECRET ?? ''); // value was hidden at capture");
          else L.push('  await ' + loc + '.fill(' + sq(a.value) + ');');
          break;
        case 'select': L.push('  await ' + loc + '.selectOption(' + sq(a.optionValue != null ? a.optionValue : a.value) + ');'); break;
        case 'check': L.push('  await ' + loc + (a.checked ? '.check();' : '.uncheck();')); break;
        case 'upload': L.push('  // await ' + loc + ".setInputFiles('path/to/" + (a.value || 'file') + "');"); break;
        case 'key':
          if (a.role === 'textbox' || a.role === 'combobox') L.push('  await ' + loc + '.press(' + sq(a.key) + ');');
          else L.push('  await page.keyboard.press(' + sq(a.key) + ');');
          break;
      }
    });
    L.push('');
    L.push("  await page.waitForLoadState('networkidle');");
    if (errors.length || failed.length) {
      L.push('  // In the original session:');
      errors.slice(-5).forEach(function (e) { L.push('  //   console error: ' + e.message.split('\n')[0].slice(0, 140)); });
      failed.slice(-5).forEach(function (n) { L.push('  //   ' + n.method + ' ' + pathOf(n.url).slice(0, 100) + ' → ' + (n.error || n.status)); });
    }
    if (report.notes && report.notes.expected) {
      L.push('  // Expected: ' + report.notes.expected.replace(/\n/g, ' ').slice(0, 200));
      L.push('  // TODO: assert the expected result here.');
    }
    L.push("  expect(consoleErrors, 'console errors').toEqual([]);");
    L.push("  expect(failedRequests, 'failed requests').toEqual([]);");
    L.push('});');
    L.push('');
    return L.join('\n');
  }

  function slug(s) {
    return String(s || 'bug').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'bug';
  }

  var api = {
    parseUA: parseUA, envRows: envRows, describeAction: describeAction, meaningfulActions: meaningfulActions,
    buildSteps: buildSteps, buildMarkdown: buildMarkdown, buildHar: buildHar, buildCurl: buildCurl,
    buildPlaywright: buildPlaywright, isFailed: isFailed, isErrorLog: isErrorLog, shortUrl: shortUrl,
    pathOf: pathOf, slug: slug, fmtDate: fmtDate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ReproExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
