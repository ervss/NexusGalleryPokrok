// PornHoarder interceptor — watches for video stream URLs on watch pages
(function() {
    if (!window.location.href.includes('/watch/')) return;

    const pageUrl = window.location.href;
    let reported = false;
    let relayed = false;
    const TRUSTED_PLAYER_ORIGIN = /https:\/\/(?:[^/]+\.)?(pornhoarder\.(?:io|net|pictures)|filemoon\.sx|dood\.(?:re|wf|cx|sh)|doodstream\.com|voe\.sx|(?:[^/]+\.)?streamtape\.com|(?:[^/]+\.)?lulustream\.com|(?:[^/]+\.)?netu\.ac|bigwarp\.io|398fitus\.com|fullporner\.net)(?::\d+)?$/i;

    async function findDashboardUrl() {
        const stored = await chrome.storage.local.get(['selected_port']);
        const preferred = stored.selected_port || 8000;
        const check = async (p) => {
            try {
                const r = await fetch(`http://localhost:${p}/api/v1/config/gofile_token`,
                    { signal: AbortSignal.timeout(500) }).catch(() => null);
                return r && r.ok;
            } catch { return false; }
        };
        if (await check(preferred)) return `http://localhost:${preferred}`;
        for (const p of [8000,8001,8002,8003,8004,8005]) {
            if (p !== preferred && await check(p)) return `http://localhost:${p}`;
        }
        return `http://localhost:${preferred}`;
    }

    async function reportStreamUrl(streamUrl) {
        if (reported || !streamUrl) return;
        reported = true;
        console.log('[PH Interceptor] Stream URL captured:', streamUrl);
        const domain = new URL(pageUrl).hostname.replace('www.', '').split('.')[0];
        try {
            const base = await findDashboardUrl();
            const res = await fetch(`${base}/api/v1/videos/update_stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_url: pageUrl,
                    stream_url: streamUrl,
                    source: domain,
                    title: document.title || ''
                }),
            });
            const data = await res.json();
            console.log('[PH Interceptor] Nexus response:', data);
        } catch(e) {
            console.warn('[PH Interceptor] Nexus update failed:', e.message);
        }
    }

    // Strategy 1: intercept XMLHttpRequest for video URLs
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (typeof url === 'string' && (/\.(mp4|m3u8|mpd)(\?|$)/i.test(url) || /manifest|playlist|master/i.test(url))) {
            reportStreamUrl(url);
        }
        return origOpen.call(this, method, url, ...args);
    };

    // Strategy 2: intercept fetch for video URLs
    const origFetch = window.fetch;
    window.fetch = function(input, ...args) {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (/\.(mp4|m3u8|mpd)(\?|$)/i.test(url) || /manifest|playlist|master/i.test(url)) {
            reportStreamUrl(url);
        }
        return origFetch.call(this, input, ...args);
    };

    // Strategy 3: watch for <video> element src
    function watchVideo(video) {
        const check = () => {
            const src = video.src || video.currentSrc || '';
            if (src && src.startsWith('http') && !/pornhoarder/i.test(src)) {
                reportStreamUrl(src);
            }
            // Check <source> children
            video.querySelectorAll('source').forEach(s => {
                if (s.src && !/pornhoarder/i.test(s.src)) reportStreamUrl(s.src);
            });
        };
        check();
        video.addEventListener('loadstart', check);
        video.addEventListener('canplay', check);
        new MutationObserver(check).observe(video, { attributes: true, childList: true });
    }

    // Strategy 4: watch DOM for video elements
    new MutationObserver(() => {
        document.querySelectorAll('video').forEach(v => {
            if (!v._phWatched) { v._phWatched = true; watchVideo(v); }
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Check existing
    document.querySelectorAll('video').forEach(v => { v._phWatched = true; watchVideo(v); });

    // Strategy 5: postMessage from iframe
    // Fix 4: relay ALL PH_PLAYER_STREAM messages through the background service worker.
    // The background tracks per-tab reported URLs, so duplicate reports from both
    // pornhoarder_interceptor.js and pornhoarder_player_interceptor.js are silently
    // deduplicated there — no extra round-trip check needed in the content script.
    window.addEventListener('message', (e) => {
        if (!e.data || reported) return;
        if (e.origin && !TRUSTED_PLAYER_ORIGIN.test(e.origin)) return;

        // Structured bridge payload from cross-origin player interceptor
        if (typeof e.data === 'object' && e.data.action === 'PH_PLAYER_STREAM' && e.data.streamUrl) {
            const streamUrl = String(e.data.streamUrl);
            // Avoid duplicate updates: structured bridge should flow through background.
            if (relayed) return;
            relayed = true;
            try {
                chrome.runtime.sendMessage({
                    action: 'PH_PLAYER_STREAM',
                    pageUrl: pageUrl,
                    playerUrl: e.data.playerUrl || '',
                    streamUrl,
                    isHls: !!e.data.isHls,
                }, (response) => {
                    // Background returns {ok: true, data: {skipped: true}} when already
                    // reported — mark local flag so direct fallback is also skipped.
                    if (response?.data?.skipped) reported = true;
                });
                reported = true;
            } catch (err) {
                console.warn('[PH Interceptor] relay sendMessage failed:', err.message);
                // Fallback to direct update only if runtime bridge fails.
                reportStreamUrl(streamUrl);
            }
            return;
        }

        // Backward-compatible regex fallback for old payloads
        const str = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
        const m = str.match(/https?:\/\/[^\s"']+(?:\.(?:mp4|m3u8|mpd)|\/(?:manifest|playlist|master)[^\s"']*)[^\s"']*/i);
        if (m) reportStreamUrl(m[0]);
    });

    console.log('[PH Interceptor] Active on', pageUrl);
})();
