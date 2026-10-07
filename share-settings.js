(async function () {
  'use strict';
  var form = document.getElementById('settings');
  var status = document.getElementById('status');
  var projectUrl = document.getElementById('projectUrl');
  var anonKey = document.getElementById('anonKey');
  var expirySeconds = document.getElementById('expirySeconds');
  var saved = (await chrome.storage.local.get('shareConfig')).shareConfig || {};

  projectUrl.value = saved.projectUrl || '';
  anonKey.value = saved.anonKey || '';
  expirySeconds.value = String(saved.expirySeconds || 604800);

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var url;
    try { url = new URL(projectUrl.value.trim()); } catch (_) {
      status.textContent = 'Enter a valid Supabase project URL.';
      return;
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      status.textContent = 'Use a valid HTTPS Supabase project URL.';
      return;
    }
    var key = anonKey.value.trim();
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && !/^eyJ[A-Za-z0-9._-]+$/.test(key)) {
      status.textContent = 'Enter the project publishable/anon key, not a service_role key.';
      return;
    }
    try {
      await chrome.storage.local.set({
        shareConfig: {
          projectUrl: url.origin,
          anonKey: key,
          bucket: 'reprokit-reports',
          expirySeconds: Number(expirySeconds.value)
        }
      });
      status.textContent = 'Share settings saved in this browser.';
    } catch (error) {
      status.textContent = 'Could not save settings: ' + error.message;
    }
  });

  document.getElementById('copySql').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(document.getElementById('sql').textContent);
      status.textContent = 'Setup SQL copied to clipboard.';
    } catch (error) {
      status.textContent = 'Could not copy SQL: ' + error.message;
    }
  });
})();
