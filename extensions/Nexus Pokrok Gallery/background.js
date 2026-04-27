const PORTS = [8000, 8001, 8002, 8003, 8004, 8005];

// ── Fix 2: Dashboard URL cache ────────────────────────────────────────────────
// Avoid redundant port-scan on every captured stream. Cache result for 30 s and
// invalidate when the next request to that URL fails.
const DASHBOARD_URL_CACHE_TTL_MS = 30_000;
let _dashboardUrlCache = { url: null, ts: 0 };

async function findDashboardUrl() {
    const now = Date.now();
    if (_dashboardUrlCache.url && (now - _dashboardUrlCache.ts) < DASHBOARD_URL_CACHE_TTL_MS) {
        return _dashboardUrlCache.url;
    }

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

    let found = null;
    if (await check(preferredPort)) {
        found = `http://localhost:${preferredPort}`;
    } else {
        for (const p of PORTS) {
            if (p === preferredPort) continue;
            if (await check(p)) { found = `http://localhost:${p}`; break; }
        }
    }

    const url = found || `http://localhost:${preferredPort}`;
    _dashboardUrlCache = { url, ts: Date.now() };
    return url;
}

function _invalidateDashboardCache() {
    _dashboardUrlCache = { url: null, ts: 0 };
}

// ── Fix 3: Dynamic supported-host list ───────────────────────────────────────
// Hardcoded fallback used until backend responds. Refreshed hourly.
const SUPPORTED_HOSTS_FALLBACK = [
    "recurbate.com", "rec-ur-bate.com", "noodlemagazine.com", "fullporner.com",
    "whoreshub.com", "thots.tv", "vidara.so", "sxyprn.com", "krakenfiles.com",
    "hornysimp.com", "nsfw247.to",
];
let _supportedHosts = new Set(SUPPORTED_HOSTS_FALLBACK);
const SUPPORTED_HOSTS_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function refreshSupportedHosts() {
    try {
        const base = await findDashboardUrl();
        const resp = await fetch(`${base}/api/v1/config/supported_hosts`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (Array.isArray(data.hosts) && data.hosts.length > 0) {
            _supportedHosts = new Set(data.hosts.map(h => h.toLowerCase()));
            console.log(`[StreamCapture] Loaded ${_supportedHosts.size} supported hosts from backend`);
        }
    } catch {
        // Keep existing set — backend may not be running yet
    }
}

function isSupportedHost(url) {
    if (!url) return false;
    try {
        const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
        if (_supportedHosts.has(hostname)) return true;
        // Also check if any entry matches as a suffix (e.g. "nsfw247" matches "nsfw247.to")
        for (const h of _supportedHosts) {
            if (hostname.endsWith(h) || hostname.endsWith(`.${h}`)) return true;
        }
    } catch {
        // Fallback to substring match for non-parseable URLs
        return SUPPORTED_HOSTS_FALLBACK.some(h => url.toLowerCase().includes(h));
    }
    return false;
}

// ── Fix 1: Per-tab stream dedup + storage.local TTL cleanup ──────────────────
// Prevent the same stream URL from being reported multiple times for the same tab.
const _capturedTabStreams = new Map(); // tabId → Set<streamUrlFingerprint>
const STORAGE_KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function _streamFingerprint(streamUrl) {
    // Strip query params (e.g. token/expiry) so the same stream isn't re-reported
    try { return new URL(streamUrl).pathname; } catch { return streamUrl; }
}

function _isAlreadyCaptured(tabId, streamUrl) {
    const fp = _streamFingerprint(streamUrl);
    if (!_capturedTabStreams.has(tabId)) {
        _capturedTabStreams.set(tabId, new Set());
        return false;
    }
    return _capturedTabStreams.get(tabId).has(fp);
}

function _markCaptured(tabId, streamUrl) {
    const fp = _streamFingerprint(streamUrl);
    if (!_capturedTabStreams.has(tabId)) _capturedTabStreams.set(tabId, new Set());
    _capturedTabStreams.get(tabId).add(fp);
}

// Clean up per-tab state when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    _capturedTabStreams.delete(tabId);
});

// Purge stale `captured_*` keys from storage.local on startup
async function purgeStaleStorageKeys() {
    const all = await chrome.storage.local.get(null);
    const staleKeys = [];
    const cutoff = Date.now() - STORAGE_KEY_TTL_MS;
    for (const [key, val] of Object.entries(all)) {
        if (key.startsWith('captured_') && val && typeof val.ts === 'number' && val.ts < cutoff) {
            staleKeys.push(key);
        }
    }
    if (staleKeys.length > 0) {
        await chrome.storage.local.remove(staleKeys);
        console.log(`[StreamCapture] Purged ${staleKeys.length} stale storage keys`);
    }
}

async function reportCapturedStream(pageUrl, streamUrl, title = "", tabId = -1) {
    if (!pageUrl || !streamUrl) return;

    // Fix 1: Skip duplicate reports for the same tab
    if (tabId >= 0 && _isAlreadyCaptured(tabId, streamUrl)) {
        return;
    }
    if (tabId >= 0) _markCaptured(tabId, streamUrl);

    // Store locally for popup to query
    const domain = new URL(pageUrl).hostname.replace('www.', '');
    const key = `captured_${domain}_${pageUrl}`;
    await chrome.storage.local.set({ [key]: { streamUrl, title, ts: Date.now() } });

    // Fix 2: Use cached dashboard URL; invalidate on failure
    const base = await findDashboardUrl();
    try {
        const resp = await fetch(`${base}/api/v1/videos/update_stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_url: pageUrl,
                stream_url: streamUrl,
                source: domain,
                title: title
            }),
        });
        if (!resp.ok) _invalidateDashboardCache();
    } catch (e) {
        console.warn("[StreamCapture] update_stream failed:", e?.message || e);
        _invalidateDashboardCache();
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

// ── Startup tasks ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
    await purgeStaleStorageKeys();
    await refreshSupportedHosts();
});

chrome.runtime.onStartup.addListener(async () => {
    await purgeStaleStorageKeys();
    await refreshSupportedHosts();
});

// Periodic refresh of the supported-hosts list
setInterval(refreshSupportedHosts, SUPPORTED_HOSTS_REFRESH_INTERVAL_MS);

// ── WebRequest stream capture ─────────────────────────────────────────────────
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

        const capturedTabId = details.tabId;
        chrome.tabs.get(capturedTabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return;
            const pageUrl = tab.url || "";
            const title = tab.title || "";
            if (!isSupportedHost(pageUrl)) return;

            // Skip if the media URL itself is just the page (some sites do this)
            if (mediaUrl.split('?')[0] === pageUrl.split('?')[0]) return;

            reportCapturedStream(pageUrl, mediaUrl, title, capturedTabId);
        });
    },
    { urls: ["<all_urls>"] },
    []
);

// ── Message handlers ──────────────────────────────────────────────────────────
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

    // ── Fix 4: PH_PLAYER_STREAM with cross-script race condition guard ────────
    if (msg.action === "PH_PLAYER_STREAM") {
        const pageUrl = String(msg.pageUrl || "").trim();
        const playerUrl = String(msg.playerUrl || "").trim();
        const streamUrl = String(msg.streamUrl || "").trim();
        if (!pageUrl || !streamUrl) {
            sendResponse({ ok: false, error: "missing-page-or-stream" });
            return false;
        }

        // Use sender tab ID (from content script) or fall back to -1
        const senderTabId = sender.tab?.id ?? -1;

        // Guard against duplicate reports from both interceptor scripts for same stream
        if (senderTabId >= 0 && _isAlreadyCaptured(senderTabId, streamUrl)) {
            sendResponse({ ok: true, data: { skipped: true, reason: "already-reported" } });
            return false;
        }
        if (senderTabId >= 0) _markCaptured(senderTabId, streamUrl);

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
            reportCapturedStream(pageUrl, streamUrl, "", senderTabId),
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
