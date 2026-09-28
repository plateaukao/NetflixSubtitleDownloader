const $ = id => document.getElementById(id);

const DEFAULTS = {
  epTitleInFilename: false,
  forceSubs: true,
  prefLocale: '',
  langs: '',
  subFormat: 'webvtt-lssdh-ios8',
  batchDelay: 0,
  epubMainLang: '',
  epubSubLang: ''
};

// Load settings
chrome.storage.local.get(DEFAULTS, s => {
  $('opt-ep-title').checked = s.epTitleInFilename;
  $('opt-force-subs').checked = s.forceSubs;
  $('opt-locale').value = s.prefLocale;
  $('opt-langs').value = s.langs;
  $('opt-format').value = s.subFormat;
  $('opt-delay').value = s.batchDelay;
  $('opt-epub-main').value = s.epubMainLang;
  $('opt-epub-sub').value = s.epubSubLang;
});

// Save on change
const save = (key, val) => chrome.storage.local.set({ [key]: val });

$('opt-ep-title').addEventListener('change', e => save('epTitleInFilename', e.target.checked));
$('opt-force-subs').addEventListener('change', e => save('forceSubs', e.target.checked));
$('opt-locale').addEventListener('change', e => save('prefLocale', e.target.value.trim()));
$('opt-langs').addEventListener('change', e => save('langs', e.target.value.trim()));
$('opt-format').addEventListener('change', e => save('subFormat', e.target.value));
$('opt-delay').addEventListener('change', e => save('batchDelay', parseFloat(e.target.value) || 0));
$('opt-epub-main').addEventListener('change', e => save('epubMainLang', e.target.value.trim()));
$('opt-epub-sub').addEventListener('change', e => save('epubSubLang', e.target.value.trim()));

// Action buttons
function sendToTab(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action }, response => {
        $('status').textContent = chrome.runtime.lastError || !response?.ok
          ? 'Could not start download. Reload the page and try again.' : 'Download started!';
      });
    }
  });
}

$('btn-download').addEventListener('click', () => sendToTab('download'));
$('btn-season').addEventListener('click', () => sendToTab('downloadSeason'));
$('btn-all').addEventListener('click', () => sendToTab('downloadAll'));
$('btn-epub-season').addEventListener('click', () => {
  sendToTab('downloadEpubSeason');
  window.close();
});
$('btn-epub-all').addEventListener('click', () => {
  sendToTab('downloadEpubAll');
  window.close();
});

// Check status
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const host = (() => { try { return new URL(tabs[0]?.url).hostname; } catch (_) { return ''; } })();
  const disney = host === 'www.disneyplus.com';
  if (host !== 'www.netflix.com' && !disney) {
    $('status').textContent = 'Navigate to Netflix or Disney+ to use this extension.';
    $('btn-download').disabled = true;
    $('btn-season').disabled = true;
    $('btn-all').disabled = true;
    $('btn-epub-season').disabled = true;
    $('btn-epub-all').disabled = true;
    return;
  }

  if (disney) {
    $('btn-download').textContent = 'Download subtitles for this video (SRT ZIP)';
    $('btn-season').hidden = true;
    $('btn-all').textContent = 'Download subtitles for whole series';
    $('btn-epub-season').textContent = 'Download EPUB (this video)...';
    $('btn-epub-all').textContent = 'Download EPUB (whole series)...';
    $('opt-force-subs').closest('label').hidden = true;
    $('opt-locale').closest('label').hidden = true;
    $('opt-format').closest('label').hidden = true;
    $('opt-delay').closest('label').hidden = true;
    $('opt-ep-title').closest('label').hidden = true;
  }

  chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, response => {
    if (chrome.runtime.lastError || !response) {
      $('status').textContent = `Reload the ${disney ? 'Disney+' : 'Netflix'} page to activate.`;
      $('btn-download').disabled = true;
      $('btn-season').disabled = true;
      $('btn-all').disabled = true;
      $('btn-epub-season').disabled = true;
      $('btn-epub-all').disabled = true;
      return;
    }

    if (!response.onWatchPage) {
      $('status').textContent = disney && response.onSeriesPage
        ? 'Series ZIP is ready. Play an episode to choose EPUB languages.'
        : disney ? 'Play a video and wait for subtitle tracks.' : 'Play a show or movie to download subs.';
      $('btn-download').disabled = true;
      $('btn-season').disabled = true;
      $('btn-all').disabled = !disney || !response.onSeriesPage;
      $('btn-epub-season').disabled = true;
      $('btn-epub-all').disabled = true;
    } else if (response.langList.length === 0) {
      $('status').textContent = 'Waiting for subtitle data...';
      $('btn-download').disabled = true;
      $('btn-season').disabled = true;
      $('btn-all').disabled = !disney;
      $('btn-epub-season').disabled = true;
      $('btn-epub-all').disabled = !disney;
    } else {
      $('status').textContent = `${response.langList.length} subtitle tracks available.`;
    }
  });
});
