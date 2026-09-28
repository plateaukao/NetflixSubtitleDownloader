// Runs in Disney+'s page world so playback playlist requests can be observed.
(() => {
  const eventName = 'nsd_disney_playlist';
  const apiRequest = 'nsd_disney_api_request';
  const apiResponse = 'nsd_disney_api_response';
  let authorization = '';
  let region = 'US';
  let language = 'en';
  const remember = (url, headers) => {
    try {
      const token = new Headers(headers).get('authorization');
      if (token && /disney\.(?:api|content|playback)\.edge\.bamgrid\.com/.test(String(url)))
        authorization = token;
    } catch (_) {}
    const match = String(url).match(/\/region\/([^/]+)\/.*\/language\/([^/]+)/);
    if (match) { region = match[1]; language = match[2]; }
  };
  const notify = url => {
    if (typeof url !== 'string' || !/\.m3u8(?:[?#]|$)/i.test(url)) return;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { url } }));
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    notify(typeof url === 'string' ? url : url?.toString());
    this._nsdDisneyUrl = url;
    remember(url);
    return open.call(this, method, url, ...rest);
  };

  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === 'authorization' &&
        /disney\.(?:api|content|playback)\.edge\.bamgrid\.com/.test(this._nsdDisneyUrl || ''))
      authorization = value;
    return setRequestHeader.call(this, name, value);
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, ...rest) {
    const url = typeof input === 'string' ? input : input?.url;
    notify(url);
    if (/bamgrid\.com/.test(url || '')) {
      remember(url, input?.headers);
      remember(url, rest[0]?.headers);
    }
    return originalFetch.call(this, input, ...rest);
  };

  const apiGet = async url => {
    const response = await originalFetch.call(window, url, {
      headers: { authorization }, credentials: 'include'
    });
    if (!response.ok) throw new Error(`Disney+ metadata: HTTP ${response.status}`);
    return response.json();
  };

  const contentUrl = (name, suffix) =>
    `https://disney.content.edge.bamgrid.com/svc/content/${name}/version/5.1/region/${region}/audience/false/maturity/1850/language/${language}/${suffix}`;

  function seriesCandidates(data) {
    const ids = new Set();
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 12) return;
      for (const [key, child] of Object.entries(value)) {
        if (/^(encodedSeriesId|seriesId|seriesEntityId|seriesPageId|parentSeriesId)$/i.test(key) &&
            typeof child === 'string') ids.add(child);
        else if (key === 'series' && child && typeof child === 'object') {
          if (typeof child.id === 'string') ids.add(child.id);
          walk(child, depth + 1);
        }
        else if (typeof child === 'string' && /(?:href|url|link)$/i.test(key)) {
          const match = child.match(/\/(?:series|browse)\/(entity-[a-z0-9-]+)/i);
          if (match) ids.add(match[1]);
        }
        else if (typeof child === 'object') walk(child, depth + 1);
      }
    };
    walk(data, 0);
    return [...ids];
  }

  async function seriesEpisodesFromExplore(pageId) {
    const page = (await apiGet(`https://disney.api.edge.bamgrid.com/explore/v1.12/page/${pageId}?limit=0`))?.data?.page;
    const seasons = page?.containers?.flatMap(container => container.seasons || []) || [];
    if (!seasons.length) throw new Error('No seasons found in the series catalog.');
    const episodes = [];
    for (let seasonIndex = 0; seasonIndex < seasons.length; seasonIndex++) {
      const season = seasons[seasonIndex];
      const seasonUrl = `https://disney.api.edge.bamgrid.com/explore/v1.12/season/${encodeURIComponent(season.id)}`;
      const result = await apiGet(seasonUrl);
      const seasonData = result?.data?.season;
      const items = [...(seasonData?.items || [])];
      const total = Number(seasonData?.pagination?.total || seasonData?.pagination?.totalCount ||
        seasonData?.items_meta?.hits || seasonData?.totalCount || items.length);
      while (items.length < total) {
        const next = await apiGet(`${seasonUrl}?offset=${items.length}&limit=${items.length}`);
        const extra = next?.data?.season?.items || [];
        if (!extra.length) throw new Error(`Could not load every episode in ${season.visuals?.name || 'a season'}.`);
        const known = new Set(items.map(item => item.id || item.actions?.[0]?.resourceId));
        const additions = extra.filter(item => !known.has(item.id || item.actions?.[0]?.resourceId));
        if (!additions.length) throw new Error(`Could not load every episode in ${season.visuals?.name || 'a season'}.`);
        items.push(...additions);
      }
      const seasonNumber = Number(season.visuals?.seasonNumber ||
        String(season.visuals?.name || '').match(/\d+/)?.[0] || seasonIndex + 1);
      for (const item of items) {
        const mediaId = item.actions?.find(action => action.resourceId)?.resourceId ||
          item.mediaMetadata?.mediaId;
        const id = item.id || item.actions?.find(action => action.contentId)?.contentId;
        if (!mediaId || !id) continue;
        episodes.push({ id, mediaId, season: Number(item.visuals?.seasonNumber || seasonNumber),
          episode: Number(item.visuals?.episodeNumber || episodes.length + 1),
          title: item.visuals?.episodeTitle || item.visuals?.title || '' });
      }
    }
    if (!episodes.length) throw new Error('No playable episodes found in the series catalog.');
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { title: typeof page.visuals?.title === 'string' ? page.visuals.title
      : page.actions?.[0]?.internalTitle || document.title,
      episodes };
  }

  async function seriesEpisodesFromLegacy(pageId) {
    if (!authorization) throw new Error('Wait for the Disney+ page to finish loading, then retry.');
    const candidates = [pageId, pageId.replace(/^entity-/, '')];
    if (pageId.startsWith('entity-')) {
      const explore = await apiGet(`https://disney.api.edge.bamgrid.com/explore/v1.2/page/${pageId}`);
      candidates.unshift(...seriesCandidates(explore));
    }
    let bundle;
    for (const id of [...new Set(candidates)]) {
      try {
        const result = await apiGet(contentUrl('DmcSeriesBundle', `encodedSeriesId/${id}`));
        if (result?.data?.DmcSeriesBundle?.series) { bundle = result.data.DmcSeriesBundle; break; }
      } catch (_) {}
    }
    if (!bundle) throw new Error('Could not load this Disney+ series catalog.');
    const title = bundle.series?.text?.title?.full?.series?.default?.content || document.title;
    const episodes = [];
    for (const season of bundle.seasons?.seasons || []) {
      const seasonNumber = Number(season.seasonSequenceNumber);
      const count = Number(season.episodes_meta?.hits || 0);
      for (let page = 1; page <= Math.max(1, Math.ceil(count / 30)); page++) {
        const result = await apiGet(contentUrl('DmcEpisodes',
          `seasonId/${season.seasonId}/pageSize/30/page/${page}`));
        for (const episode of result?.data?.DmcEpisodes?.videos || []) {
          const mediaId = episode.mediaMetadata?.mediaId;
          const id = episode.id || episode.familyId;
          if (!mediaId || !id) continue;
          episodes.push({ id, mediaId, season: seasonNumber,
            episode: Number(episode.episodeSequenceNumber),
            title: episode.text?.title?.full?.program?.default?.content || '' });
        }
      }
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    if (!episodes.length) throw new Error('No episodes were found in this series.');
    return { title, episodes };
  }

  async function seriesEpisodes(pageId) {
    if (!authorization) throw new Error('Wait for the Disney+ page to finish loading, then retry.');
    try { return await seriesEpisodesFromExplore(pageId); }
    catch (modernError) {
      try { return await seriesEpisodesFromLegacy(pageId); }
      catch (_) { throw modernError; }
    }
  }

  async function episodeSeries(episodeId) {
    if (!authorization) throw new Error('Wait for the Disney+ episode to finish loading, then retry.');
    const candidates = new Set();
    const add = id => {
      if (typeof id !== 'string' || !id.trim()) return;
      id = id.trim();
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
        candidates.add(`entity-${id}`);
      else candidates.add(id);
    };
    const pageIds = episodeId.startsWith('entity-') ? [episodeId] :
      [`entity-${episodeId}`, episodeId];
    const urls = [
      ...pageIds.map(id => `https://disney.api.edge.bamgrid.com/explore/v1.12/page/${encodeURIComponent(id)}?limit=0`),
      contentUrl('DmcVideo', `contentId/${encodeURIComponent(episodeId)}`),
      contentUrl('DmcVideoBundle', `contentId/${encodeURIComponent(episodeId)}`)
    ];
    for (const url of urls) {
      try {
        const metadata = await apiGet(url);
        for (const id of seriesCandidates(metadata)) add(id);
      } catch (_) {}
      for (const id of candidates) {
        try {
          const catalog = await seriesEpisodes(id);
          if (catalog.episodes.some(episode => episode.id === episodeId ||
              episode.mediaId === episodeId)) return { seriesId: id, catalog };
        } catch (_) {}
        candidates.delete(id);
      }
    }
    throw new Error('Could not identify this episode’s series from Disney+ metadata. Open its series page, then retry.');
  }

  window.addEventListener(apiRequest, async event => {
    const { id, kind, value } = event.detail || {};
    try {
      const data = kind === 'series' ? await seriesEpisodes(value)
        : kind === 'episodeSeries' ? await episodeSeries(value) : null;
      window.dispatchEvent(new CustomEvent(apiResponse, { detail: { id, data } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent(apiResponse, { detail: { id, error: error.message } }));
    }
  });
})();
