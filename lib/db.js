/* Tiny IndexedDB wrapper shared by the background worker, popup and report page. */
var ReproDB = (function () {
  var NAME = 'reprokit', VERSION = 1, dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('reports')) db.createObjectStore('reports', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('stash')) db.createObjectStore('stash', { keyPath: 'tabId' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }
  function run(store, mode, op) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, mode);
        var req = op(tx.objectStore(store));
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
      });
    });
  }
  return {
    get: function (store, key) { return run(store, 'readonly', function (s) { return s.get(key); }); },
    getAll: function (store) { return run(store, 'readonly', function (s) { return s.getAll(); }); },
    put: function (store, value) { return run(store, 'readwrite', function (s) { return s.put(value); }); },
    del: function (store, key) { return run(store, 'readwrite', function (s) { return s.delete(key); }); },
    summarize: function (report) {
      var d = report.data || {};
      return {
        id: report.id, title: report.title, url: (d.env && d.env.url) || '', createdAt: report.createdAt,
        errors: (d.logs || []).filter(function (l) { return l.level === 'error'; }).length,
        failed: (d.network || []).filter(function (n) { return n.error || n.status >= 400; }).length
      };
    },
    saveReport: function (report) {
      var self = this;
      return self.put('reports', report).then(function () { return self.put('summaries', self.summarize(report)); });
    },
    deleteReport: function (id) {
      var self = this;
      return self.del('reports', id).then(function () { return self.del('summaries', id); });
    }
  };
})();
