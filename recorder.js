(async function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var sourceUrl = params.get('url') || '';
  var sourceTitle = params.get('title') || '';
  var titleInput = $('title');
  var descriptionInput = $('description');
  var preview = $('preview');
  var status = $('status');
  var startButton = $('start');
  var stopButton = $('stop');
  var screenshotButton = $('screenshot');
  var stream = null;
  var mediaRecorder = null;
  var chunks = [];
  var screenshot = null;
  var startedAt = 0;
  var stopped = false;

  titleInput.value = sourceTitle ? 'Screen recording: ' + sourceTitle : 'Screen recording';
  document.title = 'Record screen · ReproKit';

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle('error', !!isError);
  }

  function uniqueId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function toDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read the recording.')); };
      reader.readAsDataURL(blob);
    });
  }

  screenshotButton.addEventListener('click', function () {
    if (!stream || !preview.videoWidth || !preview.videoHeight) {
      setStatus('The screen preview is not ready for a screenshot yet.', true);
      return;
    }
    var canvas = document.createElement('canvas');
    canvas.width = preview.videoWidth;
    canvas.height = preview.videoHeight;
    canvas.getContext('2d').drawImage(preview, 0, 0);
    screenshot = canvas.toDataURL('image/png');
    setStatus('Screenshot saved with this recording.');
  });

  startButton.addEventListener('click', async function () {
    startButton.disabled = true;
    setStatus('Waiting for screen selection…');
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false
      });
      preview.srcObject = stream;
      preview.hidden = false;
      await preview.play();
      var options = {};
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) options.mimeType = 'video/webm;codecs=vp9';
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) options.mimeType = 'video/webm;codecs=vp8';
      mediaRecorder = new MediaRecorder(stream, options);
      chunks = [];
      mediaRecorder.addEventListener('dataavailable', function (event) {
        if (event.data && event.data.size) chunks.push(event.data);
      });
      mediaRecorder.addEventListener('stop', saveRecording, { once: true });
      mediaRecorder.addEventListener('error', function (event) {
        setStatus('Recording failed: ' + (event.error && event.error.message || 'unknown media error'), true);
      });
      startedAt = Date.now();
      mediaRecorder.start(1000);
      stopButton.disabled = false;
      screenshotButton.disabled = false;
      setStatus('Recording. Use the browser sharing indicator or Stop and save report when finished.');
      stream.getVideoTracks()[0].addEventListener('ended', function () {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
      }, { once: true });
    } catch (error) {
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      stream = null;
      preview.srcObject = null;
      startButton.disabled = false;
      setStatus('Could not start screen recording: ' + (error && error.message || error), true);
    }
  });

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive' || stopped) return;
    stopped = true;
    stopButton.disabled = true;
    screenshotButton.disabled = true;
    setStatus('Finishing recording and saving the report…');
    mediaRecorder.stop();
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
  }

  stopButton.addEventListener('click', stopRecording);

  async function saveRecording() {
    try {
      var mimeType = mediaRecorder.mimeType || 'video/webm';
      var blob = new Blob(chunks, { type: mimeType });
      if (!blob.size) throw new Error('The recording is empty. Try recording again.');
      var dataUrl = await toDataUrl(blob);
      var createdAt = Date.now();
      var env = {
        url: sourceUrl,
        title: sourceTitle,
        userAgent: navigator.userAgent,
        viewport: { w: preview.videoWidth, h: preview.videoHeight },
        screen: { w: window.screen.width, h: window.screen.height },
        dpr: window.devicePixelRatio || 1,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        referrer: '',
        online: navigator.onLine
      };
      var report = {
        id: uniqueId(),
        createdAt: createdAt,
        title: titleInput.value.trim() || 'Screen recording',
        description: descriptionInput.value.trim(),
        screenshot: screenshot,
        shapes: [],
        annotated: null,
        notes: { description: descriptionInput.value.trim(), steps: '', expected: '', actual: '' },
        video: {
          dataUrl: dataUrl,
          mimeType: mimeType,
          durationMs: Math.max(0, createdAt - startedAt),
          width: preview.videoWidth,
          height: preview.videoHeight
        },
        data: {
          env: env,
          capturedAt: createdAt,
          windowMs: 0,
          pages: sourceUrl ? [{ pageId: sourceUrl, url: sourceUrl, startedAt: startedAt }] : [],
          logs: [],
          network: [],
          actions: [],
          events: []
        }
      };
      await ReproDB.saveReport(report);
      var link = $('openReport');
      link.href = chrome.runtime.getURL('report.html?id=' + report.id);
      link.textContent = 'Open report';
      link.hidden = false;
      link.addEventListener('click', function (event) {
        event.preventDefault();
        chrome.tabs.create({ url: link.href });
      });
      setStatus('Report saved. Download the self-contained HTML report there to share it with your developers.');
      preview.srcObject = null;
      preview.src = dataUrl;
      preview.controls = true;
      preview.muted = false;
    } catch (error) {
      setStatus('Could not save the recording: ' + (error && error.message || error), true);
      startButton.disabled = false;
      stopped = false;
    }
  }

})();
