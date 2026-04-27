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

async function reportCapturedStream(pageUrl, streamUrl, title = "") {
    if (!pageUrl || !streamUrl) return;
    
    // Store locally for popup to query
    const domain = new URL(pageUrl).hostname.replace('www.', '');
    const key = `captured_${domain}_${pageUrl}`;
    await chrome.storage.local.set({ [key]: { streamUrl, title, ts: Date.now() } });

    const base = await findDashboardUrl();
    try {
        await fetch(`${base}/api/v1/videos/update_stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_url: pageUrl,
                stream_url: streamUrl,
                source: domain,
                title: title
            }),
        });
    } catch (e) {
        console.warn("[StreamCapture] update_stream failed:", e?.message || e);
    }
}

function getPornHoarderDebugKey() {
    return "ph_debug_latest";
}

function extractPornHoarderVideoId(url) {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\/watch\/([^/?#]+)/i);
        return match ? match[1] : "";
    } catch {
        return "";
    }
}

async function setPornHoarderDebug(data) {
    await chrome.storage.local.set({ [getPornHoarderDebugKey()]: data });
}

function isSupportedHost(url) {
    if (!url) return false;
    return /recurbate\.com|rec-ur-bate\.com|noodlemagazine\.com|fullporner\.com|whoreshub\.com|thots\.tv|vidara\.so|sxyprn\.com|krakenfiles\.com|hornysimp|nsfw247/i.test(url);

}


function isMediaUrl(url) {
    // Also capture JW Player ping URLs which contain the manifest in 'mu' parameter
    if (url && url.includes('ping.gif') && url.includes('mu=')) return true;

    if (/\.(mp4|m3u8|mpd|vid)(\?|$)/i.test(url || "") || /manifest|playlist|master/i.test(url || "")) {
        // Smart filter: Ignore common preview/thumbnail video patterns
        if (/vidthumb|preview|small\.mp4|get_preview/i.test(url)) return false;
        return true;
    }
    return false;
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        let mediaUrl = details.url || "";
        if (!isMediaUrl(mediaUrl)) return;

        // Requests from service workers/background/preloads can have tabId = -1.
        // chrome.tabs.get requires a non-negative tab ID.
        if (!Number.isInteger(details.tabId) || details.tabId < 0) return;

        // Extract real manifest from JW Player ping URL if detected
        if (mediaUrl.includes('ping.gif') && mediaUrl.includes('mu=')) {
            try {
                const muMatch = mediaUrl.match(/[?&]mu=([^&]+)/);
                if (muMatch) {
                    const decoded = decodeURIComponent(muMatch[1]);
                    console.log(`[StreamCapture] Extracted real manifest from ping URL: ${decoded}`);
                    mediaUrl = decoded;
                }
            } catch (e) {
                console.error('[StreamCapture] Failed to parse ping URL', e);
            }
        }

        chrome.tabs.get(details.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return;
            const pageUrl = tab.url || "";
            const title = tab.title || "";
            if (!isSupportedHost(pageUrl)) return;
            
            // Skip if the media URL itself is just the page (some sites do this)
            if (mediaUrl.split('?')[0] === pageUrl.split('?')[0]) return;

            reportCapturedStream(pageUrl, mediaUrl, title);
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

    if (msg.action === "PH_GET_DEBUG") {
        const key = getPornHoarderDebugKey();
        chrome.storage.local.get([key], (res) => {
            sendResponse({ data: res[key] || null });
        });
        return true;
    }

    if (msg.action === "PH_PLAYER_STREAM") {
        const pageUrl = String(msg.pageUrl || "").trim();
        const playerUrl = String(msg.playerUrl || "").trim();
        const streamUrl = String(msg.streamUrl || "").trim();
        if (!pageUrl || !streamUrl) {
            sendResponse({ ok: false, error: "missing-page-or-stream" });
            return false;
        }

        const videoId = extractPornHoarderVideoId(pageUrl);
        const debugData = {
            pageUrl,
            playerUrl,
            streamUrl,
            videoId,
            status: msg.isHls ? "player-hls" : "player-direct",
            source: "ph_player_bridge",
            ts: Date.now(),
        };

        Promise.all([
            reportCapturedStream(pageUrl, streamUrl),
            setPornHoarderDebug(debugData),
        ])
            .then(() => sendResponse({ ok: true, data: debugData }))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
    }

    if (msg.action === "FETCH_EMBED_CORS") {
        const { url, referer } = msg;
        fetch(url, {
            credentials: 'omit',
            headers: referer ? { Referer: referer } : {},
        })
            .then(r => r.ok ? r.text() : null)
            .then(html => sendResponse({ ok: true, html }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (msg.action === "FETCH_HEAD_INFO") {
        const { url, referer } = msg;
        fetch(url, {
            method: 'HEAD',
            credentials: 'omit',
            headers: referer ? { Referer: referer } : {},
        })
            .then(r => sendResponse({
                ok: r.ok,
                status: r.status,
                contentLength: r.headers.get('content-length'),
                contentType: r.headers.get('content-type'),
            }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (msg.action === "BYSE_FETCH") {
        // Fetch bysezoxexe API from background to avoid CORS
        const { apiUrl, referer } = msg;
        fetch(apiUrl, {
            credentials: 'omit',
            headers: {
                'Accept': 'application/json',
                'Referer': referer || 'https://bysezoxexe.com/',
                'Origin': 'https://bysezoxexe.com',
            },
        })
        .then(r => r.ok ? r.json() : null)
        .then(data => sendResponse({ ok: true, data }))
        .catch(() => sendResponse({ ok: false, data: null }));
        return true; // keep channel open for async response
    }
});
