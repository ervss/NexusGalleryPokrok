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
  const base = await findDashboardUrl();
  try {
    await fetch(`${base}/api/v1/videos/update_stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_url: pageUrl,
        stream_url: streamUrl,
        source: "recurbate",
      }),
    });
  } catch (e) {
    console.warn("[RB StreamCapture] update_stream failed:", e?.message || e);
  }
}

function isRecurbateHost(url) {
  return /rec-ur-bate\.com|recurbate\.com/i.test(url || "");
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
      if (!isRecurbateHost(pageUrl)) return;
      if (isRecurbateHost(mediaUrl) && !/\.(mp4|m3u8|mpd)(\?|$)/i.test(mediaUrl)) return;

      reportCapturedStream(pageUrl, mediaUrl);
    });
  },
  { urls: ["<all_urls>"] },
  []
);
