const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const noop = () => {};

test('localized series catalog discovers episodes in every season', async () => {
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, fn) {
      const list = this.listeners.get(name) || [];
      list.push(fn);
      this.listeners.set(name, list);
    }
    dispatchEvent(event) {
      for (const fn of this.listeners.get(event.type) || []) fn(event);
    }
  }
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  }
  class XHR { open() {} setRequestHeader() {} }
  const window = new Events();
  const pageId = 'entity-5002284c-af1f-4b2e-a954-fe217793e79a';
  const requests = [];
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    const data = url.includes('/page/entity-episode-2')
      ? { page: { id: 'episode-2', seriesId: pageId } }
      : url.includes('/page/') ? { page: { visuals: { title: 'Series' },
      containers: [{ seasons: [{ id: 'first', visuals: { name: 'Season 1' } },
        { id: 'second', visuals: { name: 'Season 2' } }] }] } }
      : url.includes('/season/first') ? { season: { items: [{
        id: 'episode-1',
        actions: [{ resourceId: 'media-1' }],
        visuals: { seasonNumber: 1, episodeNumber: 1, episodeTitle: 'First' }
      }] } } : url.includes('/season/second') ? { season: { items: [{
        id: 'episode-2',
        actions: [{ resourceId: 'media-2' }],
        visuals: { seasonNumber: 2, episodeNumber: 1, episodeTitle: 'Second' }
      }] } } : { stream: { sources: [{ complete: { url: 'https://media.dssott.com/master.m3u8' } }] } };
    return { ok: true, json: async () => ({ data, ...data }) };
  };
  const context = vm.createContext({ window, XMLHttpRequest: XHR, Headers,
    CustomEvent, document: { title: 'Series' }, btoa, console });
  vm.runInContext(source('disney-inject.js'), context);
  await window.fetch('https://disney.api.edge.bamgrid.com/explore/session',
    { headers: { authorization: 'Bearer test' } });
  const reply = new Promise(resolve => window.addEventListener('nsd_disney_api_response',
    event => { if (event.detail.id === 1) resolve(event.detail); }));
  window.dispatchEvent(new CustomEvent('nsd_disney_api_request',
    { detail: { id: 1, kind: 'series', value: pageId } }));
  const result = await reply;
  assert.equal(result.data.episodes.length, 2);
  assert.equal(result.data.episodes[1].mediaId, 'media-2');
  assert.equal(result.data.episodes[1].id, 'episode-2');
  assert(requests.some(request => request.url.includes(`/page/${pageId}`)));

  const episodeReply = new Promise(resolve => window.addEventListener('nsd_disney_api_response',
    event => { if (event.detail.id === 2) resolve(event.detail); }));
  window.dispatchEvent(new CustomEvent('nsd_disney_api_request',
    { detail: { id: 2, kind: 'episodeSeries', value: 'episode-2' } }));
  const episodeResult = await episodeReply;
  assert.equal(episodeResult.data.seriesId, pageId);
  assert.equal(episodeResult.data.catalog.episodes[1].id, 'episode-2');
});

test('whole-series ZIP visits episode players and saves both episodes', async () => {
  const state = new Map();
  const files = new Map();
  const navigations = [];
  const location = { origin: 'https://www.disneyplus.com',
    href: 'https://www.disneyplus.com/zh-hant/browse/entity-series',
    pathname: '/zh-hant/browse/entity-series',
    assign(url) { navigations.push(url); this.href = url; this.pathname = new URL(url).pathname; } };
  const element = tag => ({ tag, style: {}, children: [],
    append(...children) { this.children.push(...children); },
    querySelector(selector) { return this.children.find(child =>
      child.tag === selector || selector === 'span' && child.tag === 'span'); },
    remove: noop, addEventListener: noop });
  class JSZip {
    constructor() { this.files = {}; }
    file(name, data) { this.files[name] = data; }
    async generateAsync() { return this.files; }
  }
  let saved;
  let pauses = 0;
  const delays = [];
  let batchNumber = 0;
  let epubChapters;
  const context = vm.createContext({ URL, console, JSZip,
    crypto: { randomUUID: () => `batch-${++batchNumber}` },
    mergeSubtitles: () => '<p>Hello</p>',
    generateEPUB: (_title, chapters) => {
      epubChapters = chapters;
      return { generateAsync: async () => 'epub bytes' };
    },
    saveAs: (data, name) => { saved = { data, name }; },
    alert: message => { throw new Error(message); }, location,
    sessionStorage: { getItem: key => state.get(key) || null,
      setItem: (key, value) => state.set(key, value), removeItem: key => state.delete(key) },
    document: { readyState: 'loading', addEventListener: noop, querySelector: () => null,
      querySelectorAll: selector => selector === 'video'
        ? [{ pause: () => { pauses++; } }] : [],
      createElement: element, body: { appendChild: noop }, getElementById: () => null },
    chrome: { storage: { local: { get: (_, cb) => cb({}) },
      onChanged: { addListener: noop } }, runtime: { onMessage: { addListener: noop } } },
    window: { addEventListener: noop }, setInterval: noop,
    setTimeout: (callback, delay) => { delays.push(delay); callback(); } });
  vm.runInContext(source('disney-content.js'), context);
  context.disneyApi = async () => ({ title: 'Series', episodes: [
    { id: 'episode-1', mediaId: 'one', season: 1, episode: 1 },
    { id: 'episode-2', mediaId: 'two', season: 2, episode: 1 }
  ] });
  context.disneyStorePut = async entry => files.set(entry.key, entry);
  context.disneyStoreEntries = async (id, clear) => {
    const entries = [...files.values()].filter(entry => entry.batchId === id);
    if (clear) entries.forEach(entry => files.delete(entry.key));
    return entries;
  };
  context.disneyCaptions = async () => [{ start: 1000, end: 2000, text: 'Hello' }];
  context.disneySrt = () => '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
  await context.disneyBatch('zip');
  assert.equal(navigations[0], 'https://www.disneyplus.com/play/episode-1');
  vm.runInContext('disneyState.tracks = [{ key: "en", name: "English", url: "subs" }]', context);
  await context.disneyResumeBatch();
  assert.equal(navigations[1], 'https://www.disneyplus.com/browse/entity-series');
  await context.disneyContinueBatch();
  assert.equal(navigations[2], 'https://www.disneyplus.com/play/episode-2');
  assert.equal(delays.at(-1), 5000);
  await context.disneyResumeBatch();
  assert.equal(saved.name, 'Series.zip');
  assert.equal(Object.keys(saved.data).length, 2);
  assert(Object.keys(saved.data).some(name => name.includes('S02E01')));
  assert.equal(state.has('NSD_disney_batch'), false);
  assert.equal(pauses, 4);

  await context.disneyBatch('epub', { mainLang: 'en' });
  assert.equal(navigations[3], 'https://www.disneyplus.com/play/episode-1');
  await context.disneyResumeBatch();
  vm.runInContext('disneyState.transitioning = false', context);
  await context.disneyContinueBatch();
  await context.disneyResumeBatch();
  assert.equal(saved.name, 'Series.epub');
  assert.equal(epubChapters.length, 2);
  assert.equal(state.has('NSD_disney_batch'), false);

  const originalQuery = context.document.querySelectorAll;
  context.document.querySelectorAll = () => [{ href:
    'https://www.disneyplus.com/zh-hant/browse/entity-series' }];
  assert.equal(context.disneyLinkedSeriesId(), 'entity-series');
  context.document.querySelectorAll = originalQuery;
  context.window.navigation = { entries: () => [{ url:
    'https://www.disneyplus.com/zh-hant/browse/entity-series' }] };
  assert.equal(context.disneyLinkedSeriesId(), 'entity-series');
  delete context.window.navigation;

  state.set('NSD_disney_last_series', 'entity-other-series');
  location.assign('https://www.disneyplus.com/play/episode-2');
  let resolvedFromEpisode = false;
  context.disneyApi = async kind => {
    if (kind === 'episodeSeries') resolvedFromEpisode = true;
    return kind === 'episodeSeries' ? { seriesId: 'entity-series',
      catalog: { title: 'Series', episodes: [
        { id: 'episode-1', season: 1, episode: 1 },
        { id: 'episode-2', season: 2, episode: 1 }
      ] } } : { title: 'Other Series', episodes: [{ id: 'unrelated' }] };
  };
  await context.disneyBatch('zip');
  assert.equal(resolvedFromEpisode, true);
  assert.equal(navigations.at(-1), 'https://www.disneyplus.com/play/episode-1');
  state.delete('NSD_disney_batch');

  state.set('NSD_disney_batch', JSON.stringify({ id: 'stalled', kind: 'epub',
    title: 'Series', episodes: [{ id: 'episode-1' }, { id: 'episode-2' }], nextIndex: 1 }));
  location.assign('https://www.disneyplus.com/play/episode-2');
  vm.runInContext('disneyState.tracks = []', context);
  context.disneyWatchBatchPlayback();
  assert(vm.runInContext('disneyState.stalledProgress', context));
});

test('Disney+ EPUB cover uses an image selected from the page', async () => {
  const imageUrl = 'https://disney.images.edge.bamgrid.com/poster.png';
  const context = vm.createContext({ URL, console, atob, Uint8Array,
    location: { href: 'https://www.disneyplus.com/browse/entity-series' },
    sessionStorage: { setItem: noop },
    document: { readyState: 'loading', addEventListener: noop,
      querySelector: () => ({ content: imageUrl }),
      querySelectorAll: () => [], images: [] },
    chrome: { storage: { local: { get: (_, cb) => cb({}) },
      onChanged: { addListener: noop } }, runtime: {
      onMessage: { addListener: noop },
      sendMessage: (_message, cb) => cb({ ok: true,
        mime: 'image/png', base64: Buffer.from([137, 80, 78, 71]).toString('base64') })
    } },
    window: { addEventListener: noop }, setInterval: noop });
  vm.runInContext(source('disney-content.js'), context);
  const candidates = context.disneyCoverCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, imageUrl);
  const cover = await context.disneyCoverData(candidates[0]);
  assert.equal(cover.mediaType, 'image/png');
  assert.deepEqual(Array.from(cover.data), [137, 80, 78, 71]);
});

test('series EPUB language picker lists discovered tracks', async () => {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.style = {};
      this.children = [];
      this.options = [];
      this.isConnected = false;
    }
    appendChild(child) { this.children.push(child); child.isConnected = this.isConnected; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    add(option) { this.options.push(option); }
    addEventListener() {}
    remove() { this.isConnected = false; }
  }
  const body = new Element('body');
  body.isConnected = true;
  const context = vm.createContext({ URL, console,
    Option: function Option(label, value) { this.label = label; this.value = value; },
    location: { href: 'https://www.disneyplus.com/zh-hant/browse/entity-5002284c-af1f-4b2e-a954-fe217793e79a' },
    sessionStorage: { setItem: noop },
    document: { readyState: 'loading', addEventListener: noop, body,
      createElement: tag => new Element(tag), getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [], images: [] },
    chrome: { storage: { local: { get: (_, cb) => cb({}) },
      onChanged: { addListener: noop } }, runtime: { onMessage: { addListener: noop } } },
    window: { addEventListener: noop }, setInterval: noop });
  vm.runInContext(source('disney-content.js'), context);
  vm.runInContext('disneyState.tracks = [{ key: "en", name: "English" }, { key: "zh-Hant", name: "繁體中文" }]', context);
  await context.disneyEpubDialog('series');
  const find = (node, tag) => [node, ...node.children.flatMap(child => find(child, tag))]
    .filter(item => item.tag === tag);
  const selects = find(body, 'select');
  assert.equal(selects.length, 2);
  assert.deepEqual(selects[0].options.map(option => option.value), ['en', 'zh-Hant']);
  assert.deepEqual(selects[1].options.map(option => option.value), ['', 'en', 'zh-Hant']);
  assert.equal(find(body, 'input').filter(input => input.type === 'text').length, 0);
});
