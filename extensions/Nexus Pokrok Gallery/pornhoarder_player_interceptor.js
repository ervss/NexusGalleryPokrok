// PornHoarder Player Interceptor v4 — document_start, hooks jwplayer before it loads
(function() {
    'use strict';
    let reported = false;

    function isSegment(url) {
        return /seg-\d+-v\d+|\.ts(\?|$)|\.m4s(\?|$)|\/segment\//i.test(url);
    }

    function isStream(url) {
        return url && typeof url === 'string' && url.startsWith('http') &&
               (
                 url.includes('.m3u8') ||
                 url.includes('.mp4')  ||
                 url.includes('.mpd')  ||
                 /manifest|playlist|master/i.test(url)
               ) && !isSegment(url);
    }

    function getTopUrl() {
        try { return window.top.location.href; } catch(e) {}
        try { return window.parent.location.href; } catch(e) {}
        return document.referrer || window.location.href;
    }

    function send(streamUrl) {
        if (reported || !streamUrl || isSegment(streamUrl)) return;
        if (!streamUrl.startsWith('http')) return;
        reported = true;
        console.log('[PH v4] STREAM:', streamUrl.slice(0, 120));
        try {
            // Cross-origin provider iframes often cannot call chrome.runtime reliably.
            // Bridge to the top-level watch page interceptor via postMessage.
            const payload = {
                action: 'PH_PLAYER_STREAM',
                pageUrl: getTopUrl(),
                playerUrl: window.location.href,
                streamUrl,
                isHls: streamUrl.includes('.m3u8'),
            };
            if (window.top && window.top !== window) {
                window.top.postMessage(payload, '*');
            } else if (window.parent && window.parent !== window) {
                window.parent.postMessage(payload, '*');
            } else {
                // Fallback for same-origin contexts where runtime is available.
                chrome.runtime.sendMessage(payload);
            }
        } catch(e) { console.warn('[PH v4] send bridge error:', e.message); }
    }

    // ── Hook window.jwplayer before filemoon's JS sets it ──────────────────
    let _jwplayer = undefined;
    Object.defineProperty(window, 'jwplayer', {
        configurable: true,
        get() { return _jwplayer; },
        set(val) {
            _jwplayer = val;
            if (!val || val.__ph) return;
            val.__ph = true;
            // Wrap the function
            const orig = val;
            const wrapped = function(...args) {
                const inst = orig(...args);
                if (!inst) return inst;
                const origSetup = inst.setup?.bind(inst);
                if (origSetup) {
                    inst.setup = function(cfg) {
                        try {
                            const sources = cfg?.playlist?.[0]?.sources || cfg?.sources || [];
                            for (const src of sources) {
                                if (src?.file && isStream(src.file)) { send(src.file); break; }
                            }
                            const file = cfg?.file || cfg?.playlist?.[0]?.file;
                            if (file && isStream(file)) send(file);
                        } catch(e) {}
                        return origSetup(cfg);
                    };
                }
                // Also hook on('ready') and getPlaylistItem
                const origOn = inst.on?.bind(inst);
                if (origOn) {
                    inst.on = function(evt, ...a) {
                        if (evt === 'ready' || evt === 'firstFrame') {
                            try {
                                const item = inst.getPlaylistItem?.() || {};
                                const sources = item.sources || [];
                                for (const s of sources) {
                                    if (s?.file && isStream(s.file)) { send(s.file); break; }
                                }
                            } catch(e) {}
                        }
                        return origOn(evt, ...a);
                    };
                }
                return inst;
            };
            Object.assign(wrapped, orig);
            wrapped.__ph = true;
            _jwplayer = wrapped;
        }
    });

    // ── XHR intercept ───────────────────────────────────────────────────────
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...a) {
        const u = String(url || '');
        if (isStream(u)) send(u);
        // Watch response for embedded URLs (doodstream pass_md5)
        if (u.includes('/pass_md5/') || u.includes('/get_video')) {
            this.addEventListener('load', () => {
                try {
                    const txt = this.responseText || '';
                    if (txt.startsWith('http')) send(txt.trim().split('?')[0]);
                    const m = txt.match(/https?:\/\/[^\s"'<>]+(?:\.(?:mp4|m3u8|mpd)|\/(?:manifest|playlist|master)[^\s"'<>]*)[^\s"'<>]*/i);
                    if (m) send(m[0]);
                } catch(e) {}
            });
        }
        return origOpen.call(this, method, url, ...a);
    };

    // ── fetch intercept ─────────────────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = function(input, ...a) {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (isStream(url)) send(url);
        const p = origFetch.call(this, input, ...a);
        // Check JSON responses for stream URLs
        if (url.includes('/api/') || url.includes('/source') || url.includes('/embed')) {
            p.then(async r => {
                try {
                    const clone = r.clone();
                    const ct = r.headers.get('content-type') || '';
                    if (ct.includes('json') || ct.includes('text')) {
                        const txt = await clone.text();
                        const m = txt.match(/https?:\/\/[^\s"'\\<>]+(?:\.(?:mp4|m3u8|mpd)|\/(?:manifest|playlist|master)[^\s"'\\<>]*)[^\s"'\\<>]*/i);
                        if (m && isStream(m[0])) send(m[0]);
                    }
                } catch(e) {}
            }).catch(() => {});
        }
        return p;
    };

    // ── Poll for video element ──────────────────────────────────────────────
    let ticks = 0;
    const t = setInterval(() => {
        if (++ticks > 200 || reported) return clearInterval(t);
        document.querySelectorAll('video').forEach(v => {
            [v.src, v.currentSrc, ...[...v.querySelectorAll('source')].map(s=>s.src)]
                .filter(Boolean).forEach(u => { if (isStream(u)) send(u); });
        });
    }, 250);

    console.log('[PH v4] active on', window.location.href.slice(0, 80));
})();
