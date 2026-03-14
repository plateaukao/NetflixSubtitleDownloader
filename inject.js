// This script runs in the PAGE context (not content script) so it can
// intercept JSON.parse / JSON.stringify / fetch / XHR used by Netflix.

(function (ALL_FORMATS) {
  const MANIFEST_PATTERN = /manifest|licensedManifest/;

  const getStorage = (key, fallback) => {
    try { return localStorage.getItem(key); } catch (_) { return fallback; }
  };
  const forceSubs = getStorage('NSD_force-all-lang', null) !== 'false';
  const prefLocale = getStorage('NSD_pref-locale', '') || '';

  // When navigating away from /watch, tell the content script to hide menu
  window.addEventListener('popstate', () => {
    window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
      detail: { type: 'popstate', data: document.location.pathname }
    }));
  });

  // Hijack JSON.parse, JSON.stringify, XHR open, and fetch
  const origParse = JSON.parse;
  const origStringify = JSON.stringify;
  const origOpen = XMLHttpRequest.prototype.open;
  const origFetch = window.fetch;

  JSON.parse = function (text) {
    const data = origParse(text);
    if (data && data.result && data.result.timedtexttracks && data.result.movieId) {
      window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
        detail: { type: 'subs', data: data.result }
      }));
    }
    return data;
  };

  JSON.stringify = function (data) {
    if (data && typeof data.url === 'string' && data.url.search(MANIFEST_PATTERN) > -1) {
      for (const v of Object.values(data)) {
        try {
          if (v.profiles) {
            for (const profile of ALL_FORMATS) {
              if (!v.profiles.includes(profile)) {
                v.profiles.unshift(profile);
              }
            }
          }
          if (v.showAllSubDubTracks != null && forceSubs)
            v.showAllSubDubTracks = true;
          if (prefLocale !== '')
            v.preferredTextLocale = prefLocale;
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
        }
      }
    }
    if (data && typeof data.movieId === 'number') {
      try {
        const videoId = data.params.sessionParams.uiplaycontext.video_id;
        if (typeof videoId === 'number' && videoId !== data.movieId)
          window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
            detail: { type: 'id_override', data: [videoId, data.movieId] }
          }));
      } catch (_) {}
    }
    return origStringify(data);
  };

  XMLHttpRequest.prototype.open = function () {
    if (arguments[1] && arguments[1].includes('/metadata?')) {
      this.addEventListener('load', async function () {
        let d = this.response;
        if (d instanceof Blob) d = JSON.parse(await d.text());
        else if (typeof d === 'string') d = JSON.parse(d);
        window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
          detail: { type: 'metadata', data: d }
        }));
      }, false);
    }
    origOpen.apply(this, arguments);
  };

  window.fetch = async (...args) => {
    const response = origFetch(...args);
    if (args[0] && typeof args[0] === 'string' && args[0].includes('/metadata?')) {
      const copied = (await response).clone();
      const data = await copied.json();
      window.dispatchEvent(new CustomEvent('netflix_sub_downloader_data', {
        detail: { type: 'metadata', data: data }
      }));
    }
    return response;
  };

  // Scroll fix for language selector
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        try {
          (node.parentNode || node).querySelector('.watch-video--selector-audio-subtitle')
            .parentNode.style.overflowY = 'scroll';
        } catch (_) {}
      }
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})(["imsc1.1", "dfxp-ls-sdh", "webvtt-lssdh-ios8", "simplesdh"]);
