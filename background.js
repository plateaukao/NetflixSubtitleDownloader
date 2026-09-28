// Disney+ serves playlists and subtitle segments from several CDN domains.
// Content scripts cannot reliably fetch these cross-origin URLs in MV3.
const DISNEY_HOSTS = ['dssott.com', 'dssedge.com', 'disney.com', 'disneyplus.com'];

function isDisneyMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && DISNEY_HOSTS.some(host =>
      url.hostname === host || url.hostname.endsWith('.' + host));
  } catch (_) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.url?.startsWith('https://www.disneyplus.com/')) return;
  const image = message.action === 'disneyImage';
  if (image ? !message.url?.startsWith('https://disney.images.edge.bamgrid.com/')
    : message.action !== 'disneyFetch' || !isDisneyMediaUrl(message.url)) return;

  (async () => {
    try {
      const response = await fetch(message.url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (image) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 10_000_000) throw new Error('Cover image is too large');
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        sendResponse({ ok: true, base64: btoa(binary), mime: response.headers.get('content-type') });
      } else sendResponse({ ok: true, text: await response.text() });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true;
});
