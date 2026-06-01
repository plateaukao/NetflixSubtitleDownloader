# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome **Manifest V3** extension that downloads Netflix subtitles as a ZIP (WebVTT/DFXP) or as an EPUB ebook with optional dual-language layout. It is a from-scratch rewrite of tithen-firion's [Netflix subtitle downloader](https://greasyfork.org/en/scripts/26654) userscript, with no Tampermonkey dependency.

There is **no build step, no tests, and no package manager**. The repo ships raw JS files loaded directly by Chrome. To develop: edit a file, then reload the unpacked extension at `chrome://extensions` (Developer mode → Load unpacked → select this folder), and reload the Netflix tab. There is nothing to compile or lint.

## Architecture: the three execution contexts

The core design constraint is that Netflix's subtitle track URLs only exist inside data the **page's own JavaScript** processes — they never appear in the DOM. The extension therefore spans three isolated worlds, communicating across the boundaries:

```
inject.js  (PAGE context — same world as Netflix's code)
   │  monkeypatches JSON.parse/stringify, fetch, XHR.open
   │  emits window CustomEvent 'netflix_sub_downloader_data'
   ▼
content.js (CONTENT SCRIPT — isolated world, has chrome.* APIs)
   │  listens for those CustomEvents, caches data, builds UI, does downloads
   │  chrome.runtime messages  ◄──────────────┐
   ▼                                          │
popup.js   (POPUP context — settings + action buttons)
```

- **inject.js** is injected by content.js (it is listed in `web_accessible_resources`) so it runs in the page's JS world. It cannot use `chrome.*`. It intercepts:
  - `JSON.parse` — captures the subtitle manifest (objects with `result.timedtexttracks` + `result.movieId`).
  - `JSON.stringify` — **mutates outgoing requests**: injects all subtitle `profiles` (formats), sets `showAllSubDubTracks` (force-all-languages), and `preferredTextLocale`. This is how "force all languages" works — it rewrites Netflix's own request before it is sent.
  - `XMLHttpRequest.open` + `fetch` — captures `/metadata?` responses (episode/season list, titles, boxart).
  - Reads its settings from **`localStorage`** (keys `NSD_force-all-lang`, `NSD_pref-locale`), NOT `chrome.storage`, because it has no access to `chrome.*`.
- **content.js** is the brain. It holds all caches (`subCache`, `titleCache`, `idOverrides`, `coverImageUrl`), the batch state machines, the on-page hover menu (`#nsd-menu`), the EPUB modal, the progress bars, and all fetch/zip logic. It loads settings from `chrome.storage.local` and mirrors them.
- **popup.js / popup.html** is just a settings editor + a remote control that sends `{action}` messages to content.js (`download`, `downloadSeason`, `downloadAll`, `downloadEpubSeason`, `downloadEpubAll`, `getStatus`).

`manifest.json` injects content scripts at **`document_start`** in this order: `lib/jszip.min.js`, `lib/FileSaver.min.js`, `epub.js`, `content.js`. So `JSZip`, `saveAs`, and all `epub.js` functions are globals available to content.js — they are not modules.

## Batch downloads work by navigating the page

There is no background service worker. A multi-episode download (season / all-seasons / multi-chapter EPUB) is a **state machine persisted in `sessionStorage`** that survives full-page navigations:

1. Build the ordered list of episode IDs from the cached metadata (`batchAll` / `batchSeason` / `batchToEnd`).
2. Process the current episode (fetch its subs, add to the in-progress zip or EPUB chapter list).
3. Save progress to `sessionStorage` (`NSD_zip` + `NSD_batch` for ZIP; `NSD_epub_batch` for EPUB) and `window.location =` the next episode's `/watch/<id>` URL.
4. On the fresh page load, content.js re-reads `sessionStorage`; `processMetadata` → `waitForSubs` detects an in-flight batch and resumes from step 2.

Consequences to keep in mind when editing batch code:
- ZIP state (`NSD_zip`) is the entire zip re-serialized to base64 on every step — large seasons can blow the sessionStorage quota; the code falls back to saving what it has.
- `settings.batchDelay` is the deliberate pause between navigations.
- A click on a progress bar resolves a `STOP` promise (raced against each fetch) to abort.

## Subtitle data model

- `processSubInfo` flattens `timedtexttracks` into `subCache[movieId]` keyed by a composite **language string** like `en`, `en[cc]`, `zh-Hant-forced`, `ja-2`. The suffixes encode track type (`[cc]`, `[<rawType>]`), variant, forced-narrative, and a dedup index. This string is the user-facing identifier everywhere (filenames, EPUB language dropdowns, the `langs` filter setting).
- Each language maps to `{ format: [urls, ext] }` for whichever of the four formats Netflix offered: `imsc1.1`, `dfxp-ls-sdh`, `webvtt-lssdh-ios8`, `simplesdh` (constants `IMSC1_1/DFXP/WEBVTT/SIMPLE` in content.js). Multiple mirror URLs per track; `popRandom` picks one and retries others on failure.
- `idOverrides` handles Netflix serving one `movieId` while the URL shows a different `video_id` (captured from the `id_override` event).

## EPUB generation (epub.js)

Self-contained, ported from a Swift "WebVTTConverter" app. Three stages, all pure functions operating on strings:
1. `parseVTT(text)` → `[{start, end, text}]` in milliseconds. Strips BOM, NOTE/STYLE blocks, and `<...>` cue tags.
2. `mergeSubtitles(mainCaptions, subCaptions)` → an HTML fragment. Single-language wraps each line in `<h3>`. Dual-language interleaves by timestamp with a **400 ms sync threshold**, emits the secondary language in `<div class="sub">` (small gray), `[bracketed]` lines as `<div class="cc">`, and a `<p/>` paragraph break when the gap exceeds **5 s**.
3. `generateEPUB(title, chapters, coverData)` → a `JSZip` of a valid EPUB3 (mimetype, container.xml, content.opf, nav.xhtml ToC, per-chapter xhtml, stylesheet, optional cover). Returns the zip; the caller serializes and `saveAs`-es it.

Cover image: `processMetadata` prefers a **portrait** boxart (book-cover ratio) from the metadata art lists, with fallbacks to the largest art, the Falcor-cache boxart (extracted in inject.js), and finally the `og:image` meta tag. WebP covers are transcoded to JPEG via `OffscreenCanvas` for reader compatibility.

## Conventions

- Everything is plain ES (no modules, no TypeScript, no framework). Cross-file functions are globals by load order.
- All injected DOM/CSS is namespaced with the `nsd-` / `NSD_` prefix to avoid colliding with Netflix.
- When adding a setting, it must be threaded through **all** the places that hold a copy: `DEFAULTS` in popup.js, `settings` in content.js, and — if inject.js needs it — written to `localStorage` as well (chrome.storage is invisible to the page context).
