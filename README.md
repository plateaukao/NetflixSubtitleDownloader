# Netflix Subtitle Downloader

A Chrome extension (Manifest V3) that downloads subtitles from Netflix as ZIP or EPUB files with dual-language support.

Based on the [Netflix subtitle downloader](https://greasyfork.org/en/scripts/26654-netflix-subtitle-downloader) userscript by tithen-firion, rewritten as a standalone Chrome extension with no Tampermonkey dependency.

## Features

- **Download subtitles as ZIP** — WebVTT or DFXP format for current episode, season, or all seasons
- **Download as EPUB** — Merge subtitles into an EPUB ebook with dual-language support
  - Main language displayed in normal size
  - Secondary language in smaller gray text below
  - Closed captions `[CC]` styled at reduced size
  - Paragraph breaks for dialogue gaps > 5 seconds
  - Table of Contents with per-episode chapters
- **Batch download** — Automatically navigates through episodes to collect all subtitles
- **Language filtering** — Choose which languages to download
- **Force all languages** — Make Netflix show subtitle tracks for all available languages
- **Preferred locale** — Set a preferred subtitle locale

## Install

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select the `NetflixSubtitleDownloader` folder

## Usage

1. Navigate to Netflix and play a show or movie
2. A menu appears at the top of the page with download options:
   - **Download subs** — Download subtitle files as a ZIP
   - **Download EPUB (this season)** — Generate an EPUB for the current season
   - **Download EPUB (all seasons)** — Generate an EPUB for the entire series
3. For EPUB, a dialog lets you pick the main and optional secondary language
4. Settings are available in the extension popup (click the extension icon)

## Settings (via popup)

| Setting | Description |
|---------|-------------|
| Episode title in filename | Include episode title in downloaded filenames |
| Force all languages | Make Netflix expose all available subtitle tracks |
| Preferred locale | Set a preferred subtitle language (e.g. `ja`, `ko`, `en`) |
| Languages to download | Comma-separated filter (e.g. `en,ja,zh-Hant`) |
| Prefer format | WebVTT or DFXP/XML |
| Batch delay | Delay between page navigations during batch downloads |

## License

MIT
