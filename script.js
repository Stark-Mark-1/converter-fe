// ─────────────────────────────────────────────────────────────
// CONFIG  — update these values before deploying
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  /** Backend API base URL (no trailing slash) */
  API_BASE: 'https://converter-be-268082701906.asia-south1.run.app',

  /**
   * R2 public bucket base URL (no trailing slash).
   * Final HLS URL: {R2_PUBLIC_BASE}/streams/{videoId}/master.m3u8
   */
  R2_PUBLIC_BASE: 'https://pub-34559487076f43188d6bb330de590d69.r2.dev',

};

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let selectedFile = null;
let hlsInstance = null;

// ─────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const uploadSection = $('upload-section');
const progressSection = $('progress-section');
const resultSection = $('result-section');
const errorBar = $('error-bar');
const errorMsg = $('error-msg');
const retryBtn = $('retry-btn');

const dropZone = $('drop-zone');
const fileInput = $('file-input');
const fileInfo = $('file-info');
const fileName = $('file-name');
const fileSize = $('file-size');
const fileRemove = $('file-remove');
const uploadBtn = $('upload-btn');

const stepUpload = $('step-upload');
const stepUploadDot = $('step-upload-dot');
const uploadFill = $('upload-fill');
const uploadPct = $('upload-pct');

const stepEncode = $('step-encode');
const stepEncodeDot = $('step-encode-dot');
const encodeFill = $('encode-fill');
const encodePct = $('encode-pct');

const hlsUrlInput = $('hls-url');
const copyBtn = $('copy-btn');
const copyLabel = $('copy-label');
const videoPlayer = $('video-player');
const newBtn = $('new-btn');

// Step tracker elements
const tracker1 = $('tracker-1');
const tracker2 = $('tracker-2');
const tracker3 = $('tracker-3');
const trackerLine1 = $('tracker-line-1');
const trackerLine2 = $('tracker-line-2');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function show(el) {
  el.classList.remove('hidden');
  el.classList.add('fade-in');
  // Remove the animation class after it plays so re-showing works
  el.addEventListener('animationend', () => el.classList.remove('fade-in'), { once: true });
}
function hide(el) { el.classList.add('hidden'); }

function showError(msg) {
  errorMsg.textContent = msg;
  show(errorBar);
}
function hideError() { hide(errorBar); }

function generateVideoId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ─────────────────────────────────────────────────────────────
// Step Tracker  (1 = Select, 2 = Process, 3 = Stream)
// ─────────────────────────────────────────────────────────────
function setActiveStep(n) {
  const steps = [tracker1, tracker2, tracker3];
  const lines = [trackerLine1, trackerLine2];

  steps.forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i + 1 < n) el.classList.add('done');
    if (i + 1 === n) el.classList.add('active');
  });

  lines.forEach((el, i) => {
    el.classList.remove('filled', 'success-filled');
    if (i + 1 < n) {
      // Use success color only on the final transition
      el.classList.add(n === 3 ? 'success-filled' : 'filled');
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Processing step helpers
// ─────────────────────────────────────────────────────────────
function markProcStepDone(dotEl, itemEl) {
  dotEl.classList.add('is-done');
  dotEl.classList.remove('dimmed');
  itemEl.classList.add('is-done');
}

function activateProcStep(dotEl) {
  dotEl.classList.remove('dimmed');
}

// ─────────────────────────────────────────────────────────────
// File selection
// ─────────────────────────────────────────────────────────────
function handleFileSelect(file) {
  if (!file) return;

  const isMp4 = file.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4');
  if (!isMp4) {
    showError('Please select an MP4 file.');
    return;
  }

  hideError();
  selectedFile = file;

  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  show(fileInfo);
  show(uploadBtn);
}

function clearFile() {
  selectedFile = null;
  fileInput.value = '';
  hide(fileInfo);
  hide(uploadBtn);
}

fileInput.addEventListener('change', (e) => handleFileSelect(e.target.files[0]));
fileRemove.addEventListener('click', (e) => { e.stopPropagation(); clearFile(); });

// ── Drop Zone ──
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFileSelect(e.dataTransfer.files[0]);
});

// ─────────────────────────────────────────────────────────────
// Upload flow
// ─────────────────────────────────────────────────────────────
uploadBtn.addEventListener('click', startConversion);

async function startConversion() {
  if (!selectedFile) return;

  hideError();
  uploadBtn.disabled = true;

  hide(uploadSection);
  show(progressSection);
  setActiveStep(2);

  const videoId = generateVideoId();
  const r2Key = `uploads/${videoId}.mp4`;

  try {
    // 1. Get presigned PUT URL
    const presignedUrl = await getPresignedUrl(r2Key);

    // 2. Upload directly to R2 with progress
    await uploadToR2(presignedUrl, selectedFile, (pct) => {
      uploadFill.style.width = pct + '%';
      uploadPct.textContent = pct + '%';
    });

    uploadFill.style.width = '100%';
    uploadPct.textContent = '100%';
    markProcStepDone(stepUploadDot, stepUpload);
    activateProcStep(stepEncodeDot);

    // 3. Trigger encoding — backend is synchronous, wait for completion
    encodeFill.classList.add('indeterminate');
    encodePct.textContent = 'Encoding…';

    await triggerEncoding(videoId);

    encodeFill.classList.remove('indeterminate');
    encodeFill.style.width = '100%';
    encodePct.textContent = '100%';
    markProcStepDone(stepEncodeDot, stepEncode);

    showResult(videoId);

  } catch (err) {
    showError(err.message || 'Something went wrong. Please try again.');
    hide(progressSection);
    show(uploadSection);
    setActiveStep(1);
    uploadBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// API calls
// ─────────────────────────────────────────────────────────────

/** GET /presign?key=… → { url: "https://..." } */
async function getPresignedUrl(key) {
  const res = await fetch(`${CONFIG.API_BASE}/presign?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Failed to get upload URL (${res.status})`);
  const data = await res.json();
  if (!data.url) throw new Error('Server returned an invalid presign response');
  return data.url;
}

/** Upload directly to R2 via XHR for progress events */
function uploadToR2(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'video/mp4');

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed: network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload was cancelled')));

    xhr.send(file);
  });
}

/** POST /encode  { videoId } */
async function triggerEncoding(videoId) {
  const res = await fetch(`${CONFIG.API_BASE}/encode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId }),
  });
  const data = await res.json();
  if (!res.ok || data.status === 'error') {
    throw new Error(data.message || `Encoding failed (${res.status})`);
  }
  return data;
}


// ─────────────────────────────────────────────────────────────
// Result + Player
// ─────────────────────────────────────────────────────────────
function showResult(videoId) {
  hide(progressSection);
  show(resultSection);
  setActiveStep(3);

  const hlsUrl = `${CONFIG.R2_PUBLIC_BASE}/streams/${videoId}/master.m3u8`;
  hlsUrlInput.value = hlsUrl;

  setupPlayer(hlsUrl);
}

function setupPlayer(hlsUrl) {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  videoPlayer.src = '';

  // Safari / iOS — native HLS
  if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
    videoPlayer.src = hlsUrl;
    videoPlayer.load();
    return;
  }

  // All other browsers — hls.js
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: true, maxBufferLength: 30 });
    hlsInstance.loadSource(hlsUrl);
    hlsInstance.attachMedia(videoPlayer);

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      videoPlayer.play().catch(() => { });
    });

    hlsInstance.on(Hls.Events.ERROR, (_ev, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hlsInstance.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hlsInstance.recoverMediaError();
      else {
        hlsInstance.destroy();
        showError('Playback error. The stream may still be processing — try again shortly.');
      }
    });

    return;
  }

  showError('Your browser does not support HLS playback. Try opening the URL directly.');
}

// ─────────────────────────────────────────────────────────────
// Copy URL
// ─────────────────────────────────────────────────────────────
copyBtn.addEventListener('click', async () => {
  const url = hlsUrlInput.value;
  if (!url) return;

  try {
    await navigator.clipboard.writeText(url);
  } catch {
    hlsUrlInput.select();
    document.execCommand('copy');
  }

  copyBtn.classList.add('copied');
  copyLabel.textContent = 'Copied!';
  setTimeout(() => {
    copyBtn.classList.remove('copied');
    copyLabel.textContent = 'Copy';
  }, 2000);
});

// ─────────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────────
function resetState() {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  videoPlayer.src = '';
  hlsUrlInput.value = '';

  // Upload step
  uploadFill.style.width = '0%';
  uploadPct.textContent = '0%';
  stepUploadDot.classList.remove('is-done');
  stepUpload.classList.remove('is-done');

  // Encode step
  encodeFill.style.width = '0%';
  encodeFill.classList.add('indeterminate');
  encodePct.textContent = 'Waiting\u2026';
  stepEncodeDot.classList.remove('is-done');
  stepEncodeDot.classList.add('dimmed');
  stepEncode.classList.remove('is-done');

  // File state
  selectedFile = null;
  fileInput.value = '';
  uploadBtn.disabled = false;

  // Copy button
  copyBtn.classList.remove('copied');
  copyLabel.textContent = 'Copy';

  hide(fileInfo);
  hide(uploadBtn);
  hide(progressSection);
  hide(resultSection);
  hideError();
  show(uploadSection);
  setActiveStep(1);
}

retryBtn.addEventListener('click', resetState);
newBtn.addEventListener('click', resetState);

// Initialise tracker
setActiveStep(1);
