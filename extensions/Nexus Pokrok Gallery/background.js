const PORTS = [8000, 8001, 8002, 8003, 8004, 8005];

async function findDashboardUrl() {
  const stored = await chrome.storage.local.get(["selected_port"]);
  const preferredPort = stored.selected_port || 8000;

  const check = async (port) => {
    try {
      const resp = await fetch(`http://localhost:${port}/api/v1/config/gofile_token`, {
        signal: AbortSignal.timeout(700),
      }).catch(() => null);
      return !!(resp && resp.ok);
    } catch {
      return false;
    }
  };

  if (await check(preferredPort)) return `http://localhost:${preferredPort}`;
  for (const p of PORTS) {
    if (p === preferredPort) continue;
    if (await check(p)) return `http://localhost:${p}`;
  }
  return `http://localhost:${preferredPort}`;
}

async function reportCapturedStream(pageUrl, streamUrl) {
    if (!pageUrl || !streamUrl) return;
    
    // Store locally for popup to query
    const domain = new URL(pageUrl).hostname.replace('www.', '');
    const key = `captured_${domain}_${pageUrl}`;
    await chrome.storage.local.set({ [key]: { streamUrl, ts: Date.now() } });

    const base = await findDashboardUrl();
    try {
        await fetch(`${base}/api/v1/videos/update_stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_url: pageUrl,
                stream_url: streamUrl,
                source: domain,
            }),
        });
    } catch (e) {
        console.warn("[StreamCapture] update_stream failed:", e?.message || e);
    }
}

function isSupportedHost(url) {
    if (!url) return false;
    return /recurbate\.com|rec-ur-bate\.com|noodlemagazine\.com|fullporner\.com|whoreshub\.com|thots\.tv/i.test(url);
}


function isMediaUrl(url) {
    return /\.(mp4|m3u8|mpd)(\?|$)/i.test(url || "") || /manifest|playlist|master/i.test(url || "");
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const mediaUrl = details.url || "";
        if (!isMediaUrl(mediaUrl)) return;

        chrome.tabs.get(details.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return;
            const pageUrl = tab.url || "";
            if (!isSupportedHost(pageUrl)) return;
            
            // Skip if the media URL itself is just the page (some sites do this)
            if (mediaUrl.split('?')[0] === pageUrl.split('?')[0]) return;

            reportCapturedStream(pageUrl, mediaUrl);
        });
    },
    { urls: ["<all_urls>"] },
    []
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "GET_CAPTURED_STREAM") {
        const domain = new URL(msg.pageUrl).hostname.replace('www.', '');
        const key = `captured_${domain}_${msg.pageUrl}`;
        chrome.storage.local.get([key], (res) => {
            sendResponse({ data: res[key] });
        });
        return true;
    }
});
