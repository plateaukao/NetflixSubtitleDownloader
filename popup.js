const $ = id => document.getElementById(id);

const DEFAULTS = {
  epTitleInFilename: false,
  forceSubs: true,
  prefLocale: '',
  langs: '',
  subFormat: 'webvtt-lssdh-ios8',
  batchDelay: 0
};

// Load settings
chrome.storage.local.get(DEFAULTS, s => {
  $('opt-ep-title').checked = s.epTitleInFilename;
  $('opt-force-subs').checked = s.forceSubs;
  $('opt-locale').value = s.prefLocale;
  $('opt-langs').value = s.langs;
  $('opt-format').value = s.subFormat;
  $('opt-delay').value = s.batchDelay;
});

// Save on change
const save = (key, val) => chrome.storage.local.set({ [key]: val });

$('opt-ep-title').addEventListener('change', e => save('epTitleInFilename', e.target.checked));
$('opt-force-subs').addEventListener('change', e => save('forceSubs', e.target.checked));
$('opt-locale').addEventListener('change', e => save('prefLocale', e.target.value.trim()));
$('opt-langs').addEventListener('change', e => save('langs', e.target.value.trim()));
$('opt-format').addEventListener('change', e => save('subFormat', e.target.value));
$('opt-delay').addEventListener('change', e => save('batchDelay', parseFloat(e.target.value) || 0));

// Action buttons
function sendToTab(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action }, () => {
        $('status').textContent = 'Download started!';
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
  if (!tabs[0] || !tabs[0].url || !tabs[0].url.includes('netflix.com')) {
    $('status').textContent = 'Navigate to Netflix to use this extension.';
    $('btn-download').disabled = true;
    $('btn-season').disabled = true;
    $('btn-all').disabled = true;
    $('btn-epub-season').disabled = true;
    $('btn-epub-all').disabled = true;
    return;
  }

  chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, response => {
    if (chrome.runtime.lastError || !response) {
      $('status').textContent = 'Reload the Netflix page to activate.';
      $('btn-download').disabled = true;
      $('btn-season').disabled = true;
      $('btn-all').disabled = true;
      return;
    }

    if (!response.onWatchPage) {
      $('status').textContent = 'Play a show or movie to download subs.';
      $('btn-download').disabled = true;
      $('btn-season').disabled = true;
      $('btn-all').disabled = true;
      $('btn-epub-season').disabled = true;
    $('btn-epub-all').disabled = true;
    } else if (response.langList.length === 0) {
      $('status').textContent = 'Waiting for subtitle data...';
      $('btn-download').disabled = true;
      $('btn-season').disabled = true;
      $('btn-all').disabled = true;
    } else {
      $('status').textContent = `${response.langList.length} subtitle tracks available.`;
    }
  });
});
