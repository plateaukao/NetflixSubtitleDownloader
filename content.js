// Content script: bridges the page-level injected script and the extension popup/storage.
// Runs in an isolated world but can communicate with the page via CustomEvents
// and with the popup via chrome.runtime messages.

const WEBVTT = 'webvtt-lssdh-ios8';
const DFXP = 'dfxp-ls-sdh';
const SIMPLE = 'simplesdh';
const IMSC1_1 = 'imsc1.1';
const ALL_FORMATS = [IMSC1_1, DFXP, WEBVTT, SIMPLE];
const ALL_FORMATS_PREFER_VTT = [WEBVTT, IMSC1_1, DFXP, SIMPLE];

const EXTENSIONS = {};
EXTENSIONS[WEBVTT] = 'vtt';
EXTENSIONS[DFXP] = 'dfxp';
EXTENSIONS[SIMPLE] = 'xml';
EXTENSIONS[IMSC1_1] = 'xml';

const SUB_TYPES = {
  'subtitles': '',
  'closedcaptions': '[cc]'
};

const STOP = 'NSD_STOP';

let subCache = {};
let titleCache = {};
let idOverrides = {};

let batchAll = null;
let batchSeason = null;
let batchToEnd = null;
let batch = null;

// --- Settings (loaded from chrome.storage) ---
let settings = {
  epTitleInFilename: false,
  forceSubs: true,
  prefLocale: '',
  langs: '',
  subFormat: WEBVTT,
  batchDelay: 0
};

chrome.storage.local.get(settings, stored => {
  Object.assign(settings, stored);
});

chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settings) settings[key] = newValue;
  }
});

// --- Inject page-level script ---
const sc = document.createElement('script');
sc.src = chrome.runtime.getURL('inject.js');
sc.onload = () => sc.remove();
(document.head || document.documentElement).appendChild(sc);

// --- UI: download menu ---
const MENU_HTML = `
<ol>
  <li class="nsd-header">Netflix Subtitle Downloader</li>
  <li class="nsd-action nsd-download">Download subs for this <span class="nsd-series">episode</span><span class="nsd-not-series">movie</span></li>
  <li class="nsd-action nsd-download-to-end nsd-series-only">Download subs from this ep to end</li>
  <li class="nsd-action nsd-download-season nsd-series-only">Download subs for this season</li>
  <li class="nsd-action nsd-download-all nsd-series-only">Download subs for all seasons</li>
  <li class="nsd-action nsd-epub-movie nsd-movie-only">Download as EPUB...</li>
  <li class="nsd-action nsd-epub-season nsd-series-only">Download EPUB for this season...</li>
  <li class="nsd-action nsd-epub-all nsd-series-only">Download EPUB for all seasons...</li>
</ol>
`;

const MENU_CSS = `
#nsd-menu {
  position: absolute;
  display: none;
  width: 320px;
  top: 0;
  left: calc(50% - 160px);
  z-index: 99999998;
  font-family: Netflix Sans, Helvetica Neue, Segoe UI, sans-serif;
}
#nsd-menu ol {
  list-style: none;
  padding: 0;
  margin: 0;
  background: #222;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}
body:hover #nsd-menu { display: block; }
#nsd-menu li { padding: 12px 16px; color: #fff; font-size: 13px; }
#nsd-menu .nsd-header { font-weight: bold; font-size: 14px; background: #e50914; }
#nsd-menu .nsd-action { cursor: pointer; display: none; }
#nsd-menu .nsd-action:hover { background: #444; }
#nsd-menu:hover .nsd-action { display: block; }
#nsd-menu:not(.nsd-is-series) .nsd-series-only { display: none !important; }
#nsd-menu.nsd-is-series .nsd-not-series { display: none; }
#nsd-menu.nsd-is-series .nsd-movie-only { display: none !important; }
#nsd-menu:not(.nsd-is-series) .nsd-movie-only { }

#nsd-progress-bars {
  position: fixed;
  top: 0; left: 0; width: 100%;
  z-index: 99999999;
}
.nsd-progress {
  height: 4px;
  width: 100%;
  background: transparent;
  cursor: pointer;
}

#nsd-epub-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  z-index: 99999999;
  display: flex;
  align-items: center;
  justify-content: center;
}
#nsd-epub-modal {
  background: #222;
  color: #fff;
  border-radius: 12px;
  padding: 24px;
  width: 340px;
  font-family: Netflix Sans, Helvetica Neue, Segoe UI, sans-serif;
  font-size: 14px;
}
#nsd-epub-modal h2 {
  margin: 0 0 16px;
  font-size: 18px;
  color: #e50914;
}
#nsd-epub-modal label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: #aaa;
}
#nsd-epub-modal select {
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 16px;
  background: #333;
  color: #fff;
  border: 1px solid #555;
  border-radius: 6px;
  font-size: 14px;
  appearance: auto;
}
#nsd-epub-modal .nsd-btn-row {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
#nsd-epub-modal button {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
}
#nsd-epub-modal .nsd-btn-primary {
  background: #e50914;
  color: #fff;
}
#nsd-epub-modal .nsd-btn-primary:hover { background: #f6121d; }
#nsd-epub-modal .nsd-btn-secondary {
  background: #444;
  color: #fff;
}
#nsd-epub-modal .nsd-btn-secondary:hover { background: #555; }
#nsd-epub-modal .nsd-status {
  margin-top: 12px;
  font-size: 12px;
  color: #aaa;
  text-align: center;
  min-height: 18px;
}
`;

function ensureMenu() {
  let menu = document.getElementById('nsd-menu');
  if (!menu) {
    const style = document.createElement('style');
    style.textContent = MENU_CSS;
    document.head.appendChild(style);

    menu = document.createElement('div');
    menu.id = 'nsd-menu';
    menu.innerHTML = MENU_HTML;
    document.body.appendChild(menu);

    menu.querySelector('.nsd-download').addEventListener('click', downloadThis);
    menu.querySelector('.nsd-download-to-end').addEventListener('click', () => downloadBatchFrom(batchToEnd));
    menu.querySelector('.nsd-download-season').addEventListener('click', () => downloadBatchFrom(batchSeason));
    menu.querySelector('.nsd-download-all').addEventListener('click', () => downloadBatchFrom(batchAll));
    menu.querySelector('.nsd-epub-movie').addEventListener('click', () => showEpubModal('movie'));
    menu.querySelector('.nsd-epub-season').addEventListener('click', () => showEpubModal('season'));
    menu.querySelector('.nsd-epub-all').addEventListener('click', () => showEpubModal('all'));
  }
  return menu;
}

// --- Progress bar ---
class ProgressBar {
  constructor(max) {
    this.current = 0;
    this.max = max;

    let container = document.getElementById('nsd-progress-bars');
    if (!container) {
      container = document.createElement('div');
      container.id = 'nsd-progress-bars';
      document.body.appendChild(container);
    }

    this.el = document.createElement('div');
    this.el.className = 'nsd-progress';
    this.el.title = 'Click to stop download';
    this.stop = new Promise(resolve => {
      this.el.addEventListener('click', () => resolve(STOP));
    });
    container.appendChild(this.el);
  }

  increment() {
    this.current++;
    const p = Math.min(100, this.current / this.max * 100);
    this.el.style.background = `linear-gradient(to right, #e50914 ${p}%, transparent ${p}%)`;
  }

  destroy() {
    this.el.remove();
  }
}

// --- Process intercepted data ---
function processSubInfo(result) {
  const tracks = result.timedtexttracks;
  const subs = {};
  for (const track of tracks) {
    if (track.isNoneTrack) continue;

    let type = SUB_TYPES[track.rawTrackType];
    if (typeof type === 'undefined') type = `[${track.rawTrackType}]`;
    const variant = track.trackVariant ? `-${track.trackVariant}` : '';
    const lang = track.language + type + variant + (track.isForcedNarrative ? '-forced' : '');

    const formats = {};
    for (const format of ALL_FORMATS) {
      const downloadables = track.ttDownloadables[format];
      if (!downloadables) continue;
      let urls;
      if (downloadables.downloadUrls) urls = Object.values(downloadables.downloadUrls);
      else if (downloadables.urls) urls = downloadables.urls.map(u => u.url);
      else continue;
      formats[format] = [urls, EXTENSIONS[format]];
    }

    if (Object.keys(formats).length > 0) {
      for (let i = 0; ; i++) {
        const key = lang + (i === 0 ? '' : `-${i}`);
        if (!subs[key]) { subs[key] = formats; break; }
      }
    }
  }
  subCache[result.movieId] = subs;
}

function processMetadata(data) {
  const menu = ensureMenu();
  menu.style.display = 'none';
  menu.classList.remove('nsd-is-series');

  const result = data.video;
  const { type, title } = result;

  if (type === 'show') {
    batchAll = [];
    batchSeason = [];
    batchToEnd = [];
    const allEps = [];
    let currentSeason = 0;
    menu.classList.add('nsd-is-series');

    for (const season of result.seasons) {
      for (const ep of season.episodes) {
        if (ep.id === result.currentEpisode) currentSeason = season.seq;
        allEps.push([season.seq, ep.seq, ep.id]);
        titleCache[ep.id] = {
          type, title,
          season: season.seq,
          episode: ep.seq,
          subtitle: ep.title,
          hiddenNumber: ep.hiddenEpisodeNumbers
        };
      }
    }

    allEps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let toEnd = false;
    for (const [season, _ep, id] of allEps) {
      batchAll.push(id);
      if (season === currentSeason) batchSeason.push(id);
      if (id === result.currentEpisode) toEnd = true;
      if (toEnd) batchToEnd.push(id);
    }
  } else if (type === 'movie' || type === 'supplemental') {
    titleCache[result.id] = { type, title };
  } else {
    return;
  }

  // Wait for sub cache to populate, then show menu
  const waitForSubs = async () => {
    while (getSubsFromCache(true) === null) await sleep(0.1);
    if (document.location.pathname.startsWith('/watch'))
      menu.style.display = '';

    // Resume ZIP batch if active
    if (batch && batch.length > 0) downloadBatch(true);

    // Resume EPUB batch if active
    if (sessionStorage.getItem('NSD_epub_batch')) {
      processEpubBatchStep();
    }
  };
  waitForSubs();
}

// --- Helpers ---
const sleep = (sec, val) => new Promise(r => setTimeout(r, sec * 1000, val));

const getVideoId = () => window.location.pathname.split('/').pop();

function getFromCache(cache, name, silent) {
  const id = getVideoId();
  if (cache[id]) return cache[id];

  const overrideId = idOverrides[id];
  if (overrideId && cache[overrideId]) return cache[overrideId];

  if (silent) return null;
  alert("Couldn't find " + name + ". Wait for the player to load, then try again.");
  throw new Error('Cache miss: ' + name);
}

const getSubsFromCache = silent => getFromCache(subCache, 'subtitles', silent);

const pad = (n, l) => `${l}${n.toString().padStart(2, '0')}`;
const safeTitle = t => t.trim().replace(/[:*?"<>|\\\/]+/g, '_').replace(/ /g, '.');

function getTitleFromCache() {
  const t = getFromCache(titleCache, 'title');
  const parts = [t.title];
  if (t.type === 'show') {
    const s = pad(t.season, 'S');
    if (t.hiddenNumber) {
      parts.push(s, t.subtitle);
    } else {
      parts.push(s + pad(t.episode, 'E'));
      if (settings.epTitleInFilename) parts.push(t.subtitle);
    }
  }
  return [safeTitle(parts.join('.')), safeTitle(t.title)];
}

function pickFormat(formats) {
  const order = settings.subFormat === DFXP ? ALL_FORMATS : ALL_FORMATS_PREFER_VTT;
  for (const f of order) {
    if (formats[f]) return formats[f];
  }
}

function popRandom(arr) {
  return arr.splice(Math.random() * arr.length | 0, 1)[0];
}

// --- Download logic ---
async function downloadSubs(zip) {
  const subs = getSubsFromCache();
  const [title, seriesTitle] = getTitleFromCache();

  let filteredLangs;
  if (!settings.langs) {
    filteredLangs = Object.keys(subs);
  } else {
    const re = new RegExp(
      '^(' + settings.langs
        .replace(/\[/g, '\\[').replace(/\]/g, '\\]')
        .replace(/-/g, '\\-').replace(/\s/g, '')
        .replace(/,/g, '|') + ')'
    );
    filteredLangs = Object.keys(subs).filter(l => l.match(re));
  }

  const progress = new ProgressBar(filteredLangs.length);
  let stop = false;

  for (const lang of filteredLangs) {
    const [urls, ext] = pickFormat(subs[lang]);
    while (urls.length > 0) {
      const url = popRandom(urls);
      let result;
      try {
        result = await Promise.race([
          fetch(url, { mode: 'cors' }),
          progress.stop,
          sleep(30, STOP)
        ]);
      } catch (_) {
        result = STOP;
      }
      if (result === STOP) { stop = true; break; }
      progress.increment();
      const data = await result.text();
      if (data.length > 0) {
        zip.file(`${title}.WEBRip.Netflix.${lang}.${ext}`, data);
        break;
      }
    }
    if (stop) break;
  }

  if (await Promise.race([progress.stop, {}]) === STOP) stop = true;
  progress.destroy();
  return [seriesTitle, stop];
}

async function saveZip(zip, title) {
  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, title + '.zip');
}

async function downloadThis() {
  const zip = new JSZip();
  const [title] = await downloadSubs(zip);
  saveZip(zip, title);
}

async function downloadBatchFrom(ids) {
  batch = [...ids];
  downloadBatch(false);
}

async function downloadBatch(isResume) {
  let zip;
  if (isResume) {
    // Try to restore zip from sessionStorage
    try {
      const saved = sessionStorage.getItem('NSD_zip');
      if (saved) {
        zip = await JSZip.loadAsync(saved, { base64: true });
      } else {
        zip = new JSZip();
      }
    } catch (_) {
      zip = new JSZip();
    }
  } else {
    zip = new JSZip();
  }

  let title, stop;
  try {
    [title, stop] = await downloadSubs(zip);
  } catch (_) {
    title = 'unknown';
    stop = true;
  }

  const id = parseInt(getVideoId());
  batch = batch.filter(x => x !== id);

  if (stop || batch.length === 0) {
    saveZip(zip, title);
    batch = null;
    sessionStorage.removeItem('NSD_zip');
  } else {
    // Save zip to sessionStorage and navigate to next episode
    const b64 = await zip.generateAsync({ type: 'base64' });
    try {
      sessionStorage.setItem('NSD_zip', b64);
      sessionStorage.setItem('NSD_batch', JSON.stringify(batch));
    } catch (_) {
      // sessionStorage full — just save what we have
      saveZip(zip, title);
      batch = null;
      return;
    }
    await sleep(settings.batchDelay);
    window.location = window.location.origin + '/watch/' + batch[0];
  }
}

// ========== EPUB Modal + Download ==========

function getAvailableLangs() {
  const subs = getSubsFromCache(true);
  if (!subs) return [];
  return Object.keys(subs).filter(l => !l.endsWith('-forced')).sort();
}

// scope: 'movie' | 'season' | 'all'
function showEpubModal(scope) {
  // Remove existing modal
  const existing = document.getElementById('nsd-epub-modal-overlay');
  if (existing) existing.remove();

  const langs = getAvailableLangs();
  if (langs.length === 0) {
    alert('No subtitle tracks available yet. Wait for the player to load.');
    return;
  }

  const scopeLabel = scope === 'all' ? 'all seasons' : scope === 'season' ? 'this season' : 'this movie';
  const langOptions = langs.map(l => `<option value="${l}">${l}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.id = 'nsd-epub-modal-overlay';
  overlay.innerHTML = `
    <div id="nsd-epub-modal">
      <h2>Download EPUB — ${scopeLabel}</h2>
      <label for="nsd-main-lang">Main language</label>
      <select id="nsd-main-lang">${langOptions}</select>
      <label for="nsd-sub-lang">Second language (optional)</label>
      <select id="nsd-sub-lang"><option value="">— None —</option>${langOptions}</select>
      <div class="nsd-btn-row">
        <button class="nsd-btn-secondary" id="nsd-epub-cancel">Cancel</button>
        <button class="nsd-btn-primary" id="nsd-epub-go">Download EPUB</button>
      </div>
      <div class="nsd-status" id="nsd-epub-status"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close on overlay click (but not modal body)
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('nsd-epub-cancel').addEventListener('click', () => overlay.remove());
  document.getElementById('nsd-epub-go').addEventListener('click', () => {
    const mainLang = document.getElementById('nsd-main-lang').value;
    const subLang = document.getElementById('nsd-sub-lang').value;
    downloadAsEpub(mainLang, subLang || null, scope, overlay);
  });
}

// Start EPUB batch: save config to sessionStorage, then process current episode
async function downloadAsEpub(mainLang, subLang, scope, overlay) {
  const statusEl = document.getElementById('nsd-epub-status');
  const goBtn = document.getElementById('nsd-epub-go');
  goBtn.disabled = true;
  goBtn.textContent = 'Starting...';

  try {
    const [titleWithEp, seriesTitle] = getTitleFromCache();

    // Determine which episodes to include
    let episodeIds;
    if (scope === 'all' && batchAll) {
      episodeIds = [...batchAll];
    } else if (scope === 'season' && batchSeason) {
      episodeIds = [...batchSeason];
    } else {
      episodeIds = [parseInt(getVideoId())];
    }

    // Save EPUB batch state to sessionStorage
    const epubBatch = {
      remaining: episodeIds,
      chapters: [],
      mainLang,
      subLang: subLang || null,
      seriesTitle: seriesTitle || titleWithEp
    };
    sessionStorage.setItem('NSD_epub_batch', JSON.stringify(epubBatch));

    // Close modal and start processing
    overlay.remove();
    await processEpubBatchStep();

  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    goBtn.disabled = false;
    goBtn.textContent = 'Download EPUB';
  }
}

// Process current episode for EPUB batch, then navigate to next or finalize
async function processEpubBatchStep() {
  const raw = sessionStorage.getItem('NSD_epub_batch');
  if (!raw) return;
  const epubBatch = JSON.parse(raw);

  // Wait for current episode's subs to load
  while (getSubsFromCache(true) === null) {
    await sleep(0.5);
  }

  const currentId = parseInt(getVideoId());
  const epSubs = getSubsFromCache(true);
  const epTitle = titleCache[currentId];

  // Build chapter title
  let chapterTitle;
  if (epTitle && epTitle.type === 'show') {
    chapterTitle = `Season ${epTitle.season} Episode ${epTitle.episode}`;
  } else {
    chapterTitle = `Episode ${epubBatch.chapters.length + 1}`;
  }

  // Fetch and parse main language
  if (epSubs && epSubs[epubBatch.mainLang]) {
    const mainVtt = await fetchVttForLang(epSubs, epubBatch.mainLang);
    if (mainVtt) {
      const mainCaptions = parseVTT(mainVtt);

      let subCaptions = null;
      if (epubBatch.subLang && epubBatch.subLang !== epubBatch.mainLang && epSubs[epubBatch.subLang]) {
        const subVtt = await fetchVttForLang(epSubs, epubBatch.subLang);
        if (subVtt) subCaptions = parseVTT(subVtt);
      }

      const html = mergeSubtitles(mainCaptions, subCaptions);
      epubBatch.chapters.push({ title: chapterTitle, html });
    }
  }

  // Remove current episode from remaining list
  epubBatch.remaining = epubBatch.remaining.filter(id => id !== currentId);

  if (epubBatch.remaining.length === 0) {
    // All episodes done — generate EPUB
    sessionStorage.removeItem('NSD_epub_batch');

    if (epubBatch.chapters.length === 0) {
      alert('No subtitles found for the selected language.');
      return;
    }

    const zip = generateEPUB(epubBatch.seriesTitle, epubBatch.chapters);
    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, epubBatch.seriesTitle + '.epub');
  } else {
    // Save state and navigate to next episode
    sessionStorage.setItem('NSD_epub_batch', JSON.stringify(epubBatch));
    await sleep(settings.batchDelay);
    window.location = window.location.origin + '/watch/' + epubBatch.remaining[0];
  }
}

async function fetchVttForLang(epSubs, lang) {
  const formats = epSubs[lang];
  if (!formats) return null;

  // Prefer WebVTT format
  const preferred = [WEBVTT, IMSC1_1, DFXP, SIMPLE];
  let urls = null;
  for (const fmt of preferred) {
    if (formats[fmt]) {
      urls = [...formats[fmt][0]]; // clone the URL array
      break;
    }
  }
  if (!urls || urls.length === 0) return null;

  while (urls.length > 0) {
    const url = urls.splice(Math.random() * urls.length | 0, 1)[0];
    try {
      const resp = await fetch(url, { mode: 'cors' });
      const text = await resp.text();
      if (text.length > 0) return text;
    } catch (_) {}
  }
  return null;
}

// Resume batch from sessionStorage on page load
try {
  const saved = sessionStorage.getItem('NSD_batch');
  if (saved) batch = JSON.parse(saved);
} catch (_) {}

// --- Listen for data from injected page script ---
window.addEventListener('netflix_sub_downloader_data', e => {
  const { type, data } = e.detail;
  if (type === 'subs') processSubInfo(data);
  else if (type === 'id_override') idOverrides[data[0]] = data[1];
  else if (type === 'metadata') processMetadata(data);
  else if (type === 'popstate') {
    const menu = document.getElementById('nsd-menu');
    if (menu) menu.style.display = data.startsWith('/watch') ? '' : 'none';
  }
});

// --- Listen for messages from popup ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'getStatus') {
    const subs = getSubsFromCache(true);
    const langList = subs ? Object.keys(subs) : [];
    sendResponse({ onWatchPage: document.location.pathname.startsWith('/watch'), langList });
  } else if (msg.action === 'download') {
    downloadThis();
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadSeason') {
    if (batchSeason) downloadBatchFrom(batchSeason);
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadAll') {
    if (batchAll) downloadBatchFrom(batchAll);
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadEpubSeason') {
    showEpubModal('season');
    sendResponse({ ok: true });
  } else if (msg.action === 'downloadEpubAll') {
    showEpubModal('all');
    sendResponse({ ok: true });
  } else if (msg.action === 'getLangs') {
    sendResponse({ langs: getAvailableLangs() });
  }
});
