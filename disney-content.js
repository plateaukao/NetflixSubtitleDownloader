// Disney+ playback exposes subtitle tracks in an HLS master playlist.
// The page-world hook reports playlist URLs; this isolated script downloads
// playlists and segments through the extension background worker.
const DISNEY_EVENT = 'nsd_disney_playlist';
const DISNEY_API_REQUEST = 'nsd_disney_api_request';
const DISNEY_API_RESPONSE = 'nsd_disney_api_response';
const DISNEY_BATCH_KEY = 'NSD_disney_batch';
const DISNEY_LAST_SERIES_KEY = 'NSD_disney_last_series';
const DISNEY_PLAYBACK_GAP_MS = 5000;
const disneyState = { page: location.href, masterUrl: '', tracks: [], busy: false,
  cancel: false, transitioning: false };
const disneySettings = { langs: '', epubMainLang: '', epubSubLang: '' };

chrome.storage.local.get(disneySettings, values => Object.assign(disneySettings, values));
chrome.storage.onChanged.addListener(changes => {
  for (const key of Object.keys(disneySettings)) {
    if (changes[key]) disneySettings[key] = changes[key].newValue;
  }
});

window.addEventListener(DISNEY_EVENT, event => {
  const url = event.detail?.url;
  if (!url) return;
  let resolved;
  try { resolved = new URL(url, location.href).href; } catch (_) { return; }
  inspectDisneyPlaylist(resolved);
});

let disneyRequestId = 0;
function disneyApi(kind, value) {
  return new Promise((resolve, reject) => {
    const id = ++disneyRequestId;
    const timeout = setTimeout(() => {
      window.removeEventListener(DISNEY_API_RESPONSE, receive);
      reject(new Error('Disney+ did not respond to the series request.'));
    }, 60000);
    const receive = event => {
      if (event.detail?.id !== id) return;
      clearTimeout(timeout);
      window.removeEventListener(DISNEY_API_RESPONSE, receive);
      if (event.detail.error) reject(new Error(event.detail.error));
      else resolve(event.detail.data);
    };
    window.addEventListener(DISNEY_API_RESPONSE, receive);
    window.dispatchEvent(new CustomEvent(DISNEY_API_REQUEST, { detail: { id, kind, value } }));
  });
}

function disneyFetch(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'disneyFetch', url }, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Subtitle request failed'));
      else resolve(response.text);
    });
  });
}

async function disneyFetchWithRetry(url) {
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await disneyFetch(url); } catch (e) { error = e; }
  }
  throw error;
}

function disneyAttributes(line) {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of line.matchAll(pattern)) {
    attributes[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attributes;
}

function disneyTracks(playlist, masterUrl) {
  const tracks = [];
  const used = new Set();
  for (const line of playlist.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = disneyAttributes(line.slice('#EXT-X-MEDIA:'.length));
    if (attrs.TYPE !== 'SUBTITLES' || !attrs.URI) continue;
    const language = attrs.LANGUAGE || attrs.NAME || 'unknown';
    const forced = attrs.FORCED === 'YES';
    const cc = /captions|sdh|\bcc\b/i.test(attrs.NAME || '') || /cc|sdh/i.test(attrs.CHARACTERISTICS || '');
    const base = language + (cc ? '[cc]' : '') + (forced ? '-forced' : '');
    let key = base;
    for (let index = 2; used.has(key); index++) key = `${base}-${index}`;
    used.add(key);
    tracks.push({ key, name: attrs.NAME || language, url: new URL(attrs.URI, masterUrl).href });
  }
  return tracks;
}

function disneySegments(playlist, playlistUrl) {
  return playlist.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && /\.vtt(?:[?#]|$)/i.test(line))
    .map(line => new URL(line, playlistUrl).href);
}

async function inspectDisneyPlaylist(url) {
  disneySyncPage();
  if (disneyState.masterUrl === url) return;
  try {
    const text = await disneyFetchWithRetry(url);
    const tracks = disneyTracks(text, url);
    if (!tracks.length) return;
    disneyState.masterUrl = url;
    disneyState.tracks = tracks;
    disneyMenu();
    disneyResumeBatch();
  } catch (error) {
    console.warn('Disney+ subtitle playlist:', error);
  }
}

function disneyTitle() {
  const title = document.querySelector('.title-field')?.textContent?.trim() ||
    document.querySelector('meta[property="og:title"]')?.content || document.title || 'Disney+';
  const episode = document.querySelector('.subtitle-field')?.textContent?.trim();
  return [title, episode].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, '_').trim();
}

function disneyMenu() {
  if (!document.body) { setTimeout(disneyMenu, 100); return; }
  let menu = document.getElementById('nsd-disney-menu');
  if (!menu) {
    const style = document.createElement('style');
    style.textContent = `#nsd-disney-menu{position:fixed;z-index:99999998;top:0;left:50%;transform:translateX(-50%);font:13px Arial,sans-serif;color:white;background:#10244d;border-radius:0 0 8px 8px;min-width:250px;text-align:center}#nsd-disney-menu[hidden]{display:none}#nsd-disney-menu .nsd-disney-head{padding:10px;font-weight:bold}#nsd-disney-menu button{display:none;width:100%;padding:11px;border:0;background:#10244d;color:white;cursor:pointer;text-align:left}#nsd-disney-menu:hover button{display:block}#nsd-disney-menu button:hover{background:#2764b7}`;
    document.head.appendChild(style);
    menu = document.createElement('div');
    menu.id = 'nsd-disney-menu';
    menu.innerHTML = '<div class="nsd-disney-head">Disney+ Subtitle Downloader</div><button class="nsd-disney-download">Download subtitles for this video</button><button class="nsd-disney-epub">Download EPUB for this video...</button><button class="nsd-disney-series">Download subtitles for whole series</button><button class="nsd-disney-series-epub">Download EPUB for whole series...</button>';
    document.body.appendChild(menu);
    menu.querySelector('.nsd-disney-download').addEventListener('click', disneyDownload);
    menu.querySelector('.nsd-disney-epub').addEventListener('click', () => disneyEpubDialog('video'));
    menu.querySelector('.nsd-disney-series').addEventListener('click', () => disneyBatch('zip'));
    menu.querySelector('.nsd-disney-series-epub').addEventListener('click', () => disneyEpubDialog('series'));
  }
  menu.querySelector('.nsd-disney-download').disabled = !disneyState.tracks.length;
  menu.querySelector('.nsd-disney-epub').disabled = !disneyState.tracks.length;
  menu.querySelector('.nsd-disney-series-epub').disabled = !disneyState.tracks.length;
  menu.querySelector('.nsd-disney-series-epub').title = disneyState.tracks.length
    ? '' : 'Play an episode to choose subtitle languages';
  menu.hidden = false;
}

function disneySeriesId(url = location.href) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'www.disneyplus.com' ||
        !/^\/(?:[^/]+\/)?(?:series|browse)\//.test(parsed.pathname)) return '';
    return parsed.pathname.split('/').filter(Boolean).pop();
  } catch (_) { return ''; }
}

function disneySafeTitle(text) {
  return String(text || 'Disney+').replace(/[\\/:*?"<>|]+/g, '_').trim();
}

function disneyEpisodeId() {
  return (location.pathname || new URL(location.href).pathname)
    .match(/(?:^|\/)play\/([^/]+)/)?.[1] || '';
}

function disneyLinkedSeriesId() {
  const selectors = ['header a[href]', '[role="banner"] a[href]',
    'a[aria-label*="Back"]', 'a[aria-label*="返回"]', 'a[href*="/series/"]'];
  for (const link of document.querySelectorAll(selectors.join(','))) {
    const id = disneySeriesId(link.href);
    if (id) return id;
  }
  for (const entry of [...(window.navigation?.entries?.() || [])].reverse()) {
    const id = disneySeriesId(entry.url);
    if (id) return id;
  }
  return disneySeriesId(document.referrer || '');
}

function disneyBatchStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('NSD_Disney_Batches', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function disneyStorePut(entry) {
  const db = await disneyBatchStore();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('entries', 'readwrite');
      transaction.objectStore('entries').put(entry);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

async function disneyStoreEntries(batchId, clear = false) {
  const db = await disneyBatchStore();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('entries', clear ? 'readwrite' : 'readonly');
      const request = transaction.objectStore('entries').getAll();
      request.onsuccess = () => {
        const entries = request.result.filter(entry => entry.batchId === batchId);
        if (clear) for (const entry of entries) transaction.objectStore('entries').delete(entry.key);
        transaction.oncomplete = () => resolve(entries);
      };
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

function disneyBatchProgress(batch) {
  const progress = document.createElement('div');
  progress.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999999;background:#10244d;color:white;padding:14px;border-radius:8px;font:13px Arial,sans-serif';
  const text = document.createElement('span');
  text.textContent = `Episode ${batch.nextIndex + 1} of ${batch.episodes.length}`;
  const stop = document.createElement('button');
  stop.textContent = 'Stop and save';
  stop.style.cssText = 'margin-left:12px;padding:6px';
  stop.addEventListener('click', () => { disneyState.cancel = true; stop.disabled = true; });
  progress.append(text, stop);
  document.body.appendChild(progress);
  return progress;
}

function disneyPausePlayer() {
  for (const video of document.querySelectorAll('video')) video.pause();
}

async function disneyContinueBatch() {
  if (disneyState.transitioning) return;
  let batch;
  try { batch = JSON.parse(sessionStorage.getItem(DISNEY_BATCH_KEY)); } catch (_) { return; }
  if (!batch?.transitionTo || disneySeriesId() !== batch.seriesId) return;
  if (!document.body) { setTimeout(disneyContinueBatch, 100); return; }
  disneyState.transitioning = true;
  const progress = disneyBatchProgress(batch);
  progress.querySelector('span').textContent =
    `Playback closed. Waiting ${DISNEY_PLAYBACK_GAP_MS / 1000} seconds before episode ${batch.nextIndex + 1}.`;
  await new Promise(resolve => setTimeout(resolve, DISNEY_PLAYBACK_GAP_MS));
  if (disneyState.cancel) {
    try { await disneyFinishBatch(batch); } catch (error) { alert(error.message); }
    progress.remove();
    disneyState.transitioning = false;
    return;
  }
  delete batch.transitionTo;
  sessionStorage.setItem(DISNEY_BATCH_KEY, JSON.stringify(batch));
  location.assign(`${location.origin}/play/${encodeURIComponent(batch.episodes[batch.nextIndex].id)}`);
}

function disneyWatchBatchPlayback() {
  if (disneyState.watchingPlayback || !disneyEpisodeId()) return;
  let batch;
  try { batch = JSON.parse(sessionStorage.getItem(DISNEY_BATCH_KEY)); } catch (_) { return; }
  if (!batch || disneyEpisodeId() !== batch.episodes[batch.nextIndex]?.id) return;
  disneyState.watchingPlayback = true;
  setTimeout(() => {
    if (disneyState.tracks.length || !sessionStorage.getItem(DISNEY_BATCH_KEY)) return;
    const progress = disneyBatchProgress(batch);
    progress.querySelector('span').textContent =
      'Disney+ playback did not start. Fix playback and reload, or save completed episodes.';
    progress.querySelector('button').addEventListener('click', async () => {
      try { await disneyFinishBatch(batch); progress.remove(); }
      catch (error) { alert(error.message); }
    });
    disneyState.stalledProgress = progress;
  }, 60000);
}

async function disneyBatch(kind, options = {}) {
  if (disneyState.busy || sessionStorage.getItem(DISNEY_BATCH_KEY)) return;
  let seriesId = options.seriesId || disneySeriesId() || disneyLinkedSeriesId() ||
    sessionStorage.getItem(DISNEY_LAST_SERIES_KEY);
  if (kind === 'epub' && !options.mainLang) { alert('Choose a main subtitle language.'); return; }
  disneyState.busy = true;
  try {
    const episodeId = disneyEpisodeId();
    let catalog;
    if (seriesId) {
      try { catalog = await disneyApi('series', seriesId); } catch (error) {
        if (!episodeId) throw error;
      }
    }
    if (episodeId && !catalog?.episodes?.some(episode =>
        episode.id === episodeId || episode.mediaId === episodeId)) {
      const found = await disneyApi('episodeSeries', episodeId);
      seriesId = found.seriesId;
      catalog = found.catalog;
    }
    if (!catalog) throw new Error('Open a Disney+ series or episode to download the whole series.');
    const episodes = catalog.episodes.filter(episode => episode.id);
    if (!episodes.length) throw new Error('No playable episodes found in this series.');
    const batch = {
      id: crypto.randomUUID(), kind, seriesId, title: disneySafeTitle(catalog.title),
      episodes, nextIndex: 0, errors: [],
      mainLang: options.mainLang?.toLowerCase() || '',
      subLang: options.subLang?.toLowerCase() || ''
    };
    if (kind === 'epub') {
      const cover = await disneyCoverData(options.cover);
      if (cover) await disneyStorePut({ key: `${batch.id}|cover`, batchId: batch.id, kind: 'cover', cover });
    }
    sessionStorage.setItem(DISNEY_BATCH_KEY, JSON.stringify(batch));
    sessionStorage.setItem(DISNEY_LAST_SERIES_KEY, seriesId);
    disneyState.busy = false;
    if (disneyEpisodeId() === episodes[0].id && disneyState.tracks.length) disneyResumeBatch();
    else location.assign(`${location.origin}/play/${encodeURIComponent(episodes[0].id)}`);
  } catch (error) { disneyState.busy = false; alert(error.message); }
}

async function disneyFinishBatch(batch) {
  const entries = await disneyStoreEntries(batch.id);
  if (batch.kind === 'zip') {
    const zip = new JSZip();
    for (const entry of entries.filter(entry => entry.kind === 'file')) zip.file(entry.filename, entry.text);
    if (Object.keys(zip.files).length)
      saveAs(await zip.generateAsync({ type: 'blob' }), `${batch.title}.zip`);
  } else {
    const chapters = entries.filter(entry => entry.kind === 'chapter')
      .sort((a, b) => a.index - b.index).map(entry => entry.chapter);
    const cover = entries.find(entry => entry.kind === 'cover')?.cover || null;
    if (chapters.length) {
      const book = generateEPUB(batch.title, chapters, cover);
      saveAs(await book.generateAsync({ type: 'blob' }), `${batch.title}.epub`);
    }
  }
  sessionStorage.removeItem(DISNEY_BATCH_KEY);
  await disneyStoreEntries(batch.id, true);
  if (batch.errors.length) alert(`Some episodes could not be downloaded:\n${batch.errors.slice(0, 12).join('\n')}`);
}

async function disneyResumeBatch() {
  if (disneyState.busy || !disneyState.tracks.length) return;
  let batch;
  try { batch = JSON.parse(sessionStorage.getItem(DISNEY_BATCH_KEY)); } catch (_) { return; }
  if (!batch || disneyEpisodeId() !== batch.episodes[batch.nextIndex]?.id) return;
  disneyState.busy = true;
  disneyState.cancel = false;
  disneyState.stalledProgress?.remove();
  disneyState.stalledProgress = null;
  disneyPausePlayer();
  const progress = disneyBatchProgress(batch);
  const episode = batch.episodes[batch.nextIndex];
  const episodeTitle = `${batch.title}.S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`;
  try {
    if (batch.kind === 'zip') {
      for (const track of disneyFilterTracks(disneyState.tracks)) {
        if (disneyState.cancel) break;
        try {
          const captions = await disneyCaptions(track);
          if (!captions.length) continue;
          await disneyStorePut({ key: `${batch.id}|file|${batch.nextIndex}|${track.key}`,
            batchId: batch.id, kind: 'file',
            filename: `${episodeTitle}.WEBRip.DisneyPlus.${track.key}.srt`, text: disneySrt(captions) });
        } catch (error) { batch.errors.push(`${episodeTitle} ${track.key}: ${error.message}`); }
      }
    } else {
      const find = lang => disneyState.tracks.find(track => track.key.toLowerCase() === lang) ||
        disneyState.tracks.find(track => track.key.toLowerCase().startsWith(lang + '-'));
      const main = find(batch.mainLang);
      if (!main) throw new Error(`No ${batch.mainLang} subtitle track`);
      const mainCaptions = await disneyCaptions(main);
      if (!mainCaptions.length) throw new Error('No subtitle cues');
      const second = batch.subLang && batch.subLang !== batch.mainLang ? find(batch.subLang) : null;
      const secondCaptions = second ? await disneyCaptions(second) : null;
      await disneyStorePut({ key: `${batch.id}|chapter|${batch.nextIndex}`,
        batchId: batch.id, kind: 'chapter', index: batch.nextIndex,
        chapter: { title: `S${episode.season}E${episode.episode} ${episode.title}`.trim(),
          html: mergeSubtitles(mainCaptions, secondCaptions) } });
    }
  } catch (error) { batch.errors.push(`${episodeTitle}: ${error.message}`); }
  disneyPausePlayer();
  batch.nextIndex++;
  try {
    sessionStorage.setItem(DISNEY_BATCH_KEY, JSON.stringify(batch));
    if (disneyState.cancel || batch.nextIndex === batch.episodes.length) await disneyFinishBatch(batch);
    else {
      batch.transitionTo = batch.episodes[batch.nextIndex].id;
      sessionStorage.setItem(DISNEY_BATCH_KEY, JSON.stringify(batch));
      location.assign(`${location.origin}/browse/${encodeURIComponent(batch.seriesId)}`);
    }
  } catch (error) { alert(`Could not save series progress: ${error.message}`); }
  finally { progress.remove(); disneyState.busy = false; }
}

function disneySelectedTracks() {
  return disneyFilterTracks(disneyState.tracks);
}

function disneyFilterTracks(tracks) {
  const filters = disneySettings.langs.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return tracks.filter(track => !filters.length || filters.some(lang =>
    track.key.toLowerCase() === lang || track.key.toLowerCase().startsWith(lang + '[') ||
    track.key.toLowerCase().startsWith(lang + '-')));
}

async function disneyCaptions(track) {
  const playlist = await disneyFetchWithRetry(track.url);
  const urls = disneySegments(playlist, track.url);
  if (!urls.length) throw new Error(`No VTT segments for ${track.key}`);
  const captions = [];
  const seen = new Set();
  for (const url of urls) {
    const segment = await disneyFetchWithRetry(url);
    for (const caption of parseVTT(segment)) {
      const id = `${caption.start}|${caption.end}|${caption.text}`;
      if (!seen.has(id)) { seen.add(id); captions.push(caption); }
    }
  }
  return captions.sort((a, b) => a.start - b.start);
}

function disneySrt(captions) {
  const time = ms => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor(ms / 60000) % 60;
    const seconds = Math.floor(ms / 1000) % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return captions.map((caption, index) =>
    `${index + 1}\r\n${time(caption.start)} --> ${time(caption.end)}\r\n${caption.text.replace(/&amp;/g, '&')}\r\n`).join('\r\n');
}

async function disneyDownload() {
  if (disneyState.busy) return;
  disneyState.busy = true;
  const tracks = disneySelectedTracks();
  const zip = new JSZip();
  const errors = [];
  const title = disneyTitle();
  try {
    for (const track of tracks) {
      try {
        const captions = await disneyCaptions(track);
        if (!captions.length) throw new Error('No subtitle cues');
        zip.file(`${title}.WEBRip.DisneyPlus.${track.key}.srt`, disneySrt(captions));
      } catch (error) { errors.push(`${track.key}: ${error.message}`); }
    }
    if (Object.keys(zip.files).length) saveAs(await zip.generateAsync({ type: 'blob' }), `${title}.zip`);
    if (errors.length || !tracks.length) alert(errors.join('\n') || 'No subtitles match your language filter.');
  } finally { disneyState.busy = false; }
}

function disneyCoverCandidates() {
  const candidates = [];
  const used = new Set();
  const add = (url, width = 0, height = 0) => {
    try {
      const resolved = new URL(url, location.href);
      if (resolved.hostname !== 'disney.images.edge.bamgrid.com' || used.has(resolved.href)) return;
      used.add(resolved.href);
      candidates.push({ url: resolved.href, portrait: height > width, area: width * height });
    } catch (_) {}
  };
  add(document.querySelector('meta[property="og:image"]')?.content);
  for (const img of document.images) add(img.currentSrc || img.src, img.naturalWidth, img.naturalHeight);
  for (const node of document.querySelectorAll('[style*="background"]')) {
    const match = node.style.backgroundImage.match(/url\(["']?([^"')]+)/);
    if (match) add(match[1], node.clientWidth, node.clientHeight);
  }
  for (const node of document.querySelectorAll('[class*="hero"], [class*="Hero"], [class*="background"], [class*="Backdrop"]')) {
    const match = getComputedStyle(node).backgroundImage.match(/url\(["']?([^"')]+)/);
    if (match) add(match[1], node.clientWidth, node.clientHeight);
  }
  candidates.sort((a, b) => Number(b.portrait) - Number(a.portrait) || b.area - a.area);
  return candidates.slice(0, 24);
}

function disneyCoverPicker(panel) {
  const label = document.createElement('div');
  label.textContent = 'Book cover';
  label.style.cssText = 'margin:14px 0 6px';
  panel.appendChild(label);
  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;gap:7px;flex-wrap:wrap;max-height:220px;overflow:auto;max-width:450px';
  panel.appendChild(grid);
  let selected = null;
  const tiles = [];
  const choose = (tile, value) => {
    selected = value;
    for (const other of tiles) other.style.borderColor = other === tile ? '#58a6ff' : '#555';
  };
  const tile = (labelText, imageUrl, value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = labelText;
    button.style.cssText = 'width:75px;height:105px;padding:0;border:2px solid #555;border-radius:4px;background:#24395d;color:white;cursor:pointer;overflow:hidden';
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = labelText;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover';
      button.appendChild(img);
    } else button.textContent = labelText;
    button.addEventListener('click', () => choose(button, value));
    grid.appendChild(button);
    tiles.push(button);
    return button;
  };
  const candidates = disneyCoverCandidates();
  candidates.forEach((candidate, index) => tile(`Cover ${index + 1}`, candidate.url, candidate));
  const upload = tile('+ Upload', '', null);
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  panel.appendChild(fileInput);
  upload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const preview = URL.createObjectURL(file);
    const uploaded = tile('Uploaded cover', preview, { file });
    choose(uploaded, { file });
  });
  const none = tile('No cover', '', null);
  if (candidates.length) choose(tiles[0], candidates[0]);
  else choose(none, null);
  return () => selected;
}

async function disneyCoverData(choice) {
  if (!choice) return null;
  let bytes;
  let mime;
  if (choice.file) {
    bytes = new Uint8Array(await choice.file.arrayBuffer());
    mime = choice.file.type;
  } else {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'disneyImage', url: choice.url }, reply => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!reply?.ok) reject(new Error(reply?.error || 'Could not download cover image'));
        else resolve(reply);
      });
    });
    bytes = Uint8Array.from(atob(response.base64), char => char.charCodeAt(0));
    mime = response.mime?.split(';')[0];
  }
  if (mime === 'image/webp') {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    mime = 'image/jpeg';
  }
  if (mime !== 'image/jpeg' && mime !== 'image/png')
    throw new Error('Choose a JPEG, PNG, or WebP cover image.');
  return { data: bytes, mediaType: mime, ext: mime === 'image/png' ? 'png' : 'jpg' };
}

async function disneyEpubDialog(scope = 'video') {
  const tracks = disneyState.tracks.filter(track => !track.key.includes('-forced'));
  if (!tracks.length) { alert('Play an episode and wait for subtitle languages to load.'); return; }
  const existing = document.getElementById('nsd-disney-dialog');
  if (existing) existing.remove();
  const dialog = document.createElement('div');
  dialog.id = 'nsd-disney-dialog';
  dialog.style.cssText = 'position:fixed;inset:0;z-index:99999999;background:#000b;display:flex;align-items:center;justify-content:center;font:14px Arial,sans-serif;color:white';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#10244d;padding:24px;border-radius:10px;min-width:300px';
  const heading = document.createElement('h2');
  heading.textContent = scope === 'series' ? 'Download EPUB for whole series' : 'Download EPUB for this video';
  panel.appendChild(heading);
  if (scope === 'series') {
    const hint = document.createElement('div');
    hint.textContent = 'Languages shown are from this episode; availability may vary across the series.';
    panel.appendChild(hint);
  }
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => dialog.remove());
  panel.appendChild(cancel);
  dialog.appendChild(panel);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.remove(); });
  document.body.appendChild(dialog);

  const selects = [];
  for (const labelText of ['Main language', 'Second language (optional)']) {
    const label = document.createElement('label');
    label.textContent = labelText;
    label.style.cssText = 'display:block;margin:12px 0';
    const select = document.createElement('select');
    select.style.cssText = 'display:block;width:100%;margin-top:5px;padding:6px';
    if (selects.length) select.add(new Option('None', ''));
    for (const track of tracks) select.add(new Option(`${track.name} (${track.key})`, track.key));
    const preferred = selects.length ? disneySettings.epubSubLang : disneySettings.epubMainLang;
    const match = preferred && tracks.find(track => track.key.toLowerCase().startsWith(preferred.toLowerCase()));
    if (match) select.value = match.key;
    label.appendChild(select);
    panel.appendChild(label);
    selects.push(select);
  }
  const selectedCover = disneyCoverPicker(panel);
  const button = document.createElement('button');
  button.textContent = 'Download EPUB';
  button.style.cssText = 'padding:8px;margin-right:10px';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (scope === 'series') {
        const options = { mainLang: selects[0].value,
          subLang: selects[1].value, cover: selectedCover() };
        dialog.remove();
        disneyBatch('epub', options);
        return;
      }
      const main = await disneyCaptions(tracks.find(t => t.key === selects[0].value));
      const secondary = selects[1].value && selects[1].value !== selects[0].value
        ? await disneyCaptions(tracks.find(t => t.key === selects[1].value)) : null;
      if (!main.length) throw new Error('No subtitle cues found.');
      const title = disneyTitle();
      const coverData = await disneyCoverData(selectedCover());
      const book = generateEPUB(title, [{ title, html: mergeSubtitles(main, secondary) }], coverData);
      saveAs(await book.generateAsync({ type: 'blob' }), `${title}.epub`);
      dialog.remove();
    } catch (error) { alert(error.message); button.disabled = false; }
  });
  panel.append(button, cancel);
}

// Disney+ navigates between titles without a full reload.
function disneySyncPage() {
  if (location.href === disneyState.page) return;
  disneyState.page = location.href;
  disneyState.masterUrl = '';
  disneyState.tracks = [];
  const menu = document.getElementById('nsd-disney-menu');
  if (menu) menu.hidden = true;
  if (disneySeriesId()) {
    sessionStorage.setItem(DISNEY_LAST_SERIES_KEY, disneySeriesId());
    disneyMenu();
    disneyContinueBatch();
  }
}
setInterval(disneySyncPage, 500);
disneyWatchBatchPlayback();
if (disneySeriesId()) {
  sessionStorage.setItem(DISNEY_LAST_SERIES_KEY, disneySeriesId());
  disneyContinueBatch();
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', disneyMenu, { once: true });
  else disneyMenu();
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.action === 'getStatus') {
    respond({ service: 'disney', onWatchPage: !!disneyState.tracks.length,
      onSeriesPage: !!disneySeriesId(),
      langList: disneyState.tracks.map(track => track.key) });
  } else if (message.action === 'download') {
    disneyDownload();
    respond({ ok: true });
  } else if (message.action === 'downloadEpubSeason') {
    disneyEpubDialog();
    respond({ ok: true });
  } else if (message.action === 'downloadAll') {
    disneyBatch('zip');
    respond({ ok: true });
  } else if (message.action === 'downloadEpubAll') {
    disneyEpubDialog('series');
    respond({ ok: true });
  }
});
