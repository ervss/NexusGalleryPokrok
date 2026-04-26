
let allVideos = [];
let currentlyFilteredVideos = [];
let selectedVideos = new Set();
let duplicateUrls = new Set();   // URLs already in Nexus
let queuedVideos = new Set();    // Watchlist IDs currently shown
const PORTS = [8000, 8001, 8002, 8003, 8004, 8005];
let DASHBOARD_URL = "http://localhost:8000"; // Default
let SELECTED_PORT = 8000;
let DASHBOARD_REACHABLE = false;
let isListView = false;
/** Origin of the Bunkr tab (e.g. https://bunkr.pk) — Referer for CDN thumbs */
let bunkrThumbPageOrigin = null;
let isBackgroundResolving = false;

function isLeakLikeUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'leakporner.com' || host.endsWith('.leakporner.com') || host === 'djav.org' || host.endsWith('.djav.org');
    } catch {
        return /(?:leakporner\.com|djav\.org)/i.test(String(url || ''));
    }
}

function isDjavUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'djav.org' || host.endsWith('.djav.org');
    } catch {
        return /(?:^|\.)djav\.org/i.test(String(url || ''));
    }
}

function normalizeHostName(value) {
    if (!value) return '';
    const raw = String(value).trim().toLowerCase();
    if (!raw) return '';

    if (raw.startsWith('blob:')) {
        try {
            return normalizeHostName(new URL(raw.slice(5)).hostname);
        } catch {
            return '';
        }
    }

    const stripped = raw
        .replace(/^[a-z]+:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '')
        .replace(/^www\./, '');

    const parts = stripped.split('.').filter(Boolean);
    if (parts.length >= 3 && /^(?:www|m|amp|cdn\d*|cache\d*|img\d*|media\d*|static\d*|video\d*|v\d+|w\d+)$/i.test(parts[0])) {
        return parts.slice(1).join('.');
    }

    return stripped;
}

function looksLikeHostname(value) {
    const host = normalizeHostName(value);
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return false;
    // Host filter should represent real domains/IPs, not source labels like "leakporner".
    if (host.includes('.')) return true;
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function getPageHost(video) {
    if (!video) return '';
    const candidates = [
        video.source_url,
        video.sourceUrl,
        video.sourceURL,
        video.page_url,
        video.pageUrl,
    ];
    for (const candidate of candidates) {
        const host = normalizeHostName(candidate);
        if (host) return host;
    }
    return '';
}

function getVideoHost(video) {
    if (!video) return '';

    const explicitCandidates = [
        video.playback_host,
        video.stream_host,
        video.host,
        video.hosting,
        video.provider,
        video.source_host,
        video.site_host,
        video.site,
        video.source_site,
    ];
    for (const candidate of explicitCandidates) {
        if (looksLikeHostname(candidate)) return normalizeHostName(candidate);
    }

    const pageHost = getPageHost(video);
    const candidates = [
        video.directUrl,
        video.direct_url,
        video.url,
        video.stream_url,
        video.source_url,
        video.sourceUrl,
        video.sourceURL,
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            const normalized = String(candidate).trim();
            const host = normalizeHostName(
                normalized.startsWith('blob:')
                    ? new URL(normalized.slice(5)).hostname
                    : new URL(normalized, location.href).hostname
            );
            if (host && looksLikeHostname(host)) {
                if (pageHost && host === pageHost) continue;
                return host;
            }
        } catch {
            const host = normalizeHostName(candidate);
            if (looksLikeHostname(host) && host !== pageHost) return host;
        }
    }

    return pageHost || '';
}

function refreshHostFilterOptions() {
    const select = document.getElementById('hosting-filter');
    if (!select) return;

    const current = select.value || 'all';
    const hosts = [...new Set(allVideos.map(v => getVideoHost(v)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));

    select.innerHTML = `
        <option value="all">Všetky hosty</option>
        ${hosts.map(host => `<option value="${host}">${host}</option>`).join('')}
    `;

    select.value = hosts.includes(current) ? current : 'all';
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('find-direct-btn')?.addEventListener('click', () => {
        startBackgroundResolution();
    });
});


// ── CACHE (pageUrl -> videoData) ─────────────────────────────────────────────
async function saveToCache(url, videos) {
    if (!url || !videos || videos.length === 0) return;
    try {
        const key = `qe_cache_${url.split(/[?#]/)[0]}`;
        const data = {
            timestamp: Date.now(),
            videos: videos.map(v => ({...v})) 
        };
        
        const store = await chrome.storage.local.get(null);
        const cacheKeys = Object.keys(store).filter(k => k.startsWith('qe_cache_'));
        
        if (cacheKeys.length >= 20) {
            const sorted = cacheKeys.sort((a, b) => (store[a].timestamp || 0) - (store[b].timestamp || 0));
            await chrome.storage.local.remove(sorted[0]);
        }
        
        await chrome.storage.local.set({ [key]: data });
    } catch (e) { console.error("Cache save failed", e); }
}

async function loadFromCache(url) {
    try {
        const key = `qe_cache_${url.split(/[?#]/)[0]}`;
        const res = await chrome.storage.local.get(key);
        const data = res[key];
        if (data && (Date.now() - data.timestamp < 3600000 * 2)) { // 2 hour TTL
            return data.videos;
        }
    } catch (e) { console.error("Cache load failed", e); }
    return null;
}

// ── WATCHLIST (persistent via localStorage) ─────────────────────────────────
function wlLoad() {
    try { return JSON.parse(localStorage.getItem('qe_watchlist') || '[]'); } catch { return []; }
}
function wlSave(list) {
    try { localStorage.setItem('qe_watchlist', JSON.stringify(list)); } catch {}
}
function wlAdd(videos) {
    const list = wlLoad();
    const existing = new Set(list.map(v => v.id));
    let added = 0;
    videos.forEach(v => {
        if (!existing.has(v.id)) { list.push(v); existing.add(v.id); added++; }
    });
    wlSave(list);
    renderWatchlist();
    return added;
}
function wlRemove(id) {
    wlSave(wlLoad().filter(v => v.id !== id));
    queuedVideos.delete(id);
    renderWatchlist();
    renderGrid(currentlyFilteredVideos);
}
function wlClear() {
    wlSave([]);
    queuedVideos.clear();
    renderWatchlist();
    renderGrid(currentlyFilteredVideos);
}

function renderWatchlist() {
    const list = wlLoad();
    const panel = document.getElementById('watchlist-panel');
    const empty = document.getElementById('wl-empty');
    const badge = document.getElementById('wl-count-badge');
    if (badge) badge.textContent = list.length;

    // Sync queuedVideos
    queuedVideos = new Set(list.map(v => v.id));

    if (!panel) return;
    // Remove all items except empty message
    Array.from(panel.querySelectorAll('.wl-item')).forEach(el => el.remove());
    if (empty) empty.style.display = list.length === 0 ? 'block' : 'none';

    list.forEach(v => {
        const item = document.createElement('div');
        item.className = 'wl-item';
        item.innerHTML = `
            <img class="wl-thumb" src="${v.thumbnail || ''}" referrerpolicy="no-referrer"
                 onerror="this.style.background='#1a1a3a';this.style.display='block'">
            <div class="wl-info">
                <div class="wl-title" title="${v.title}">${v.title}</div>
                <div class="wl-meta">${v.quality || 'HD'}${v.duration ? ' · ' + formatTime(v.duration) : ''}${v.size ? ' · ' + (v.size/1048576).toFixed(1) + ' MB' : ''}</div>
            </div>
            <button class="wl-import-btn" data-id="${v.id}">Import</button>
            <button class="wl-remove" title="Odstrániť" data-id="${v.id}">✕</button>
        `;
        item.querySelector('.wl-remove').onclick = (e) => { e.stopPropagation(); wlRemove(v.id); };
        item.querySelector('.wl-import-btn').onclick = (e) => {
            e.stopPropagation();
            importVideos([v], `Watchlist: ${v.title}`);
        };
        panel.appendChild(item);
    });
}

// ── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}

// ── PROGRESS BAR ─────────────────────────────────────────────────────────────
function setProgress(pct) {
    const wrap = document.getElementById('progress-bar-wrap');
    const bar  = document.getElementById('progress-bar');
    if (!wrap || !bar) return;
    if (pct === null) { wrap.style.display = 'none'; bar.style.width = '0%'; return; }
    wrap.style.display = 'block';
    bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

// ── TOAST ────────────────────────────────────────────────────────────────────
function showToast(html, durationMs = 4000) {
    const t = document.getElementById('import-toast');
    if (!t) return;
    t.innerHTML = html;
    t.style.display = 'block';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => { t.style.display = 'none'; }, durationMs);
}

function fmtClock(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleTimeString();
    } catch {
        return '';
    }
}

async function refreshPhDebug() {
    const box = document.getElementById('ph-debug');
    if (!box) return;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const isPh = !!(tab?.url && /pornhoarder\.(io|net|pictures)\//i.test(tab.url));
        if (!isPh) {
            box.style.display = 'none';
            return;
        }
        box.style.display = 'block';
        const resp = await chrome.runtime.sendMessage({ action: 'PH_GET_DEBUG' });
        const dbg = resp?.data;
        if (!dbg) {
            box.textContent = 'PH debug: zatiaľ bez zachyteného streamu.';
            return;
        }
        const shortStream = (dbg.streamUrl || '').slice(0, 72);
        const at = fmtClock(dbg.ts);
        box.textContent = `PH debug [${at}] ${dbg.status || 'unknown'} | source=${dbg.source || '-'} | videoId=${dbg.videoId || '-'} | ${shortStream}`;
    } catch (e) {
        box.style.display = 'block';
        box.textContent = `PH debug error: ${e.message || 'unknown'}`;
    }
}

// ── CHUNKED IMPORT ───────────────────────────────────────────────────────────
const CHUNK_SIZE = 50;
async function importVideos(videos, batchName) {
    if (!videos || videos.length === 0) return;
    const importBtn = document.getElementById('import-btn');
    if (importBtn) { importBtn.disabled = true; importBtn.innerText = 'Importujem…'; }

    const toImport = videos.map(v => ({
        title: v.title,
        url: v.directUrl || v.url,
        source_url: v.source_url || v.url,
        thumbnail: v.thumbnail || null,
        filesize: v.size || v.filesize || 0,
        quality: v.quality || 'HD',
        duration: typeof v.duration === 'number' ? v.duration : parseDuration(v.duration),
    }));

    let imported = 0, errors = 0, dups = 0;
    const total = toImport.length;
    const chunks = [];
    for (let i = 0; i < toImport.length; i += CHUNK_SIZE) chunks.push(toImport.slice(i, i + CHUNK_SIZE));

    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        setProgress(Math.round((ci / chunks.length) * 100));
        const statsEl = document.getElementById('stats-text');
        if (statsEl) statsEl.innerText = `Importujem ${Math.min((ci+1)*CHUNK_SIZE, total)}/${total}…`;
        try {
            const resp = await fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_name: batchName || 'Quantum Import', videos: chunk }),
            });
            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                imported += data.imported ?? chunk.length;
                errors   += data.errors   ?? 0;
                dups     += data.duplicates ?? 0;
            } else {
                errors += chunk.length;
            }
        } catch (e) {
            console.error('import chunk failed', e);
            errors += chunk.length;
        }
    }

    setProgress(null);
    updateStats();

    const parts = [`✅ ${imported} importovaných`];
    if (dups)    parts.push(`⚠️ ${dups} duplikátov`);
    if (errors)  parts.push(`❌ ${errors} chýb`);
    showToast(parts.join('&nbsp;&nbsp;'), 5000);
    console.log(`Import done: imported=${imported} dups=${dups} errors=${errors}`);
}

// ── DUPLICATE CHECK ──────────────────────────────────────────────────────────
async function checkDuplicates(videos) {
    duplicateUrls.clear();
    const dupStatsEl = document.getElementById('dup-stats');
    if (dupStatsEl) dupStatsEl.style.display = 'none';
    if (!videos || videos.length === 0) return;
    try {
        const urls = videos.map(v => v.url).filter(Boolean);
        const resp = await fetch(`${DASHBOARD_URL}/api/v1/videos/exists`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls }),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        // Expected: { existing: ["url1", "url2", ...] }
        const existing = data.existing || data.urls || data.data || [];
        existing.forEach(u => duplicateUrls.add(u));
        if (duplicateUrls.size > 0 && dupStatsEl) {
            dupStatsEl.style.display = 'inline';
            dupStatsEl.innerText = `⚠ ${duplicateUrls.size} duplikátov`;
        }
    } catch (e) {
        console.warn('Duplicate check failed (endpoint may not exist):', e.message);
    }
}


function isBunkrHost(url) {
    if (!url) return false;
    try {
        const h = new URL(url).hostname.toLowerCase();
        return h.includes('bunkr');
    } catch {
        return url.toLowerCase().includes('bunkr');
    }
}

/** Album / file pages on Bunkr */
function isBunkrExplorerUrl(url) {
    if (!isBunkrHost(url)) return false;
    const p = url.split(/[?#]/)[0].toLowerCase();
    return /\/a\/[^/]+/.test(p) || p.includes('/album/') || /\/(f|v)\/[^/]+/.test(p);
}

/** Detects any Filester domain variant */
function isFilesterHost(url) {
    if (!url) return false;
    try {
        const h = new URL(url).hostname.toLowerCase();
        return h === 'filester.me' || h === 'filester.gg' || h === 'filester.net' ||
               h === 'filester.co' || h === 'filester.org' || h === 'filester.io' ||
               h.endsWith('.filester.me') || h.endsWith('.filester.gg');
    } catch {
        return url.toLowerCase().includes('filester.');
    }
}

function isRecurbateUrl(url) {
    if (!url) return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host.includes('rec-ur-bate.com') || host.includes('recurbate.com');
    } catch {
        return /rec-ur-bate\.com|recurbate\.com/i.test(url);
    }
}

function isWhoresHubUrl(url) {
    if (!url) return false;
    try {
        const h = new URL(url).hostname.toLowerCase();
        return h === 'whoreshub.com' || h === 'www.whoreshub.com';
    } catch {
        return /whoreshub\.com/i.test(url);
    }
}

function isThotsTvUrl(url) {
    if (!url) return false;
    try {
        const h = new URL(url).hostname.toLowerCase();
        return h === 'thots.tv' || h === 'www.thots.tv';
    } catch {
        return /thots\.tv/i.test(url);
    }
}

function extractDirectVideoUrlFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const v = doc.querySelector('video source[src], video[src]');
    if (v && v.getAttribute('src')) {
        let s = v.getAttribute('src');
        if (s && !s.startsWith('blob:')) {
            if (s.startsWith('//')) s = 'https:' + s;
            return s;
        }
    }
    const vid = doc.querySelector('video');
    if (vid && vid.getAttribute('src') && !vid.src.startsWith('blob:')) {
        let s = vid.getAttribute('src');
        if (s.startsWith('//')) s = 'https:' + s;
        return s;
    }
    const mediaRegex = /https?:\/\/[a-zA-Z0-9-.]+\.[a-z]{2,}\/[^"'\\\s<>]+\.(mp4|mkv|m4v|mov)(?:\?[^"'\\\s<>]*)?/gi;
    const matches = html.match(mediaRegex);
    if (matches) {
        const filtered = matches.filter((m) => !/logo|favicon|thumb|preview|maint\.mp4|maintenance/i.test(m));
        if (filtered.length) return filtered[0];
    }
    return null;
}

async function bunkrApiResolve(dataId) {
    if (!dataId) return null;
    const id = String(dataId).trim();
    const referer = `https://get.bunkrr.su/file/${id}`;
    try {
        const res = await fetch('https://apidl.bunkr.ru/api/_001_v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Referer: referer,
                Origin: 'https://get.bunkrr.su',
            },
            body: JSON.stringify({ id }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.encrypted) return null;
        if (data.url) {
            let u = data.url;
            if (u.startsWith('//')) u = 'https:' + u;
            return u;
        }
    } catch (e) {
        console.warn('bunkrApiResolve', e);
    }
    return null;
}

async function bunkrFetchPageExtract(pageUrl) {
    try {
        const res = await fetch(pageUrl, { credentials: 'include' });
        const html = await res.text();
        return extractDirectVideoUrlFromHtml(html);
    } catch (e) {
        console.warn('bunkrFetchPageExtract', pageUrl, e);
        return null;
    }
}

const BUNKR_PLACEHOLDER_IMG =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25' viewBox='0 0 1 1'%3E%3Crect fill='%231a1a3a' x='0' y='0' width='1' height='1'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%23555' font-family='sans-serif' font-size='0.2' %3ENO IMG%3C/text%3E%3C/svg%3E";

/**
 * Bunkr CDNs often reject requests without Referer from the album origin.
 * Popup + no-referrer breaks thumbs; fetch as blob with Referer (needs host access to thumb host).
 */
function loadBunkrThumbnail(img, thumbUrl, pageOrigin) {
    const ref = pageOrigin || bunkrThumbPageOrigin || 'https://bunkr.pk';
    if (!thumbUrl || !/^https?:\/\//i.test(thumbUrl)) {
        img.src = BUNKR_PLACEHOLDER_IMG;
        return;
    }
    img.src = BUNKR_PLACEHOLDER_IMG;
    fetch(thumbUrl, {
        headers: {
            Referer: ref.endsWith('/') ? ref : ref + '/',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        credentials: 'omit',
    })
        .then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            return res.blob();
        })
        .then((blob) => {
            img.src = URL.createObjectURL(blob);
        })
        .catch(() => {
            img.referrerPolicy = 'strict-origin-when-cross-origin';
            img.src = thumbUrl;
            img.onerror = () => {
                img.onerror = null;
                img.src = BUNKR_PLACEHOLDER_IMG;
            };
        });
}

/**
 * Recurbate thumbnails can block hotlink requests without a site referer.
 * Load through fetch+blob first with Recurbate referer, then fallback to direct src.
 */
function loadRecurbateThumbnail(img, thumbUrl) {
    const ref = 'https://rec-ur-bate.com/';
    if (!thumbUrl || !/^https?:\/\//i.test(thumbUrl)) {
        img.src = BUNKR_PLACEHOLDER_IMG;
        return;
    }
    img.src = BUNKR_PLACEHOLDER_IMG;
    fetch(thumbUrl, {
        headers: {
            Referer: ref,
            Origin: 'https://rec-ur-bate.com',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        credentials: 'omit',
    })
        .then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            return res.blob();
        })
        .then((blob) => {
            img.src = URL.createObjectURL(blob);
        })
        .catch(() => {
            img.referrerPolicy = 'strict-origin-when-cross-origin';
            img.src = thumbUrl;
            img.onerror = () => {
                img.onerror = null;
                img.src = BUNKR_PLACEHOLDER_IMG;
            };
        });
}

function proxifyThumbnail(url) {
    if (!url || typeof url !== 'string') return '';
    if (url.startsWith('data:')) return url;
    if (url.startsWith('blob:')) return url;
    if (url.startsWith('/')) return url;
    const cleaned = String(url).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return '';
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(cleaned)) return '';
    if (!DASHBOARD_REACHABLE) return url;
    if (/^https?:\/\//i.test(url)) {
        return `${DASHBOARD_URL}/api/v1/proxy?url=${encodeURIComponent(url)}`;
    }
    return url;
}

/** Runs in page context — must stay self-contained (Chrome serialization). */
function bunkrAlbumProbe() {
    const origin = location.origin;
    const albumUrl = location.href.split(/[?#]/)[0];
    const og = document.querySelector('meta[property="og:title"]');
    const albumTitle = (og && og.getAttribute('content')) || document.title || 'Bunkr';
    const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)(\?|$)/i;
    const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(\?|$)/i;

    function parseSizeToBytes(v) {
        if (v == null || v === '') return 0;
        if (typeof v === 'number' && !isNaN(v)) {
            return v;
        }
        const s = String(v).trim().replace(',', '.');
        const m = s.match(/([\d.]+)\s*(TB|GB|MB|KB|B)\b/i);
        if (m) {
            const n = parseFloat(m[1]);
            const u = (m[2] || 'B').toUpperCase();
            const mult = { B: 1, KB: 1024, MB: 1024 * 1024, GB: Math.pow(1024, 3), TB: Math.pow(1024, 4) };
            return Math.round(n * (mult[u] || 1));
        }
        const plain = parseInt(s, 10);
        return isNaN(plain) ? 0 : plain;
    }

    function guessQuality(name) {
        const t = String(name || '').toUpperCase();
        if (/\b(4K|2160P|UHD)\b/.test(t)) return '4K';
        if (/\b(1440P|2K)\b/.test(t)) return '1440p';
        if (/\b(1080P|FHD|FULL[\s_-]?HD)\b/.test(t)) return '1080p';
        if (/\b(720P)\b/.test(t)) return '720p';
        if (/\b(480P|SD)\b/.test(t)) return '480p';
        if (/\b(360P)\b/.test(t)) return '360p';
        return 'HD';
    }

    function normalizeThumb(u) {
        if (!u || typeof u !== 'string') return '';
        var t = u.trim();
        if (t.startsWith('//')) t = 'https:' + t;
        if (t.startsWith('/') && !t.startsWith('//')) t = origin + t;
        return t;
    }

    /** Same file row as the page uses (scheme + host + path). */
    function canonPageUrl(u) {
        if (!u) return '';
        try {
            var x = new URL(u, origin);
            var p = x.pathname;
            if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
            return x.origin + p;
        } catch (e) {
            return String(u).split(/[?#]/)[0];
        }
    }

    /** Wrapper for one grid cell: prefer ancestor with exactly one file link. */
    function cardForFileAnchor(a) {
        var el = a.parentElement;
        var best = null;
        var d;
        for (d = 0; d < 16 && el; d++) {
            var n = el.querySelectorAll('a[href*="/f/"], a[href*="/v/"]').length;
            if (n === 1) best = el;
            el = el.parentElement;
        }
        if (best) return best;
        el = a.parentElement;
        for (d = 0; d < 6 && el; d++) {
            if (el.querySelector('img') && el.querySelectorAll('a[href*="/f/"], a[href*="/v/"]').length <= 4) return el;
            el = el.parentElement;
        }
        return a.parentElement;
    }

    function imgSrcFromEl(img) {
        if (!img) return '';
        return (
            img.getAttribute('data-src') ||
            img.getAttribute('data-lazy-src') ||
            img.getAttribute('data-original') ||
            img.getAttribute('data-zoom') ||
            img.getAttribute('srcset') ||
            img.currentSrc ||
            img.src ||
            ''
        );
    }

    function isUsableThumbSrc(src) {
        if (!src || src.indexOf('data:') === 0) return false;
        if (/spinner|blank\.(gif|png)|1x1|pixel\.gif/i.test(src)) return false;
        return true;
    }

    /** Bunkr often puts a generic camera/SVG first; real preview is usually poster or CDN thumb. */
    function thumbUrlScore(src) {
        if (!src) return -1000;
        var u = src.toLowerCase();
        var sc = 0;
        if (/thumb|preview|poster|cdn|media-files|get\.bunkr|scdn|\.jpe?g|\.webp|\.png/i.test(u)) sc += 25;
        if (/width=\d{2,3}\b|height=\d{2,3}\b|-200x|-400x/i.test(u)) sc += 15;
        if (/icon|camera|favicon|logo\.svg|\/icons\/|placeholder|video-icon|default.*thumb|no-?preview/i.test(u)) sc -= 80;
        if (/\.svg(\?|$)/i.test(u)) sc -= 40;
        if (u.indexOf('data:') === 0) sc -= 100;
        return sc;
    }

    function bestThumbFromCandidates(arr) {
        var best = '';
        var bestSc = -9999;
        var j;
        for (j = 0; j < arr.length; j++) {
            var raw = arr[j];
            if (!raw) continue;
            var one = String(raw).split(',')[0].trim();
            if (!isUsableThumbSrc(one)) continue;
            var sc = thumbUrlScore(one);
            if (sc > bestSc) {
                bestSc = sc;
                best = one;
            }
        }
        /* Reject generic-only (camera icon ~ -80); real CDN/poster is usually >= 0 */
        return bestSc >= 0 ? normalizeThumb(best) : '';
    }

    /** Thumbnail for this file only — pick best-scoring poster/img (not first = not camera icon). */
    function pickThumbForFileLink(fileAnchor, card) {
        var candidates = [];
        var imgs;
        var i;
        var img;
        var vids;
        var s;
        if (card) {
            vids = card.querySelectorAll('video[poster]');
            for (i = 0; i < vids.length; i++) {
                s = vids[i].getAttribute('poster');
                if (s) candidates.push(s);
            }
        }
        if (fileAnchor) {
            imgs = fileAnchor.querySelectorAll('img');
            for (i = 0; i < imgs.length; i++) {
                s = imgSrcFromEl(imgs[i]);
                if (s) candidates.push(s);
            }
            img = fileAnchor.previousElementSibling;
            if (img && img.tagName === 'IMG') candidates.push(imgSrcFromEl(img));
        }
        if (card) {
            imgs = card.querySelectorAll('img');
            for (i = 0; i < imgs.length; i++) {
                s = imgSrcFromEl(imgs[i]);
                if (s) candidates.push(s);
            }
            var ps = card.querySelector('picture source[srcset], picture source[src]');
            if (ps) {
                var ss = ps.getAttribute('srcset') || ps.getAttribute('src') || '';
                if (ss) candidates.push(ss.split(',')[0].trim().split(/\s+/)[0]);
            }
            var styled = card.querySelector('[style*="background-image"]');
            if (styled && styled.style && styled.style.backgroundImage) {
                var m = styled.style.backgroundImage.match(/url\(["']?([^"')]+)/i);
                if (m) candidates.push(m[1]);
            }
        }
        return bestThumbFromCandidates(candidates);
    }

    function parseCardMeta(blob) {
        var out = { size: 0, timestamp: '' };
        if (!blob) return out;
        var sm = blob.match(/(\d+\.?\d*)\s*(TB|GB|MB|KB)\b/i);
        if (sm) out.size = parseSizeToBytes(sm[1] + sm[2]);
        var dm = blob.match(/\d{1,2}:\d{2}:\d{2}\s+\d{2}\/\d{2}\/\d{4}/);
        if (dm) out.timestamp = dm[0];
        return out;
    }

    function rowFromAlbumFile(f) {
        const nameRaw = f.original != null ? f.original : f.name;
        const name = typeof nameRaw === 'string' ? nameRaw : '';
        if (name && IMAGE_EXT.test(name) && !VIDEO_EXT.test(name)) return null;
        const id = f.id != null ? String(f.id) : '';
        const slug = f.slug != null ? String(f.slug) : '';
        if (!slug && !id) return null;
        let pageUrl = f.url;
        if (!pageUrl && slug) pageUrl = origin + '/f/' + slug;
        if (!pageUrl && id) pageUrl = origin + '/f/' + id;
        pageUrl = canonPageUrl(pageUrl);
        let size = parseSizeToBytes(f.size);
        const ts = f.timestamp || f.date || f.time || '';
        const title = name || slug || id || 'video';
        const thumbRaw = f.thumbnail || f.thumb || f.preview || f.poster || f.image || '';
        return {
            id: id || slug,
            title: title,
            pageUrl: pageUrl,
            size: size,
            timestamp: ts,
            dataId: id || slug,
            source_url: albumUrl,
            thumbnail: normalizeThumb(thumbRaw),
            quality: guessQuality(title),
        };
    }

    function enrichRowsFromDom(rows) {
        var map = {};
        var i;
        for (i = 0; i < rows.length; i++) {
            var key = canonPageUrl(rows[i].pageUrl);
            map[key] = rows[i];
        }
        document.querySelectorAll('a[href*="/f/"], a[href*="/v/"]').forEach(function (a) {
            var href = canonPageUrl(a.href);
            var r = map[href];
            if (!r) return;
            var card = cardForFileAnchor(a);
            var t = pickThumbForFileLink(a, card);
            if (t) {
                var prevT = r.thumbnail || '';
                if (!prevT || thumbUrlScore(t) >= thumbUrlScore(prevT)) r.thumbnail = t;
            }
            var meta = parseCardMeta(card ? card.innerText : '');
            if ((!r.size || r.size === 0) && meta.size) r.size = meta.size;
            if (!r.timestamp && meta.timestamp) r.timestamp = meta.timestamp;
            if (!r.quality) r.quality = guessQuality(r.title);
        });
        return rows;
    }

    let rows = [];
    if (Array.isArray(window.albumFiles) && window.albumFiles.length) {
        rows = window.albumFiles.map(rowFromAlbumFile).filter(Boolean);
    }

    if (rows.length === 0) {
        var seen = {};
        document.querySelectorAll('a[href*="/f/"], a[href*="/v/"]').forEach(function (a) {
            var href = canonPageUrl(a.href);
            if (seen[href]) return;
            seen[href] = true;
            var m = href.match(/\/(f|v)\/([^/?#]+)/);
            if (!m) return;
            var card = cardForFileAnchor(a);
            var title = (card && card.innerText) ? card.innerText.trim().split('\n')[0] : m[2];
            var fidEl = a.closest('[data-file-id]');
            var dataId = fidEl ? fidEl.getAttribute('data-file-id') : '';
            var meta = parseCardMeta(card ? card.innerText : '');
            rows.push({
                id: m[2],
                title: (title || m[2]).slice(0, 240),
                pageUrl: href,
                size: meta.size || 0,
                timestamp: meta.timestamp || '',
                dataId: dataId || m[2] || '',
                source_url: albumUrl,
                thumbnail: pickThumbForFileLink(a, card),
                quality: guessQuality(title || m[2]),
            });
        });
    }

    if (rows.length > 0) {
        rows = enrichRowsFromDom(rows);
    }

    if (rows.length === 0) {
        var path = location.pathname;
        var single = path.match(/^\/(f|v)\/([^/?#]+)/);
        if (single) {
            var df = document.querySelector('[data-file-id]');
            var did = df ? df.getAttribute('data-file-id') : '';
            var ogImg = document.querySelector('meta[property="og:image"]');
            var ogThumb = ogImg ? ogImg.getAttribute('content') : '';
            rows = [
                {
                    id: single[2],
                    title: albumTitle.replace(/\s*[-|]\s*bunkr.*$/i, '').trim() || single[2],
                    pageUrl: albumUrl,
                    size: 0,
                    timestamp: '',
                    dataId: did || single[2] || '',
                    source_url: albumUrl,
                    thumbnail: normalizeThumb(ogThumb),
                    quality: guessQuality(albumTitle),
                },
            ];
        }
    }

    return { albumTitle: albumTitle, rows: rows, origin: origin };
}

/** Filester Universal Probe — handles /d/ID single file AND /f/ID folder pages */
function filesterProbe() {
    const origin = location.origin;
    const pageUrl = location.href.split(/[?#]/)[0];
    const pathname = location.pathname;

    function parseSize(s) {
        if (!s) return 0;
        const m = String(s).match(/([\d.]+)\s*(TB|GB|MB|KB|B)\b/i);
        if (m) {
            const n = parseFloat(m[1]);
            const u = (m[2] || 'B').toUpperCase();
            const mult = { B: 1, KB: 1024, MB: 1024 * 1024, GB: Math.pow(1024, 3), TB: Math.pow(1024, 4) };
            return Math.round(n * (mult[u] || 1));
        }
        return 0;
    }

    function parseDuration(text) {
        if (!text) return 0;
        const p = String(text).trim().split(':').map(Number);
        if (p.some(isNaN)) return 0;
        if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
        if (p.length === 2) return p[0] * 60 + p[1];
        return 0;
    }

    function guessQuality(name) {
        const t = String(name || '').toUpperCase();
        if (/\b(4K|2160P|UHD)\b/.test(t)) return '4K';
        if (/\b(1440P|2K)\b/.test(t)) return '1440p';
        if (/\b(1080P|FHD)\b/.test(t)) return '1080p';
        if (/\b(720P)\b/.test(t)) return '720p';
        if (/\b(480P)\b/.test(t)) return '480p';
        if (/\b(360P)\b/.test(t)) return '360p';
        return 'HD';
    }

    function cleanTitle(raw) {
        return (raw || '').replace(/\s*[\|\-]\s*filester\.\w+.*/i, '').trim();
    }

    // Size from a SINGLE element's text (not entire body — avoids summing all file sizes)
    function sizeFromEl(el) {
        if (!el) return 0;
        return parseSize(el.innerText || el.textContent || '');
    }

    const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)(\?|$)/i;
    const rows = [];

    // ==========================================================================
    // STRATEGY 1: Single FILE page — ONLY /d/ID (download/file direct link)
    // NOTE: /f/ID is a FOLDER page, NOT a single file!
    // ==========================================================================
    const isSingleFile = /^\/d\/([^/?#]+)/.test(pathname);
    if (isSingleFile) {
        const fileId = pathname.match(/^\/d\/([^/?#]+)/)[1];

        // Title — document.title: "filename.mp4 | filester.gg"
        let title = cleanTitle(document.title);

        // Fallback: og:title
        if (!title || /filester/i.test(title)) {
            const og = document.querySelector('meta[property="og:title"]');
            if (og) title = cleanTitle(og.getAttribute('content') || '');
        }

        // Fallback: first non-brand heading
        if (!title || /filester/i.test(title)) {
            for (const el of document.querySelectorAll('h1, h2, h3, [class*="filename"], [class*="file-name"]')) {
                const t = el.innerText.trim();
                if (t && !/filester/i.test(t) && t.length > 3) { title = t; break; }
            }
        }
        if (!title || /filester/i.test(title)) title = fileId;

        // Is it a video?
        const isVideo = VIDEO_EXT.test(title) || !title.match(/\.(jpg|jpeg|png|gif|webp|pdf|zip|rar|txt|doc)$/i);

        // Thumbnail
        let thumb = '';
        const ogImg = document.querySelector('meta[property="og:image"]');
        if (ogImg) thumb = (ogImg.getAttribute('content') || '').trim();
        if (!thumb) { const v = document.querySelector('video[poster]'); if (v) thumb = v.getAttribute('poster') || ''; }
        if (!thumb) { const img = document.querySelector('.file-preview img, .preview img, .thumbnail img'); if (img) thumb = img.src || ''; }
        if (thumb && thumb.startsWith('//')) thumb = 'https:' + thumb;

        // Duration — from actual <video>.duration (most reliable)
        let duration = 0;
        const vidEl = document.querySelector('video');
        if (vidEl && isFinite(vidEl.duration) && vidEl.duration > 0) {
            duration = Math.round(vidEl.duration);
        }
        // Fallback: time text in page
        if (!duration) {
            const timeMatch = (document.body.innerText || '').match(/\b(\d{1,2}:\d{2}:\d{2}|\d{1,3}:\d{2})\b/g);
            if (timeMatch) {
                for (const t of timeMatch) { const d = parseDuration(t); if (d > 5) { duration = d; break; } }
            }
        }

        // Size — ONLY from dedicated size element, NOT full body text
        let size = 0;
        const sizeEl = document.querySelector('.file-size, .filesize, [class*="size"]:not([class*="resize"])');
        if (sizeEl) size = sizeFromEl(sizeEl);
        // Fallback: look for a specific text node that matches size pattern near download button
        if (!size) {
            const dlArea = document.querySelector('.download-area, .file-info, .file-details, main, article');
            if (dlArea) {
                const m = (dlArea.innerText || '').match(/([\d.]+)\s*(GB|MB|KB)\b/i);
                if (m) size = parseSize(m[0]);
            }
        }

        // Download URL
        let downloadUrl = pageUrl;
        const dlLink = document.querySelector('a[href*="/d/"][download], a.download-btn, a[download]');
        if (dlLink) downloadUrl = dlLink.href || pageUrl;

        if (isVideo) {
            rows.push({
                id: fileId, title,
                pageUrl, downloadUrl,
                size, duration,
                timestamp: '', source_url: pageUrl,
                thumbnail: thumb,
                quality: guessQuality(title),
            });
        }

        return { folderTitle: cleanTitle(document.title) || title || 'Filester', rows };
    }

    // ==========================================================================
    // STRATEGY 2: FOLDER page — /f/ID or any listing page
    // Scrape each individual file card; DO NOT use body.innerText for size!
    // ==========================================================================

    // Folder title: from h1/h2 that is NOT brand, or document.title
    let folderTitle = '';
    for (const el of document.querySelectorAll('h1, h2, h3, [class*="folder"], [class*="album"], [class*="collection"]')) {
        const t = el.innerText.trim();
        if (t && !/filester/i.test(t) && t.length > 1) { folderTitle = t; break; }
    }
    if (!folderTitle) folderTitle = cleanTitle(document.title) || 'Filester Folder';

    // Find file cards — Filester new UI uses a grid with clickable cards
    // Each card typically contains: img/thumbnail, filename text, size text, and a link to /d/ID
    const seen = new Set();

    // Primary: look for cards that contain a /d/ link (individual file download links)
    const fileLinks = document.querySelectorAll('a[href*="/d/"]');
    fileLinks.forEach(a => {
        const hrefM = a.href.match(/\/d\/([^/?#]+)/);
        if (!hrefM) return;
        const id = hrefM[1];
        if (seen.has(id)) return;
        seen.add(id);

        // Walk up to find the enclosing card element
        let card = a;
        for (let i = 0; i < 8; i++) {
            const p = card.parentElement;
            if (!p) break;
            // Stop if we hit a grid container (has many siblings)
            if (p.querySelectorAll('a[href*="/d/"]').length > 3) break;
            card = p;
        }

        // Title: from img alt, title attr, or text nodes in card (exclude size text)
        let title = '';
        // 1. Title attribute on the link or img
        title = a.getAttribute('title') || a.querySelector('img')?.getAttribute('alt') || '';
        // 2. Text inside card that looks like a filename (has extension or is long enough)
        if (!title) {
            const textNodes = [];
            card.querySelectorAll('p, span, div, h1, h2, h3, h4, [class*="name"], [class*="title"]').forEach(el => {
                const t = el.innerText.trim();
                if (t && t.length > 2 && !/^\d[\d.\s]*(TB|GB|MB|KB)$/i.test(t)) textNodes.push(t);
            });
            // Pick the node that looks most like a filename (has dot or is longest non-size text)
            title = textNodes.find(t => /\.[a-z]{2,4}$/i.test(t)) ||
                    textNodes.sort((a, b) => b.length - a.length)[0] ||
                    id;
        }
        // Skip if title is just a size string
        if (/^[\d.\s]+(TB|GB|MB|KB|B)$/i.test(title)) title = id;

        // Skip non-video files (by extension)
        if (title && /\.(jpg|jpeg|png|gif|webp|pdf|zip|rar|7z|txt|doc|xls)$/i.test(title)) return;

        // Thumbnail
        const img = card.querySelector('img');
        let thumb = (img ? img.src || img.getAttribute('data-src') || '' : '').trim();
        if (thumb && thumb.startsWith('//')) thumb = 'https:' + thumb;

        // Size — from INDIVIDUAL card text only (look for size pattern in card)
        let size = 0;
        const cardText = card.innerText || '';
        const sizeM = cardText.match(/([\d.]+)\s*(TB|GB|MB|KB)\b/i);
        if (sizeM) size = parseSize(sizeM[0]);

        rows.push({
            id,
            title: title || id,
            pageUrl: origin + '/d/' + id,
            downloadUrl: origin + '/d/' + id,
            size,
            duration: 0,
            timestamp: '',
            source_url: pageUrl,
            thumbnail: thumb,
            quality: guessQuality(title || id),
        });
    });

    // Secondary fallback: .file-item grid (old Filester UI)
    if (rows.length === 0) {
        document.querySelectorAll('.file-item').forEach(item => {
            const title = item.getAttribute('data-name') || item.querySelector('.file-name')?.innerText?.trim() || '';
            if (title && /\.(jpg|jpeg|png|gif|webp|pdf|zip|rar)$/i.test(title)) return;
            const sizeStr = item.getAttribute('data-size') || item.querySelector('.file-meta')?.innerText?.trim() || '0';
            const size = isFinite(sizeStr) ? parseInt(sizeStr) : parseSize(sizeStr);
            const thumb = item.querySelector('img')?.src || '';
            let id = item.getAttribute('data-id') || '';
            if (!id) {
                const oc = item.getAttribute('onclick') || '';
                const m = oc.match(/\/d\/([^'"]+)/); if (m) id = m[1];
            }
            if (!id) {
                const lnk = item.querySelector('a[href*="/d/"]');
                if (lnk) { const lm = lnk.href.match(/\/d\/([^/?#]+)/); if (lm) id = lm[1]; }
            }
            if (id && !seen.has(id)) {
                seen.add(id);
                rows.push({
                    id, title: title || id,
                    pageUrl: origin + '/d/' + id,
                    downloadUrl: origin + '/d/' + id,
                    size, duration: 0, timestamp: item.getAttribute('data-date') || '',
                    source_url: pageUrl, thumbnail: thumb,
                    quality: guessQuality(title),
                });
            }
        });
    }

    return { folderTitle, rows };
}

async function handleBunkrScraping(tab) {
    console.log('Bunkr scraping tab:', tab.id);
    try {
        bunkrThumbPageOrigin = new URL(tab.url).origin;
    } catch (_) {
        bunkrThumbPageOrigin = 'https://bunkr.pk';
    }
    const fetchDirect = document.getElementById('bunkr-fetch-direct')?.checked || false;
    const autoSend = document.getElementById('send-to-dashboard')?.checked || false;

    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';
    document.getElementById('stats-text').innerText = fetchDirect
        ? 'Bunkr: načítavam zoznam a riešim priame URL…'
        : 'Bunkr: načítavam zoznam súborov…';

    try {
        const probe = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: bunkrAlbumProbe,
        });
        const data = probe && probe[0] && probe[0].result;
        if (!data || !data.rows || data.rows.length === 0) {
            showError('Na stránke Bunkr sa nenašli súbory (očakáva sa album alebo súbor /f/, /v/). Obnov stránku a skús znova.');
            return;
        }

        let rows = data.rows;
        const seenUrl = new Set();
        rows = rows.filter((r) => {
            if (!r.pageUrl || seenUrl.has(r.pageUrl)) return false;
            seenUrl.add(r.pageUrl);
            return true;
        });
        const albumTitle = data.albumTitle || 'Bunkr';

        /* source_url = stabilná stránka súboru (/f/...), nie len album — Nexus pri expirovanom MP4 obnoví stream cez BunkrExtractor z source_url */
        const bunkrCard = (r, extra) => ({
            id: r.pageUrl,
            title: r.title,
            url: extra.url,
            source_url: r.pageUrl || r.source_url || tab.url,
            thumbnail: r.thumbnail || '',
            quality: r.quality || 'HD',
            size: r.size || 0,
            duration: r.timestamp ? String(r.timestamp) : '',
            bunkr_page_url: r.pageUrl,
            album_url: r.source_url || tab.url,
            ...extra,
        });

        if (fetchDirect) {
            const out = [];
            const n = rows.length;
            const CONC = 3;
            for (let i = 0; i < rows.length; i += CONC) {
                const chunk = rows.slice(i, i + CONC);
                document.getElementById('stats-text').innerText =
                    'Bunkr: priame MP4 ' + Math.min(i + chunk.length, n) + '/' + n + '…';
                const resolved = await Promise.all(
                    chunk.map(async (r) => {
                        let stream = await bunkrApiResolve(r.dataId);
                        if (!stream) stream = await bunkrFetchPageExtract(r.pageUrl);
                        return bunkrCard(r, {
                            url: stream || r.pageUrl,
                            direct_ok: !!stream,
                        });
                    }),
                );
                out.push(...resolved);
            }
            allVideos = out;
        } else {
            allVideos = rows.map((r) =>
                bunkrCard(r, {
                    url: r.pageUrl,
                    direct_ok: false,
                }),
            );
        }

        document.getElementById('folder-name').innerText = fetchDirect
            ? 'Bunkr (priame URL)'
            : 'Bunkr (stránky súborov)';
        currentlyFilteredVideos = [...allVideos];
        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map((v) => ({
                title: v.title,
                url: v.url,
                source_url: v.bunkr_page_url || v.source_url,
                thumbnail: v.thumbnail || null,
                filesize: v.size || 0,
                quality: v.quality,
                duration: parseDuration(v.duration),
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `Bunkr: ${albumTitle}`,
                    videos: toImport,
                }),
            }).catch((err) => console.error('Bunkr auto-send failed', err));
        }
    } catch (err) {
        console.error('handleBunkrScraping', err);
        showError('Bunkr: ' + err.message);
    }
}

async function handleFilesterScraping(tab) {
    console.log('Filester scraping tab:', tab.id, tab.url);
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';
    document.getElementById('stats-text').innerText = 'Filester: načítavam súbory…';

    try {
        const probe = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: filesterProbe,
        });
        const data = probe && probe[0] && probe[0].result;
        if (!data || !data.rows || data.rows.length === 0) {
            showError(
                'Na stránke Filester sa nenašli súbory.\n\n' +
                '• Skontroluj, že stránka je plne načítaná.\n' +
                '• Skús priamo otvoriť URL súboru, napr.: filester.gg/d/igkQBlT\n' +
                '• Obnovenie stránky (F5) môže pomôcť.'
            );
            return;
        }

        allVideos = data.rows.map(r => ({
            id: r.pageUrl,
            title: r.title,
            // Use the download/page URL as import URL; Nexus will resolve stream via FilesterExtractor
            url: r.downloadUrl || r.pageUrl,
            // source_url = file page for reliable JIT refresh in Nexus
            source_url: r.pageUrl || r.source_url,
            thumbnail: r.thumbnail || '',
            quality: r.quality || 'HD',
            size: r.size || 0,
            duration: r.duration || 0,
        }));

        document.getElementById('folder-name').innerText = data.folderTitle || 'Filester';
        currentlyFilteredVideos = [...allVideos];
        applyFilters();
        updateStats();

        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail || null,
                filesize: v.size || 0,
                quality: v.quality,
                duration: v.duration || 0,
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `Filester: ${data.folderTitle}`,
                    videos: toImport,
                }),
            }).catch(err => console.error('Filester auto-send failed', err));
        }
    } catch (err) {
        console.error('handleFilesterScraping', err);
        showError('Filester: ' + err.message);
    }
}

async function tryFindDashboardUrl() {
    // Check selected port first
    const checkPort = async (port) => {
        try {
            const url = `http://localhost:${port}`;
            const resp = await fetch(`${url}/api/v1/config/gofile_token`, { method: 'GET', signal: AbortSignal.timeout(500) }).catch(() => null);
            return resp && resp.ok;
        } catch (e) { return false; }
    };

    if (await checkPort(SELECTED_PORT)) {
        DASHBOARD_URL = `http://localhost:${SELECTED_PORT}`;
        DASHBOARD_REACHABLE = true;
        console.log(`Dashboard verified at selected port: ${SELECTED_PORT}`);
        return true;
    }

    // Fallback to hunting other ports
    console.log("Selected port not responding, hunting for others...");
    for (const port of PORTS) {
        if (port === SELECTED_PORT) continue;
        if (await checkPort(port)) {
            console.log(`Dashboard found at fallback port: ${port}`);
            DASHBOARD_URL = `http://localhost:${port}`;
            DASHBOARD_REACHABLE = true;
            return true;
        }
    }
    DASHBOARD_REACHABLE = false;
    console.warn("Dashboard not found on any standard port.");
    return false;
}

async function getGofileToken() {
    // Ensure we have correct dashboard URL before proceeding
    await tryFindDashboardUrl();

    // 1. Skúsime vytiahnuť token z cookies prehliadača (priorita)

    // 1. Skúsime vytiahnuť token z cookies prehliadača (ak si prihlásený)
    try {
        const cookie = await chrome.cookies.get({ url: 'https://gofile.io', name: 'accountToken' });
        if (cookie && cookie.value) {
            console.log("Používam token z cookies prehliadača.");
            return cookie.value;
        }
    } catch (e) { console.error("Nepodarilo sa načítať cookies:", e); }

    // 2. Ak nie sme prihlásení v prehliadači, skúsime Dashboard
    try {
        const tokenResp = await fetch(`${DASHBOARD_URL}/api/v1/config/gofile_token`).catch(() => null);
        if (tokenResp && tokenResp.ok) {
            const config = await tokenResp.json();
            if (config.token) {
                console.log("Používam token z Dashboardu.");
                return config.token;
            }
        }
    } catch (e) { console.error("Nepodarilo sa načítať token z dashboardu:", e); }

    return "";
}

document.addEventListener('DOMContentLoaded', async () => {
    // ── PORT init ──
    const storage = await chrome.storage.local.get(['selected_port', 'is_list_view']);
    if (storage.selected_port) {
        SELECTED_PORT = parseInt(storage.selected_port);
        DASHBOARD_URL = `http://localhost:${SELECTED_PORT}`;
        const radio = document.querySelector(`input[name="dashboard-port"][value="${SELECTED_PORT}"]`);
        if (radio) radio.checked = true;
    }
    if (storage.is_list_view) {
        isListView = true;
        document.getElementById('list-view-btn')?.classList.add('active');
        document.getElementById('grid-view-btn')?.classList.remove('active');
    }

    document.querySelectorAll('input[name="dashboard-port"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            SELECTED_PORT = parseInt(e.target.value);
            DASHBOARD_URL = `http://localhost:${SELECTED_PORT}`;
            DASHBOARD_REACHABLE = false; // re-check on next scrape
            chrome.storage.local.set({ selected_port: SELECTED_PORT });
        });
    });

    // ── VIEW TOGGLE ──
    document.getElementById('grid-view-btn')?.addEventListener('click', () => {
        isListView = false;
        document.getElementById('grid-view-btn').classList.add('active');
        document.getElementById('list-view-btn').classList.remove('active');
        chrome.storage.local.set({ is_list_view: false });
        renderGrid(currentlyFilteredVideos);
    });
    document.getElementById('list-view-btn')?.addEventListener('click', () => {
        isListView = true;
        document.getElementById('list-view-btn').classList.add('active');
        document.getElementById('grid-view-btn').classList.remove('active');
        chrome.storage.local.set({ is_list_view: true });
        renderGrid(currentlyFilteredVideos);
    });

    // ── TABS ──
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
            if (btn.dataset.tab === 'watchlist') renderWatchlist();
        });
    });

    // ── OPEN DASHBOARD ──
    document.getElementById('open-dash-btn')?.addEventListener('click', () => {
        chrome.tabs.create({ url: DASHBOARD_URL });
    });

    // ── SELECT ALL / DESELECT ──
    document.getElementById('select-all')?.addEventListener('click', () => {
        currentlyFilteredVideos.forEach(v => selectedVideos.add(v.id));
        renderGrid(currentlyFilteredVideos);
        updateStats();
    });
    document.getElementById('deselect-all')?.addEventListener('click', () => {
        selectedVideos.clear();
        renderGrid(currentlyFilteredVideos);
        updateStats();
    });

    // ── QUEUE (Watchlist) ──
    document.getElementById('queue-btn')?.addEventListener('click', () => {
        const toQueue = currentlyFilteredVideos.filter(v => selectedVideos.has(v.id));
        const added = wlAdd(toQueue);
        renderGrid(currentlyFilteredVideos);
        showToast(`🕐 ${added} pridaných do Watchlistu`, 3000);
    });

    // ── WATCHLIST BUTTONS ──
    document.getElementById('wl-clear-btn')?.addEventListener('click', () => {
        if (confirm('Vymazať celý Watchlist?')) wlClear();
    });
    document.getElementById('wl-import-all-btn')?.addEventListener('click', () => {
        const list = wlLoad();
        if (list.length === 0) { showToast('Watchlist je prázdny.', 2000); return; }
        importVideos(list, `Watchlist Import ${new Date().toLocaleDateString()}`);
    });

    // ── IMPORT BUTTON (chunked) ──
    document.getElementById('import-btn')?.addEventListener('click', () => {
        const toImport = currentlyFilteredVideos.filter(v => selectedVideos.has(v.id));
        const batchName = `${document.getElementById('folder-name')?.innerText || 'Import'} ${new Date().toLocaleDateString()}`;
        importVideos(toImport, batchName);
    });

    // ── COPY ORIGINAL URLS ──
    document.getElementById('copy-btn')?.addEventListener('click', () => {
        const selectedList = currentlyFilteredVideos.filter(v => selectedVideos.has(v.id));
        const urls = selectedList.map(v => v.url).filter(Boolean);
        if (urls.length === 0) return;
        
        const text = urls.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            showToast(`✅ ${urls.length} linkov skopírovaných`, 3000);
        });
    });

    // ── COPY DIRECT URLS ──
    document.getElementById('copy-direct-btn')?.addEventListener('click', () => {
        const selectedList = currentlyFilteredVideos.filter(v => selectedVideos.has(v.id));
        const directUrls = selectedList.map(v => v.directUrl).filter(Boolean);
        if (directUrls.length === 0) return;
        
        const text = directUrls.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            showToast(`✅ ${directUrls.length} priamych URL skopírovaných`, 3000);
        });
    });

    // ── KEYBOARD SHORTCUTS ──
    document.addEventListener('keydown', (e) => {
        // Only when main tab active
        if (!document.getElementById('tab-main')?.classList.contains('active')) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            currentlyFilteredVideos.forEach(v => selectedVideos.add(v.id));
            renderGrid(currentlyFilteredVideos);
            updateStats();
        }
        if (e.key === 'Escape') {
            selectedVideos.clear();
            renderGrid(currentlyFilteredVideos);
            updateStats();
        }
        if (e.key === 'Enter' && selectedVideos.size > 0) {
            const toImport = currentlyFilteredVideos.filter(v => selectedVideos.has(v.id));
            const batchName = `${document.getElementById('folder-name')?.innerText || 'Import'} ${new Date().toLocaleDateString()}`;
            importVideos(toImport, batchName);
        }
    });

    // ── PH INLINE SEARCH ──
    document.getElementById('ph-search-btn')?.addEventListener('click', () => runPhSearch());
    document.getElementById('ph-search-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runPhSearch();
    });

    // ── SCRAPER ──
    const startScraper = async () => {
        await tryFindDashboardUrl();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { showError("Could not get active tab."); return; }
        console.log("Active tab URL:", tab.url);

        // Try load from cache first
        const cached = await loadFromCache(tab.url);
        if (cached && cached.length > 0) {
            console.log("[Cache] Restoring from cache:", cached.length);
            allVideos = cached;
            currentlyFilteredVideos = [...allVideos];
            const folderEl = document.getElementById('folder-name');
            if (folderEl) folderEl.innerText = "Z histórie...";
            applyFilters();
            isBackgroundResolving = false;
            updateStats();
            if (allVideos.some(v => !v.directUrl)) {
                await startBackgroundResolution();
                applyFilters();
                updateStats();
            }
            return;
        }

        const bunkrBar = document.getElementById('bunkr-controls');
        if (bunkrBar) bunkrBar.style.display = 'none';
        bunkrThumbPageOrigin = null;
        duplicateUrls.clear();

        // Show PH search bar only on PH pages
        const phPanel = document.getElementById('ph-search-panel');
        if (phPanel) phPanel.classList.toggle('visible', /pornhoarder\.(io|net|pictures)\//i.test(tab.url || ''));
        refreshPhDebug();

        try {
            if (tab.url.includes('pornhub.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handlePornhubScraping(tab);
            } else if (tab.url.includes('eporner.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleEpornerScraping(tab);
            } else if (tab.url.includes('pornone.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handlePornoneScraping(tab);
            } else if (tab.url.includes('pornhd.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handlePornhdScraping(tab);
            } else if (tab.url.includes('sxyprn.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleSxyprnScraping(tab);
            } else if (tab.url.includes('fullporner.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleFullpornerScraping(tab);
            } else if (tab.url.includes('noodlemagazine.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleNoodlemagazineScraping(tab);
            } else if (/\/gofile\.io\/d\//i.test(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'none';
                await handleGofileScraping(tab);
            } else if (isBunkrExplorerUrl(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'none';
                if (bunkrBar) bunkrBar.style.display = 'flex';
                await handleBunkrScraping(tab);
            } else if (tab.url.includes('erome.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleEromeScraping(tab);
            } else if (tab.url.includes('xvideos.com') || tab.url.includes('xvideos.red')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleXvideosScraping(tab);
            } else if (isFilesterHost(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'none';
                await handleFilesterScraping(tab);
            } else if (tab.url.includes('xgroovy.com') || tab.url.includes('xgroovy-fr.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleXgroovyScraping(tab);
            } else if (tab.url.includes('xhamster.com') || tab.url.includes('xhamster-fr.com') || tab.url.includes('xhamster.desi')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleXhamsterScraping(tab);
            } else if (/pixeldrain\.com\/(u|[ld])\//i.test(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'none';
                await handlePixeldrainScraping(tab);
            } else if (isLeakLikeUrl(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleLeakPornerScraping(tab);
            } else if (tab.url.includes('pornhoarder.io')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handlePornhoarderScraping(tab);
            } else if (tab.url.includes('archivebate.com')) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleArchivebateScraping(tab);
            } else if (isRecurbateUrl(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleRecurbateScraping(tab);
            } else if (isWhoresHubUrl(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleWhoresHubScraping(tab);
            } else if (isThotsTvUrl(tab.url)) {
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleThotsTvScraping(tab);
            } else {
                const container = document.querySelector('.container');
                if (container) container.innerHTML = '<div style="padding:40px;text-align:center;opacity:0.6;"><h3>Quantum Explorer</h3><p>Otvor podporovanú stránku:<br>GoFile, Filester, Bunkr, XVideos, Eporner, Pornhub, PornOne, PornHD, SxyPrn, FullPorner, NoodleMagazine, Erome, Pixeldrain, LeakPorner, PornHoarder, Archivebate, Recurbate, WhoresHub</p></div>';
            }

            // After scraping, run duplicate check if enabled
            const checkDup = document.getElementById('check-duplicates')?.checked || false;
            if (checkDup && allVideos.length > 0) {
                await checkDuplicates(allVideos);
                renderGrid(currentlyFilteredVideos);
            }
            
            // Do NOT trigger background fetching automatically
            isBackgroundResolving = false;
            updateStats(); // This will show the "Hľadať DIRECT" button
        } catch (error) {
            console.error("Critical error:", error);
            showError(`Kritická chyba: ${error.message}`);
        }
    };

    // ── CHECKBOX LISTENERS ──
    document.getElementById('turbo-mode')?.addEventListener('change', (e) => {
        if (e.target.checked) document.getElementById('deep-scan').checked = false;
        startScraper();
    });
    document.getElementById('deep-scan')?.addEventListener('change', (e) => {
        if (e.target.checked) document.getElementById('turbo-mode').checked = false;
        startScraper();
    });
    document.getElementById('bunkr-fetch-direct')?.addEventListener('change', () => startScraper());
    document.getElementById('check-duplicates')?.addEventListener('change', async () => {
        const checkDup = document.getElementById('check-duplicates').checked;
        if (checkDup && allVideos.length > 0) {
            await checkDuplicates(allVideos);
        } else {
            duplicateUrls.clear();
            document.getElementById('dup-stats').style.display = 'none';
        }
        renderGrid(currentlyFilteredVideos);
    });

    // ── INITIAL START ──
    renderWatchlist();
    await startScraper();
    setInterval(refreshPhDebug, 2000);
});

// ── PH INLINE SEARCH ─────────────────────────────────────────────────────────
async function runPhSearch() {
    const query = document.getElementById('ph-search-input')?.value?.trim();
    if (!query) return;
    const statsEl = document.getElementById('stats-text');
    if (statsEl) statsEl.innerText = `PH Search: hľadám "${query}"…`;
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';
    try {
        const url = `https://pornhoarder.io/search/?search=${encodeURIComponent(query)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        function parseSize(text) {
            if (!text) return 0;
            const m = String(text).match(/([\d.]+)\s*(GB|MB|KB)\b/i);
            if (!m) return 0;
            const n = parseFloat(m[1]);
            const u = m[2].toUpperCase();
            return Math.round(n * ({ GB: 1073741824, MB: 1048576, KB: 1024 }[u] || 1));
        }
        function parseDurStr(text) {
            if (!text) return 0;
            const p = String(text).trim().split(':').map(Number);
            if (p.some(isNaN)) return 0;
            if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
            if (p.length === 2) return p[0]*60 + p[1];
            return 0;
        }
        function guessQ(text) {
            const t = String(text||'').toUpperCase();
            if (/4K|2160P|UHD/.test(t)) return '4K';
            if (/1080P|FHD/.test(t)) return '1080p';
            if (/720P/.test(t)) return '720p';
            if (/480P/.test(t)) return '480p';
            return 'HD';
        }

        const cards = doc.querySelectorAll('.video');
        const results = [];
        cards.forEach(card => {
            const link = card.querySelector('a.video-link, a[href*="/watch/"]');
            if (!link) return;
            let href = link.getAttribute('href') || '';
            if (href.startsWith('/')) href = 'https://pornhoarder.io' + href;
            if (!href.includes('/watch/')) return;
            const titleEl = card.querySelector('.video-content h1, .video-content h2');
            const title = titleEl?.innerText?.trim() || href.split('/watch/')[1]?.split('/')[0]?.replace(/-/g,' ') || query;
            const imgEl = card.querySelector('.video-image.primary, .video-image');
            let thumbnail = '';
            if (imgEl) {
                const bg = imgEl.style.backgroundImage;
                if (bg) { const m = bg.match(/url\(["']?([^"')]+)/i); if (m) thumbnail = m[1]; }
            }
            const durEl = card.querySelector('.video-length');
            const metaText = card.querySelector('.video-meta')?.innerText || '';
            results.push({
                id: href, title, url: href, source_url: href, thumbnail,
                quality: guessQ(title),
                duration: parseDurStr(durEl?.innerText?.trim() || ''),
                size: parseSize(metaText),
            });
        });

        allVideos = results;
        currentlyFilteredVideos = [...allVideos];
        document.getElementById('folder-name').innerText = `PH: "${query}" (${results.length})`;
        applyFilters();
        updateStats();

        // Trigger background fetching of direct links
        if (allVideos.length > 0) {
            startBackgroundResolution();
        }
    } catch(e) {
        showError(`PH Search chyba: ${e.message}`);
    }
}

function showError(message) {
    const loader = document.getElementById('loader');
    const videoGrid = document.getElementById('video-grid');

    if (loader) {
        loader.style.display = 'block'; // Make sure it's visible
        loader.innerHTML = `<p style="color: #ff4b2b; padding: 20px;">${message}</p>`;
    }
    if (videoGrid) {
        videoGrid.style.display = 'none'; // Hide the grid
    }

    // Also hide main controls if something critical fails
    const controls = document.querySelector('.controls');
    if (controls) controls.style.display = 'none';
    const footer = document.querySelector('footer');
    if (footer) footer.style.display = 'none';
    const stats = document.querySelector('.stats');
    if (stats) stats.style.display = 'none';
    const turbo = document.getElementById('turbo-controls');
    if (turbo) turbo.style.display = 'none';
    const folderName = document.getElementById('folder-name');
    if (folderName) folderName.innerText = "Error";
}

async function handleLeakPornerScraping(tab) {
    const siteLabel = isDjavUrl(tab.url) ? 'DJAV' : 'LeakPorner';
    console.log(`${siteLabel} scraping tab:`, tab.id);
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';

    const isTurbo = document.getElementById('turbo-mode')?.checked || false;
    const isDeep = document.getElementById('deep-scan')?.checked || false;
    const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
    const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

    const statsEl = document.getElementById('stats-text');
    if (statsEl) statsEl.innerText = isDeep ? 'Deep Scan: Scraping…' : (isTurbo ? 'Turbo: Scraping 4 pages…' : 'Scraping page…');

    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit, dashboardUrl, siteLabel) => {
                const hostMatches = (href) => {
                    const host = new URL(href).hostname.toLowerCase();
                    return host === 'leakporner.com'
                        || host.endsWith('.leakporner.com')
                        || host === 'djav.org'
                        || host.endsWith('.djav.org');
                };

                const normalizeEmbed = (rawUrl) => {
                    let url = String(rawUrl || '').trim();
                    if (!url) return '';
                    if (url.startsWith('//')) url = `https:${url}`;
                    if (!/^https?:\/\//i.test(url)) return '';
                    if (url.includes('luluvids.top')) {
                        url = url.replace('luluvids.top', 'luluvids.com').replace('/v/', '/e/');
                    }
                    return url;
                };

                const hostFromUrl = (rawUrl) => {
                    const normalized = normalizeEmbed(rawUrl);
                    if (!normalized) return '';
                    try {
                        return new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
                    } catch {
                        return '';
                    }
                };

                const collectEmbeds = (doc) => {
                    const seen = new Set();
                    const embeds = [];
                    doc.querySelectorAll('.servideo .change-video, .change-video').forEach(node => {
                        const normalized = normalizeEmbed(node.getAttribute('data-embed'));
                        if (normalized && !seen.has(normalized)) {
                            seen.add(normalized);
                            embeds.push(normalized);
                        }
                    });
                    return embeds;
                };

                const normalizeThumb = (rawThumb, baseUrl) => {
                    let thumbnail = String(rawThumb || '').trim();
                    if (!thumbnail) return '';
                    if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
                    else if (thumbnail.startsWith('/')) thumbnail = new URL(thumbnail, baseUrl).href;
                    if (thumbnail && (thumbnail.includes('58img.top') || thumbnail.includes('leakporner.com'))) {
                        thumbnail = `${dashboardUrl}/api/v1/proxy?url=${encodeURIComponent(thumbnail)}`;
                    }
                    return thumbnail;
                };

                const isVideoPageUrl = (href) => {
                    try {
                        const u = new URL(href);
                        if (!hostMatches(u.href)) return false;
                        if (/^\/page\/\d+\/?$/i.test(u.pathname)) return false;
                        if (u.pathname === '/' && u.search) return false;
                        if (/^\/(?:tag|category|models?|pornstars?|search|author|filter)\//i.test(u.pathname)) return false;
                        return true;
                    } catch {
                        return false;
                    }
                };

                const pickCardLink = (container, baseUrl) => {
                    const links = Array.from(container.querySelectorAll('a[href]'));
                    for (const link of links) {
                        const href = link.href || link.getAttribute('href') || '';
                        const fullHref = href.startsWith('http') ? href : new URL(href, baseUrl).href;
                        if (isVideoPageUrl(fullHref)) return { link, href: fullHref };
                    }
                    return null;
                };

                const findNextPageUrl = (doc, currentUrl) => {
                    let currentPage = 1;
                    try {
                        const current = new URL(currentUrl);
                        const match = current.pathname.match(/\/page\/(\d+)\/?$/i);
                        currentPage = match ? parseInt(match[1], 10) : 1;
                        const candidates = [];
                        doc.querySelectorAll('a[href]').forEach((anchor) => {
                            try {
                                const target = new URL(anchor.href, current.href);
                                if (!hostMatches(target.href)) return;
                                const pageMatch = target.pathname.match(/\/page\/(\d+)\/?$/i);
                                if (!pageMatch) return;
                                const pageNum = parseInt(pageMatch[1], 10);
                                if (!(pageNum > currentPage)) return;
                                if (target.search !== current.search) return;
                                candidates.push({ pageNum, href: target.href });
                            } catch {}
                        });
                        candidates.sort((a, b) => a.pageNum - b.pageNum);
                        return candidates[0]?.href || '';
                    } catch {
                        return '';
                    }
                };

                const extractFromDoc = (doc, baseUrl) => {
                    const containers = doc.querySelectorAll(
                        'article.loop-video, article.thumb-block, article.post, main.site-main article, section.content-area article'
                    );
                    const videos = Array.from(containers).map(container => {
                        const entry = pickCardLink(container, baseUrl);
                        if (!entry) return null;
                        const { link, href: videoUrl } = entry;
                        const title = link.getAttribute('data-title') ||
                                      link.getAttribute('title') ||
                                      container.querySelector('.entry-header span, .entry-title, h2, h3')?.innerText?.trim() ||
                                      container.querySelector('img')?.getAttribute('alt') ||
                                      'LeakPorner Video';
                        const img = container.querySelector('img');
                        const thumbnail = normalizeThumb(
                            img?.getAttribute('data-src') ||
                            img?.getAttribute('data-original') ||
                            img?.getAttribute('data-lazy-src') ||
                            img?.src || '',
                            baseUrl
                        );
                        const duration = container.querySelector('.duration, .meta-duration, time')?.innerText?.replace(/\s+/g, '').trim() || '';
                        return {
                            id: videoUrl,
                            title,
                            url: videoUrl,
                            source_url: videoUrl,
                            page_host: hostFromUrl(videoUrl),
                            thumbnail,
                            duration,
                            quality: '720p',
                            size: 0,
                        };
                    }).filter(v => v && isVideoPageUrl(v.url));

                    // SINGLE VIDEO PAGE — extract embed URLs from player selector
                    if (videos.length === 0) {
                        const singleTitle = doc.querySelector('h1.entry-title')?.innerText?.trim() ||
                                            doc.querySelector('meta[property="og:title"]')?.content ||
                                      doc.title.replace(/\s-\s(?:LeakPorner|DJAV)$/i, '').trim();
                        const singleThumb = normalizeThumb(
                            doc.querySelector('meta[property="og:image"]')?.content ||
                            doc.querySelector('.vi-on')?.getAttribute('data-thum') || '',
                            baseUrl
                        );
                        const embeds = collectEmbeds(doc);
                        if (embeds.length > 0) {
                            videos.push({
                                id: baseUrl,
                                title: singleTitle,
                                url: embeds[0],
                                source_url: baseUrl,
                                page_host: hostFromUrl(baseUrl),
                                playback_host: hostFromUrl(embeds[0]),
                                thumbnail: singleThumb,
                                quality: '720p',
                                duration: '',
                                embeds,
                                size: 0,
                            });
                        }
                    }
                    return videos;
                };

                let allResults = [];
                let currentDoc = document;
                let currentUrl = window.location.href;
                const visitedPages = new Set();

                for (let i = 0; i < limit && currentDoc && currentUrl && !visitedPages.has(currentUrl); i += 1) {
                    visitedPages.add(currentUrl);
                    allResults = allResults.concat(extractFromDoc(currentDoc, currentUrl));
                    const nextUrl = findNextPageUrl(currentDoc, currentUrl);
                    if (!nextUrl || visitedPages.has(nextUrl)) break;
                    try {
                        const response = await fetch(nextUrl, { credentials: 'include' });
                        if (!response.ok) break;
                        currentUrl = nextUrl;
                        currentDoc = new DOMParser().parseFromString(await response.text(), 'text/html');
                    } catch (e) {
                        break;
                    }
                }

                const seen = new Set();
                return allResults.filter(v => { if (!v || !v.url || seen.has(v.url)) return false; seen.add(v.url); return true; });
            },
            args: [pageLimit, DASHBOARD_URL, siteLabel]
        });

        allVideos = (result || []).filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        const folderEl = document.getElementById('folder-name');
        if (folderEl) folderEl.innerText = `${siteLabel} Explorer`;
        applyFilters();
        updateStats();

        if (allVideos.some(v => !v.directUrl)) {
            await startBackgroundResolution();
            applyFilters();
        }

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({ title: v.title, url: v.url, source_url: v.source_url,
                thumbnail: v.thumbnail || null, filesize: 0, quality: v.quality, duration: parseDuration(v.duration) }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_name: `${siteLabel} ${isDeep ? 'Deep' : isTurbo ? 'Turbo' : 'Import'} ${new Date().toLocaleDateString()}`, videos: toImport })
            }).catch(err => console.error('LeakPorner auto-send failed', err));
        }
    } catch (err) {
        console.error('handleLeakPornerScraping', err);
        showError(siteLabel + ': ' + err.message);
    }
}

/** API list/file rows + file info — match video by mime or extension (names may omit .mp4). */
function pixeldrainEntryLooksLikeVideo(f) {
    if (!f) return false;
    const mime = String(f.mime_type || f.mimeType || '').toLowerCase();
    if (mime.startsWith('video/')) return true;
    if (mime.startsWith('image/')) return false;
    const sz = typeof f.size === 'number' ? f.size : 0;
    if (mime === 'application/octet-stream' && sz > 4 * 1024 * 1024) return true;
    const name = String(f.name || '').toLowerCase();
    return /\.(mp4|webm|mkv|mov|avi|m4v|m3u8|wmv|flv|mpeg|mpg|3gp|ts|m2ts|ogv)(\?|$)/i.test(name);
}

/**
 * Popup fetch() runs from chrome-extension:// — Pixeldrain session cookies are often NOT sent → API 404.
 * This runs inside the tab (same origin as pixeldrain.com) so cookies + auth match the visible page.
 */
async function handlePixeldrainScraping(tab) {
    console.log("Starting Pixeldrain scraping for tab:", tab.id);
    const loader = document.getElementById('loader');
    const videoGrid = document.getElementById('video-grid');
    if (loader) loader.style.display = 'flex';
    if (videoGrid) videoGrid.style.display = 'none';
    if (loader) loader.innerHTML = '<p style="padding: 20px;">Načítavam Pixeldrain (v kontexte stránky)…</p>';

    const extractQuality = (name) => {
        const m = String(name || '').match(/(4K|2160p|1440p|1080p|720p|480p|360p)/i);
        return m ? m[0].toUpperCase().replace('P', 'p') : 'HD';
    };

    const tabUrl = tab.url || '';

    try {
        allVideos = [];
        if (!tab.id || !/^https:\/\/([^/]+\.)?pixeldrain\.com\//i.test(tabUrl)) {
            showError('Otvor stránku pixeldrain.com v hlavnej záložke a znova spusti rozšírenie.');
            return;
        }

        const [{ result: scrape }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: async () => {
                const looksVideo = (f) => {
                    if (!f) return false;
                    const mime = String(f.mime_type || f.mimeType || '').toLowerCase();
                    if (mime.startsWith('video/')) return true;
                    if (mime.startsWith('image/')) return false;
                    const sz = typeof f.size === 'number' ? f.size : 0;
                    if (mime === 'application/octet-stream' && sz > 4 * 1024 * 1024) return true;
                    const name = String(f.name || '').toLowerCase();
                    return /\.(mp4|webm|mkv|mov|avi|m4v|m3u8|wmv|flv|mpeg|mpg|3gp|ts|m2ts|ogv)(\?|$)/i.test(name);
                };

                const path = window.location.pathname;
                const fsDirMatch = path.match(/^\/d\/([^/]+)/i);
                const pdPath = path.match(/^\/(u|l)\/([^/]+)/i);

                if (!fsDirMatch && !pdPath) {
                    return { ok: false, videos: [], title: '', listStatus: null, fileStatus: null, fsStatus: null, source: 'path', detail: '' };
                }

                let listStatus = null;
                let fileStatus = null;
                let fsStatus = null;

                // /d/<id> = shared filesystem folder — NOT /api/list/ (that returns 404)
                if (fsDirMatch && fsDirMatch[1]) {
                    const dirId = fsDirMatch[1];
                    try {
                        const fr = await fetch(`https://pixeldrain.com/api/filesystem/${encodeURIComponent(dirId)}?stat`, {
                            credentials: 'same-origin',
                        });
                        fsStatus = fr.status;
                        if (fr.ok) {
                            const fsdata = await fr.json();
                            const children = Array.isArray(fsdata.children) ? fsdata.children : [];
                            const fsEnc = (p) => String(p || '').split('/').map((s) => encodeURIComponent(s)).join('/');
                            const folderTitle = (fsdata.path && fsdata.path[0] && fsdata.path[0].name) || '';
                            const vids = [];
                            for (const node of children) {
                                if (!node || node.type !== 'file') continue;
                                const nm = String(node.name || '');
                                if (nm.startsWith('.search_index')) continue;
                                const ft = String(node.file_type || '').toLowerCase();
                                if (ft.startsWith('image/')) continue;
                                if (!ft.startsWith('video') && !/\.(mp4|webm|mkv|mov|avi|m4v|m3u8|wmv|flv|mpeg|mpg|3gp|ts|m2ts|ogv)(\?|$)/i.test(nm)) {
                                    continue;
                                }
                                const base = `https://pixeldrain.com/api/filesystem${fsEnc(node.path)}`;
                                const url = `${base}?attach`;
                                vids.push({
                                    id: node.path || url,
                                    title: nm,
                                    url,
                                    thumbnail: `${base}?thumbnail&width=128&height=128`,
                                    size: typeof node.file_size === 'number' ? node.file_size : 0,
                                    views: 0,
                                });
                            }
                            if (vids.length) {
                                return {
                                    ok: true,
                                    videos: vids,
                                    title: folderTitle || 'Pixeldrain',
                                    listStatus: null,
                                    fileStatus: null,
                                    fsStatus,
                                    source: 'fs_api',
                                    detail: '',
                                };
                            }
                        }
                    } catch (e) {
                        fsStatus = fsStatus || 'err';
                    }
                }

                if (pdPath && pdPath[2]) {
                    const pdId = pdPath[2];
                    try {
                        const listR = await fetch(`https://pixeldrain.com/api/list/${encodeURIComponent(pdId)}`, {
                            credentials: 'same-origin',
                        });
                        listStatus = listR.status;
                        if (listR.ok) {
                            const data = await listR.json();
                            if (!(data && data.success === false)) {
                                const files = Array.isArray(data.files) ? data.files : [];
                                const vids = [];
                                for (const f of files) {
                                    if (!f || !f.id) continue;
                                    if (!looksVideo(f)) continue;
                                    vids.push({
                                        id: f.id,
                                        title: f.name || f.id,
                                        url: `https://pixeldrain.com/api/file/${f.id}`,
                                        thumbnail: `https://pixeldrain.com/api/file/${f.id}/thumbnail`,
                                        size: f.size || 0,
                                        views: typeof f.views === 'number' ? f.views : 0,
                                    });
                                }
                                if (vids.length) {
                                    return {
                                        ok: true,
                                        videos: vids,
                                        title: data.title || 'Pixeldrain Album',
                                        listStatus,
                                        fileStatus: null,
                                        fsStatus,
                                        source: 'list_api',
                                        detail: '',
                                    };
                                }
                            }
                        }
                    } catch (e) {
                        listStatus = 'err';
                    }

                    try {
                        const fileR = await fetch(`https://pixeldrain.com/api/file/${encodeURIComponent(pdId)}/info`, {
                            credentials: 'same-origin',
                        });
                        fileStatus = fileR.status;
                        if (fileR.ok) {
                            const raw = await fileR.json();
                            if (!(raw && raw.success === false)) {
                                const f = raw && raw.id ? raw : raw.data || raw;
                                if (f && f.id && looksVideo(f)) {
                                    return {
                                        ok: true,
                                        videos: [
                                            {
                                                id: f.id,
                                                title: f.name || f.id,
                                                url: `https://pixeldrain.com/api/file/${f.id}`,
                                                thumbnail: `https://pixeldrain.com/api/file/${f.id}/thumbnail`,
                                                size: f.size || 0,
                                                views: typeof f.views === 'number' ? f.views : 0,
                                            },
                                        ],
                                        title: f.name || 'Pixeldrain File',
                                        listStatus,
                                        fileStatus,
                                        fsStatus,
                                        source: 'file_api',
                                        detail: '',
                                    };
                                }
                            }
                        }
                    } catch (e) {
                        fileStatus = fileStatus || 'err';
                    }
                }

                const seen = new Set();
                const domVids = [];
                const root = document.querySelector('main') || document.querySelector('[class*="gallery"]') || document.body;
                root.querySelectorAll('a[href*="/u/"]').forEach((a) => {
                    const href = a.getAttribute('href') || a.href || '';
                    const mm = href.match(/\/u\/([a-zA-Z0-9_-]+)/);
                    if (!mm) return;
                    const fid = mm[1];
                    if (seen.has(fid)) return;
                    seen.add(fid);
                    const label = (a.textContent || '').trim().split('\n')[0].slice(0, 240) || fid;
                    domVids.push({
                        id: fid,
                        title: label,
                        url: `https://pixeldrain.com/api/file/${fid}`,
                        thumbnail: `https://pixeldrain.com/api/file/${fid}/thumbnail`,
                        size: 0,
                        views: 0,
                    });
                });

                if (domVids.length) {
                    return {
                        ok: true,
                        videos: domVids,
                        title: (document.title || '').replace(/\s*-\s*pixeldrain\s*$/i, '').trim() || 'Pixeldrain (DOM)',
                        listStatus,
                        fileStatus,
                        fsStatus,
                        source: 'dom',
                        detail: '',
                    };
                }

                return {
                    ok: false,
                    videos: [],
                    title: '',
                    listStatus,
                    fileStatus,
                    fsStatus,
                    source: 'none',
                    detail: 'API aj DOM prázdne — skontroluj prihlásenie na pixeldrain.com alebo AdBlock.',
                };
            },
        });

        const pack = scrape || {};
        if (pack.videos && pack.videos.length > 0) {
            allVideos = pack.videos.map((v) => ({
                id: v.id,
                title: v.title,
                quality: extractQuality(v.title),
                url: v.url,
                thumbnail: v.thumbnail,
                size: v.size || 0,
                source_url: tabUrl,
                views: v.views || 0,
                rating: 0,
                duration: '',
            }));
            const folderEl = document.getElementById('folder-name');
            if (folderEl) folderEl.innerText = pack.title || 'Pixeldrain';
            console.log('[Pixeldrain] source=', pack.source, 'n=', allVideos.length, 'listHTTP=', pack.listStatus, 'fileHTTP=', pack.fileStatus, 'fsHTTP=', pack.fsStatus);
        } else {
            const fsPart = pack.fsStatus != null ? `, FS API ${pack.fsStatus}` : '';
            showError(
                `Pixeldrain: žiadne videá (list API ${pack.listStatus ?? '?'}, súbor API ${pack.fileStatus ?? '?'}${fsPart}). ${pack.detail || ''}`,
            );
            return;
        }

        console.log(`Found ${allVideos.length} videos on Pixeldrain.`);
        currentlyFilteredVideos = [...allVideos];
        applyFilters();
        updateStats();
    } catch (err) {
        console.error("Error during Pixeldrain scraping:", err);
        showError(`Pixeldrain: ${err.message}`);
    }
}

async function handleGofileScraping(tab) {
    console.log("Starting GoFile scraping for tab:", tab.id);
    const folderIdMatch = tab.url.match(/gofile\.io\/d\/([^/?#]+)/i);

    if (!folderIdMatch) {
        showError("Could not extract GoFile folder ID from URL (expected …/d/<id>…).");
        return;
    }
    const folderId = folderIdMatch[1];
    console.log("Extracted GoFile Folder ID:", folderId);

    try {
        console.log("Attempting to get GoFile token.");
        const token = await getGofileToken();
        console.log(token ? "Using auth token." : "No auth token found, proceeding without it.");

        let apiUrl = `https://api.gofile.io/contents/${folderId}?cache=true`; // Added cachebuster
        if (token) {
            apiUrl += `&token=${token}`;
        }

        console.log("Fetching folder contents from:", apiUrl);
        const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) }); // 10s timeout

        if (!resp.ok) {
            throw new Error(`API request failed with status ${resp.status}`);
        }

        const data = await resp.json();
        console.log("Received API data:", data);

        if (data.status !== 'ok') {
            // Specific error messages based on GoFile API responses
            let errorMessage = `API Error: ${data.status}.`;
            if (data.status === "error-notFound") {
                errorMessage = "The folder could not be found. It may have been deleted.";
            } else if (data.status === "error-passwordRequired") {
                errorMessage = "This folder is password protected. Password entry is not yet supported.";
            } else if (data.status === "error-permissionDenied") {
                errorMessage = "You do not have permission to access this folder. A VIP token may be required.";
            }
            throw new Error(errorMessage);
        }

        const contents = data.data.children || {};
        const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8'];
        console.log(`Found ${Object.keys(contents).length} items in folder. Filtering for videos.`);

        allVideos = Object.values(contents)
            .filter(item => item.type === 'file' && videoExtensions.some(ext => item.name.toLowerCase().endsWith(ext)))
            .map(item => {
                const title = item.name;
                const qualityMatch = title.match(/(4K|2160p|1440p|1080p|720p|480p|360p)/i);
                const quality = qualityMatch ? qualityMatch[0].toUpperCase().replace('P', 'p') : 'HD';

                return {
                    id: item.id,
                    title: title,
                    quality: quality,
                    url: item.link,
                    thumbnail: item.thumbnail || `https://gofile.io/dist/img/logo.png`,
                    size: item.size,
                    duration: item.duration ? formatTime(item.duration) : '',
                    source_url: tab.url,
                };
            });

        console.log(`Filtered down to ${allVideos.length} videos.`);

        document.getElementById('folder-name').innerText = data.data.name || "GoFile Folder";
        currentlyFilteredVideos = [...allVideos];
        applyFilters();
        updateStats();

    } catch (err) {
        console.error("Error during GoFile scraping:", err);
        showError(`Failed to load GoFile content: ${err.message}`);
    }
}

async function handleEpornerScraping(tab) {
    console.log("Starting Eporner scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        let pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        console.log(`Eporner scrape settings: turbo=${isTurbo}, deep=${isDeep}, autoSend=${autoSend}, pageLimit=${pageLimit}`);
        document.getElementById('stats-text').innerText = isDeep ? "Deep Scan: Scraping up to 50 pages..." : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            // Injected function to be executed in the context of the page
            func: async (limit) => {
                // ... (the robust scraping logic remains unchanged)
                const extractFromDoc = (doc, baseUrl) => {
                    const containers = doc.querySelectorAll('.mb, .post-data, .p-v-y');
                    return Array.from(containers).map(container => {
                        const link = container.querySelector('a[href*="/video-"]');
                        if (!link) return null;

                        const title = link.getAttribute('title') || container.querySelector('.mbtit, .mbt')?.innerText?.trim() || "Eporner Video";
                        const img = container.querySelector('img');
                        let thumbnail = img?.getAttribute('data-src') || img?.src;
                        if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;

                        const ratingTag = container.querySelector('.vrating, span.vrating, .mbrate');
                        let rating = ratingTag ? parseInt(ratingTag.innerText.match(/(\d+)%/)?.[1]) || 0 : 0;

                        let viewsTag = container.querySelector('.vviews, .mbvie');
                        if (!viewsTag) {
                            const vinfo = container.querySelector('.vinfo');
                            if (vinfo) viewsTag = vinfo.querySelectorAll('span')[vinfo.querySelectorAll('span').length - 1];
                        }
                        let views = 0;
                        if (viewsTag) {
                            const viewsText = viewsTag.innerText.trim().toUpperCase();
                            if (viewsText.includes('M')) views = parseFloat(viewsText.replace('M', '')) * 1000000;
                            else if (viewsText.includes('K')) views = parseFloat(viewsText.replace('K', '')) * 1000;
                            else views = parseInt(viewsText.replace(/[^\d]/g, '')) || 0;
                        }

                        let videoUrl = link.href;
                        if (!videoUrl.startsWith('http')) videoUrl = new URL(videoUrl, baseUrl).href;

                        return {
                            id: videoUrl,
                            title,
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail,
                            rating,
                            views,
                            duration: container.querySelector('.vtime, .duration')?.innerText?.trim() || '',
                            quality: (container.innerText.match(/(4K\s?\(2160p\)|2160p|1440p|1080p|720p)/i) || [container.querySelector('.mbqual, .hd, .quality, .hd-thumbnail')?.innerText?.trim() || 'HD'])[0],
                            size: 0
                        };
                    }).filter(v => v);
                };

                let allResults = extractFromDoc(document, window.location.href);
                if (limit > 1) {
                    // Detect total pages if possible
                    let detectedLimit = limit;
                    const pagination = document.querySelectorAll('.pagination li a');
                    if (pagination.length > 0) {
                        const lastPage = parseInt(pagination[pagination.length - 2]?.innerText);
                        if (!isNaN(lastPage)) detectedLimit = Math.min(limit, lastPage);
                    }

                    const baseUrl = window.location.href.split(/[?#]/)[0].replace(/\/$/, '');
                    const fetchPage = async (pageNum) => {
                        try {
                            const url = `${baseUrl}/${pageNum}/`;
                            const resp = await fetch(url);
                            if (!resp.ok) return [];
                            const html = await resp.text();
                            const doc = new DOMParser().parseFromString(html, 'text/html');
                            return extractFromDoc(doc, url);
                        } catch (e) { console.warn(`Failed to fetch Eporner page ${pageNum}`, e); return []; }
                    };
                    const promises = Array.from({ length: detectedLimit - 1 }, (_, i) => fetchPage(i + 2));
                    const extraResults = await Promise.all(promises);
                    allResults = allResults.concat(...extraResults);
                }
                // Global De-duplication
                const unique = [];
                const seen = new Set();
                allResults.forEach(v => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit]
        });

        if (!results || !results[0] || !results[0].result) {
            throw new Error("Scraping script failed to return results.");
        }

        allVideos = results[0].result;
        currentlyFilteredVideos = [...allVideos];
        applyFilters();
        console.log(`Scraped ${allVideos.length} videos from Eporner.`);
        document.getElementById('folder-name').innerText = isDeep ? "Eporner Explorer (Deep)" : (isTurbo ? "Eporner Explorer (Turbo)" : "Eporner Explorer");

        if (allVideos.length === 0) {
            // This is not an error, just no videos found. The `renderGrid` will handle the message.
            console.log("No videos found on the page.");
        }

        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            console.log("Auto-sending to dashboard.");
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail,
                filesize: v.size,
                duration: v.duration
            }));
            document.getElementById('stats-text').innerText += " | Sending to DB...";

            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_name: `Turbo: ${new Date().toLocaleDateString()}`, videos: toImport })
            }).catch(err => console.error("Turbo auto-send failed", err));
        }
    } catch (err) {
        console.error("Error during Eporner scraping:", err);
        showError(`Failed to scrape Eporner: ${err.message}`);
    }
}

async function handlePornhubScraping(tab) {
    console.log("Starting Pornhub scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        let pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        console.log(`Pornhub scrape settings: turbo=${isTurbo}, deep=${isDeep}, autoSend=${autoSend}, pageLimit=${pageLimit}`);
        document.getElementById('stats-text').innerText = isDeep ? "Deep Scan: Scraping up to 50 pages..." : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const extractFromDoc = (doc, baseUrl) => {
                    // Pornhub uses different selectors for different page types
                    // Search results: .pcVideoListItem, .videoBox, .phimage
                    // Category pages: .pcVideoListItem, .videoBox
                    const containers = doc.querySelectorAll('.pcVideoListItem, .videoBox, li[data-video-vkey]');

                    return Array.from(containers).map(container => {
                        // Find the main video link
                        const link = container.querySelector('a[href*="/view_video.php"], a.linkVideoThumb, a[data-title]');
                        if (!link) return null;

                        // Extract title
                        const title = link.getAttribute('title') ||
                            link.getAttribute('data-title') ||
                            container.querySelector('.title a, .videoTitle a')?.innerText?.trim() ||
                            "Pornhub Video";

                        // Extract thumbnail
                        const img = container.querySelector('img');
                        let thumbnail = null;
                        if (img) {
                            // Prioritize src if it's a valid URL (not data URI)
                            if (img.src && !img.src.startsWith('data:')) {
                                thumbnail = img.src;
                            }
                            // Fallback to data attributes
                            if (!thumbnail || thumbnail.includes('gif')) {
                                thumbnail = img.getAttribute('data-thumb_url') ||
                                    img.getAttribute('data-src') ||
                                    img.getAttribute('data-mediabook') ||
                                    img.getAttribute('data-mediumthumb') ||
                                    img.src;
                            }

                            // Handle protocol-relative URLs
                            if (thumbnail && thumbnail.startsWith('//')) {
                                thumbnail = 'https:' + thumbnail;
                            }
                        }

                        // Extract duration
                        let duration = container.querySelector('.duration, .marker-overlays .duration, var.duration')?.innerText?.trim() || '';

                        // Extract quality (HD, 4K, etc.)
                        let quality = 'SD';
                        // 1. Check badges
                        const qualityBadge = container.querySelector('.hd, .videoHD, .marker-overlays .hd, .hd-thumbnail, .videoUploaderBadge, span.hd');
                        if (qualityBadge) {
                            const qualityText = (qualityBadge.innerText?.trim() || qualityBadge.textContent?.trim() || '').toUpperCase();
                            if (qualityText.includes('4K')) quality = '4K';
                            else if (qualityText.includes('1440')) quality = '1440p';
                            else if (qualityText.includes('1080')) quality = '1080p';
                            else if (qualityText.includes('720')) quality = '720p';
                            else if (qualityText.includes('HD')) quality = 'HD';
                        }
                        // 2. Fallback: Check container classes
                        if (quality === 'SD' && container.className && container.className.toLowerCase().includes('hd')) {
                            quality = 'HD';
                        }
                        // 3. Last resort: Check full text of container for "4K" or "1080p" (risky but effective)
                        if (quality === 'SD') {
                            const fullText = container.innerText || container.textContent || '';
                            if (fullText.includes('4K')) quality = '4K';
                            else if (fullText.includes('1080p')) quality = '1080p';
                        }

                        // Extract rating
                        const ratingElement = container.querySelector('.value, .percent, .rating-container .value');
                        let rating = 0;
                        if (ratingElement) {
                            const ratingText = ratingElement.innerText?.trim();
                            rating = parseInt(ratingText?.match(/(\d+)%?/)?.[1]) || 0;
                        }

                        // Extract views
                        const viewsElement = container.querySelector('.views, .videoDetailsBlock .views var');
                        let views = 0;
                        if (viewsElement) {
                            const viewsText = viewsElement.innerText?.trim().toUpperCase();
                            if (viewsText.includes('M')) views = parseFloat(viewsText.replace(/[^\d.]/g, '')) * 1000000;
                            else if (viewsText.includes('K')) views = parseFloat(viewsText.replace(/[^\d.]/g, '')) * 1000;
                            else views = parseInt(viewsText.replace(/[^\d]/g, '')) || 0;
                        }

                        // Build full video URL
                        let videoUrl = link.href;
                        if (!videoUrl.startsWith('http')) {
                            videoUrl = new URL(videoUrl, baseUrl).href;
                        }

                        return {
                            id: videoUrl,
                            title,
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail: thumbnail || "MISSING_THUMBNAIL", // Don't null out, allow debugging
                            rating,
                            views,
                            duration,
                            quality,
                            size: 0
                        };
                    }); // Removed filter validation to see "broken" items
                };

                let allResults = extractFromDoc(document, window.location.href);

                if (limit > 1) {
                    // Detect total pages
                    let detectedLimit = limit;
                    const pages = document.querySelectorAll('.page_number a, .pagination li a');
                    if (pages.length > 0) {
                        const lastPage = parseInt(pages[pages.length - 2]?.innerText);
                        if (!isNaN(lastPage)) detectedLimit = Math.min(limit, lastPage);
                    }

                    // For Pornhub, pagination works with ?page=N parameter
                    const url = new URL(window.location.href);
                    const baseUrl = url.origin + url.pathname;

                    const fetchPage = async (pageNum) => {
                        try {
                            const pageUrl = new URL(baseUrl);
                            url.searchParams.forEach((value, key) => pageUrl.searchParams.set(key, value));
                            pageUrl.searchParams.set('page', pageNum);

                            const response = await fetch(pageUrl.href);
                            const text = await response.text();
                            const parser = new DOMParser();
                            const doc = parser.parseFromString(text, 'text/html');
                            return extractFromDoc(doc, pageUrl.href);
                        } catch (e) {
                            console.error(`Error scraping page ${pageNum}:`, e);
                            return [];
                        }
                    };

                    const promises = [];
                    for (let i = 2; i <= detectedLimit; i++) {
                        promises.push(fetchPage(i));
                    }

                    const extraResults = await Promise.all(promises);
                    extraResults.forEach(res => {
                        allResults = allResults.concat(res);
                    });
                }

                // Global De-duplication
                const unique = [];
                const seen = new Set();
                allResults.forEach(v => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit]
        });

        // Filter valid results
        const newVideos = (results[0].result || []).filter(v => v && v.url);

        allVideos = newVideos;
        currentlyFilteredVideos = [...allVideos];
        applyFilters();

        // Auto-send if enabled
        if (autoSend && allVideos.length > 0) {
            allVideos.forEach(v => selectedVideos.add(v.id));
            updateStats();

            // Helper to parse duration string to seconds for backend
            const parseDuration = (str) => {
                if (!str) return 0;
                try {
                    const parts = str.split(':').map(p => parseInt(p, 10));
                    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                    if (parts.length === 2) return parts[0] * 60 + parts[1];
                    return 0; // Unknown format
                } catch { return 0; }
            };

            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail === "MISSING_THUMBNAIL" ? null : v.thumbnail,
                filesize: v.size || 0,
                quality: v.quality,
                duration: parseDuration(v.duration)
            }));

            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_name: `Turbo: ${new Date().toLocaleDateString()}`, videos: toImport })
            }).catch(err => console.error("Turbo auto-send failed", err));
        }
    } catch (err) {
        console.error("Error during Pornhub scraping:", err);
        showError(`Failed to scrape Pornhub: ${err.message}`);
    }
}

async function handleNoodlemagazineScraping(tab) {
    console.log("Starting NoodleMagazine scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        document.getElementById('stats-text').innerText = isDeep
            ? "Deep Scan: Scraping up to 50 pages..."
            : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const parseViews = (raw) => {
                    const txt = String(raw || '').toUpperCase().trim();
                    if (!txt) return 0;
                    const num = parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
                    if (txt.includes('B')) return Math.round(num * 1000000000);
                    if (txt.includes('M')) return Math.round(num * 1000000);
                    if (txt.includes('K')) return Math.round(num * 1000);
                    return parseInt(txt.replace(/[^\d]/g, ''), 10) || 0;
                };

                const toAbsUrl = (href, baseUrl) => {
                    if (!href) return '';
                    try { return new URL(href, baseUrl).href; } catch { return ''; }
                };

                const normalizeThumb = (raw, baseUrl) => {
                    let thumbnail = raw || '';
                    if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;
                    if (!thumbnail) return "MISSING_THUMBNAIL";
                    return toAbsUrl(thumbnail, baseUrl) || thumbnail;
                };

                const secsToClock = (val) => {
                    const sec = parseInt(String(val || '').trim(), 10);
                    if (!isFinite(sec) || sec <= 0) return '';
                    const h = Math.floor(sec / 3600);
                    const m = Math.floor((sec % 3600) / 60);
                    const s = sec % 60;
                    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    return `${m}:${String(s).padStart(2, '0')}`;
                };

                const extractFromDoc = (doc, baseUrl) => {
                    const out = [];
                    const seen = new Set();
                    const pageUrl = toAbsUrl(baseUrl, baseUrl) || baseUrl;

                    // Single video detection
                    if (/\/(watch|video)\//i.test(pageUrl)) {
                         const h1 = doc.querySelector('h1');
                         const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
                         const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
                         const singleTitle = (h1?.textContent || ogTitle || doc.title || "Noodle Video").trim();
                         
                         out.push({
                             id: pageUrl,
                             title: singleTitle,
                             url: pageUrl,
                             source_url: pageUrl,
                             thumbnail: normalizeThumb(ogImage, pageUrl),
                             duration: '',
                             quality: 'HD',
                             views: 0
                         });
                         seen.add(pageUrl);
                    }

                    const cards = doc.querySelectorAll('.item, .video-item, .thumb-item, .card, li');
                    cards.forEach(card => {
                        const link = card.querySelector('a[href*="/watch/"], a[href*="/video/"]');
                        if (!link) return;
                        const videoUrl = toAbsUrl(link.getAttribute('href'), baseUrl);
                        if (!videoUrl || seen.has(videoUrl)) return;

                        const title = card.querySelector('.title, .name, h2, h3')?.innerText?.trim() || "Noodle Video";
                        const img = card.querySelector('img');
                        const thumbnail = normalizeThumb(img?.getAttribute('data-src') || img?.src, baseUrl);
                        const duration = card.querySelector('.duration, .time, .m_time')?.innerText?.trim() || '';
                        
                        seen.add(videoUrl);
                        out.push({
                            id: videoUrl,
                            title,
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail,
                            duration,
                            quality: 'HD',
                            views: 0
                        });
                    });
                    return out;
                };

                const fetchPage = async (base, pageNum) => {
                    try {
                        const url = new URL(base);
                        url.searchParams.set('page', pageNum);
                        const resp = await fetch(url.href);
                        if (!resp.ok) return [];
                        const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
                        return extractFromDoc(doc, url.href);
                    } catch { return []; }
                };

                let allResults = extractFromDoc(document, window.location.href);
                if (limit > 1) {
                    for (let p = 2; p <= limit; p++) {
                        const extra = await fetchPage(window.location.href, p);
                        allResults = allResults.concat(extra);
                        if (extra.length === 0) break;
                    }
                }

                const unique = [];
                const seen = new Set();
                allResults.forEach(v => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit],
        });

        allVideos = (results[0]?.result || []).filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        document.getElementById('folder-name').innerText = `NoodleMagazine ${isDeep ? '(Deep)' : isTurbo ? '(Turbo)' : ''}`;
        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            importVideos(allVideos, `NoodleMagazine ${new Date().toLocaleTimeString()}`);
        }
    } catch (err) {
        console.error("Error during NoodleMagazine scraping:", err);
        showError(`Failed to scrape NoodleMagazine: ${err.message}`);
    }
}

async function handlePornoneScraping(tab) {
    console.log("Starting PornOne scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        let pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        console.log(`PornOne scrape settings: turbo=${isTurbo}, deep=${isDeep}, autoSend=${autoSend}, pageLimit=${pageLimit}`);
        document.getElementById('stats-text').innerText = isDeep ? "Deep Scan: Scraping up to 50 pages..." : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const parseViews = (raw) => {
                    const txt = String(raw || '').toUpperCase().trim();
                    if (!txt) return 0;
                    const num = parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
                    if (txt.includes('B')) return Math.round(num * 1000000000);
                    if (txt.includes('M')) return Math.round(num * 1000000);
                    if (txt.includes('K')) return Math.round(num * 1000);
                    return parseInt(txt.replace(/[^\d]/g, ''), 10) || 0;
                };

                const normalizeUrl = (href, baseUrl) => {
                    if (!href) return '';
                    try {
                        const u = new URL(href, baseUrl);
                        if (!/\/(video|watch|v)\//i.test(u.pathname)) return '';
                        return u.href;
                    } catch {
                        return '';
                    }
                };

                const resolveThumb = (card, link) => {
                    const img =
                        card.querySelector('img[data-src], img[data-original], img[data-thumb], img[src]') ||
                        link.querySelector('img[data-src], img[data-original], img[src]');
                    let thumbnail =
                        img?.getAttribute('data-src') ||
                        img?.getAttribute('data-original') ||
                        img?.getAttribute('data-thumb') ||
                        img?.getAttribute('src') ||
                        '';
                    if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;
                    return thumbnail || "MISSING_THUMBNAIL";
                };

                const getCardText = (card) => (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();

                const extractFromDoc = (doc, baseUrl) => {
                    const cardSelectors = [
                        '.video-item',
                        '.thumb-block',
                        '.video-card',
                        '.item-video',
                        '.video',
                        '.thumb',
                        '.item',
                        'article',
                        'li',
                    ].join(', ');
                    const cards = doc.querySelectorAll(cardSelectors);
                    const out = [];

                    cards.forEach((card) => {
                        const link =
                            card.querySelector('a[href*="/video/"], a[href*="/watch/"], a[href*="/v/"]') ||
                            card.querySelector('a[href*="/video"], a[href*="/watch"], a[href*="/v/"]');
                        if (!link) return;

                        const videoUrl = normalizeUrl(link.getAttribute('href') || link.href || '', baseUrl);
                        if (!videoUrl) return;

                        const cardText = getCardText(card);
                        const title =
                            link.getAttribute('title') ||
                            link.getAttribute('data-title') ||
                            card.querySelector('.title, .video-title, h2, h3, .name')?.textContent?.trim() ||
                            link.querySelector('img')?.getAttribute('alt') ||
                            "PornOne Video";

                        const duration =
                            card.querySelector('.duration, .time, .video-duration, [class*="duration"], [class*="time"]')?.textContent?.trim() ||
                            '';

                        let quality = 'HD';
                        if (/4K|2160P/i.test(cardText)) quality = '4K';
                        else if (/1440P/i.test(cardText)) quality = '1440p';
                        else if (/1080P/i.test(cardText)) quality = '1080p';
                        else if (/720P/i.test(cardText)) quality = '720p';
                        else if (/480P|SD/i.test(cardText)) quality = 'SD';

                        const ratingText =
                            card.querySelector('.rating, .percent, .score, [class*="rating"]')?.textContent ||
                            '';
                        const rating = parseInt(String(ratingText).match(/(\d+)%?/)?.[1] || '0', 10) || 0;

                        const viewsText =
                            card.querySelector('.views, .view-count, [class*="view"]')?.textContent ||
                            '';
                        const views = parseViews(viewsText);

                        out.push({
                            id: videoUrl,
                            title: title.trim().slice(0, 260),
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail: resolveThumb(card, link),
                            rating,
                            views,
                            duration,
                            quality,
                            size: 0,
                        });
                    });

                    return out;
                };

                const buildCandidateUrls = (base, pageNum) => {
                    const out = [];
                    const u = new URL(base);
                    const cleanPath = u.pathname.replace(/\/+$/, '');

                    const withPage = new URL(base);
                    withPage.searchParams.set('page', String(pageNum));
                    out.push(withPage.href);

                    const withP = new URL(base);
                    withP.searchParams.set('p', String(pageNum));
                    out.push(withP.href);

                    const withPg = new URL(base);
                    withPg.searchParams.set('pg', String(pageNum));
                    out.push(withPg.href);

                    out.push(`${u.origin}${cleanPath}/page/${pageNum}`);
                    out.push(`${u.origin}${cleanPath}/${pageNum}`);
                    out.push(`${u.origin}${cleanPath}?page=${pageNum}`);
                    return Array.from(new Set(out));
                };

                const fetchPage = async (base, pageNum) => {
                    const candidates = buildCandidateUrls(base, pageNum);
                    for (const pageUrl of candidates) {
                        try {
                            const response = await fetch(pageUrl);
                            if (!response.ok) continue;
                            const text = await response.text();
                            const pageDoc = new DOMParser().parseFromString(text, 'text/html');
                            const rows = extractFromDoc(pageDoc, pageUrl);
                            if (rows.length > 0) return rows;
                        } catch (_) {
                            // Try next candidate URL
                        }
                    }
                    return [];
                };

                let allResults = extractFromDoc(document, window.location.href);
                if (limit > 1) {
                    const extraResults = await Promise.all(
                        Array.from({ length: Math.max(0, limit - 1) }, (_, i) => fetchPage(window.location.href, i + 2)),
                    );
                    extraResults.forEach((rows) => {
                        allResults = allResults.concat(rows);
                    });
                }

                const unique = [];
                const seen = new Set();
                allResults.forEach((v) => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit],
        });

        allVideos = (results[0]?.result || []).filter((v) => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        document.getElementById('folder-name').innerText = isDeep
            ? "PornOne Explorer (Deep)"
            : (isTurbo ? "PornOne Explorer (Turbo)" : "PornOne Explorer");
        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail === "MISSING_THUMBNAIL" ? null : v.thumbnail,
                filesize: v.size || 0,
                quality: v.quality,
                duration: parseDuration(v.duration),
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `${isDeep ? 'DeepScan' : 'Turbo'}: PornOne ${new Date().toLocaleDateString()}`,
                    videos: toImport,
                }),
            }).catch((err) => console.error("PornOne auto-send failed", err));
        }
    } catch (err) {
        console.error("Error during PornOne scraping:", err);
        showError(`Failed to scrape PornOne: ${err.message}`);
    }
}

async function handlePornhdScraping(tab) {
    console.log("Starting PornHD scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        document.getElementById('stats-text').innerText = isDeep
            ? "Deep Scan: Scraping up to 50 pages..."
            : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const parseViews = (raw) => {
                    const txt = String(raw || '').toUpperCase().trim();
                    if (!txt) return 0;
                    const num = parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
                    if (txt.includes('B')) return Math.round(num * 1000000000);
                    if (txt.includes('M')) return Math.round(num * 1000000);
                    if (txt.includes('K')) return Math.round(num * 1000);
                    return parseInt(txt.replace(/[^\d]/g, ''), 10) || 0;
                };

                const extractFromDoc = (doc, baseUrl) => {
                    const out = [];
                    const seen = new Set();

                    const toAbsUrl = (href) => {
                        if (!href) return '';
                        try {
                            return new URL(href, baseUrl).href;
                        } catch {
                            return '';
                        }
                    };

                    const isLikelyVideoUrl = (href) => {
                        if (!href) return false;
                        try {
                            const u = new URL(href, baseUrl);
                            const p = u.pathname.toLowerCase();
                            if (/\/(category|categories|pornstar|pornstars|channel|channels|model|models|tags?|search)\b/.test(p)) return false;
                            if (/\/(video|videos|watch|v)\b/.test(p)) return true;
                            return /-\d{4,}$/.test(p) || /\d{5,}/.test(p);
                        } catch {
                            return false;
                        }
                    };

                    const pushRow = (card, link, img) => {
                        const rawHref = link?.getAttribute('href') || link?.href || '';
                        const videoUrl = toAbsUrl(rawHref);
                        if (!videoUrl || !isLikelyVideoUrl(videoUrl) || seen.has(videoUrl)) return;

                        let thumbnail =
                            img?.getAttribute('data-src') ||
                            img?.getAttribute('data-original') ||
                            img?.getAttribute('data-thumb') ||
                            img?.getAttribute('src') ||
                            '';
                        if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;

                        const title =
                            link?.getAttribute('title') ||
                            link?.getAttribute('data-title') ||
                            img?.getAttribute('alt') ||
                            card?.querySelector('.title, .video-title, h2, h3, .name')?.textContent?.trim() ||
                            "PornHD Video";

                        const duration =
                            card?.querySelector('.duration, .time, .video-duration, [class*="duration"], [class*="time"]')?.textContent?.trim() || '';

                        const txt = ((card?.innerText || card?.textContent || '') + ' ' + (link?.innerText || '')).replace(/\s+/g, ' ');
                        let quality = 'HD';
                        if (/4K|2160P/i.test(txt)) quality = '4K';
                        else if (/1440P/i.test(txt)) quality = '1440p';
                        else if (/1080P/i.test(txt)) quality = '1080p';
                        else if (/720P/i.test(txt)) quality = '720p';
                        else if (/480P|SD/i.test(txt)) quality = 'SD';

                        const ratingText = card?.querySelector('.rating, .percent, [class*="rating"]')?.textContent || '';
                        const rating = parseInt(String(ratingText).match(/(\d+)%?/)?.[1] || '0', 10) || 0;

                        const viewsText = card?.querySelector('.views, .view-count, [class*="view"]')?.textContent || '';
                        const views = parseViews(viewsText);

                        seen.add(videoUrl);
                        out.push({
                            id: videoUrl,
                            title: title.trim().slice(0, 260),
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail: thumbnail || "MISSING_THUMBNAIL",
                            rating,
                            views,
                            duration,
                            quality,
                            size: 0,
                        });
                    };

                    // Primary: classic card selectors
                    doc.querySelectorAll('.video-item, .thumb, .item, article, li, [class*="video"], [class*="thumb"]').forEach((card) => {
                        const link =
                            card.querySelector('a[href*="/video"], a[href*="/videos"], a[href*="/watch"], a[href*="/v/"]') ||
                            card.querySelector('a[href]');
                        if (!link) return;
                        const img = card.querySelector('img');
                        pushRow(card, link, img);
                    });

                    // Fallback: any anchor that wraps a thumbnail image
                    doc.querySelectorAll('a[href] img').forEach((img) => {
                        const link = img.closest('a[href]');
                        if (!link) return;
                        const card =
                            link.closest('.video-item, .thumb, .item, article, li, [class*="video"], [class*="thumb"], [class*="cell"], [class*="grid"]') ||
                            link.parentElement;
                        pushRow(card, link, img);
                    });

                    return out;
                };

                const fetchPage = async (base, pageNum) => {
                    const tries = [];
                    const u = new URL(base);
                    const cleanPath = u.pathname.replace(/\/+$/, '');

                    const withPage = new URL(base);
                    withPage.searchParams.set('page', String(pageNum));
                    tries.push(withPage.href);

                    const withP = new URL(base);
                    withP.searchParams.set('p', String(pageNum));
                    tries.push(withP.href);

                    tries.push(`${u.origin}${cleanPath}/page/${pageNum}`);
                    tries.push(`${u.origin}${cleanPath}/${pageNum}`);

                    for (const pageUrl of Array.from(new Set(tries))) {
                        try {
                            const response = await fetch(pageUrl);
                            if (!response.ok) continue;
                            const text = await response.text();
                            const pageDoc = new DOMParser().parseFromString(text, 'text/html');
                            const rows = extractFromDoc(pageDoc, pageUrl);
                            if (rows.length > 0) return rows;
                        } catch {
                            // continue
                        }
                    }
                    return [];
                };

                let allResults = extractFromDoc(document, window.location.href);
                if (limit > 1) {
                    const pages = await Promise.all(
                        Array.from({ length: Math.max(0, limit - 1) }, (_, i) => fetchPage(window.location.href, i + 2)),
                    );
                    pages.forEach((rows) => {
                        allResults = allResults.concat(rows);
                    });
                }

                const unique = [];
                const seen = new Set();
                allResults.forEach((v) => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit],
        });

        allVideos = (results[0]?.result || []).filter((v) => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        document.getElementById('folder-name').innerText = isDeep
            ? "PornHD Explorer (Deep)"
            : (isTurbo ? "PornHD Explorer (Turbo)" : "PornHD Explorer");
        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map((v) => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail === "MISSING_THUMBNAIL" ? null : v.thumbnail,
                filesize: v.size || 0,
                quality: v.quality,
                duration: parseDuration(v.duration),
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `${isDeep ? 'DeepScan' : 'Turbo'}: PornHD ${new Date().toLocaleDateString()}`,
                    videos: toImport,
                }),
            }).catch((err) => console.error("PornHD auto-send failed", err));
        }
    } catch (err) {
        console.error("Error during PornHD scraping:", err);
        showError(`Failed to scrape PornHD: ${err.message}`);
    }
}

async function handleSxyprnScraping(tab) {
    console.log("Starting SxyPrn scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        document.getElementById('stats-text').innerText = isDeep
            ? "Deep Scan: Scraping up to 50 pages..."
            : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const parseViews = (raw) => {
                    const txt = String(raw || '').toUpperCase().trim();
                    if (!txt) return 0;
                    const num = parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
                    if (txt.includes('B')) return Math.round(num * 1000000000);
                    if (txt.includes('M')) return Math.round(num * 1000000);
                    if (txt.includes('K')) return Math.round(num * 1000);
                    return parseInt(txt.replace(/[^\d]/g, ''), 10) || 0;
                };

                const looksLikeMediaUrl = (href) => {
                    if (!href) return false;
                    try {
                        const u = new URL(href, location.href);
                        if (!/^https?:/.test(u.protocol)) return false;
                        if (u.hostname.includes('sxyprn.com') && /^\/($|top|tags|community|playlist|login|signup)/i.test(u.pathname)) {
                            return false;
                        }
                        return /\/(post|video|watch|v|embed|e)\//i.test(u.pathname) || !u.hostname.includes('sxyprn.com');
                    } catch {
                        return false;
                    }
                };

                const extractFromDoc = (doc, baseUrl) => {
                    const cards = doc.querySelectorAll(
                        '.item, .video-item, .thumb, article, li, [class*="post"], [class*="video"], [class*="wall"]',
                    );
                    const out = [];

                    cards.forEach((card) => {
                        const linkCandidates = card.querySelectorAll('a[href]');
                        let picked = null;
                        linkCandidates.forEach((a) => {
                            if (!picked && looksLikeMediaUrl(a.getAttribute('href') || a.href)) picked = a;
                        });
                        if (!picked) return;

                        let mediaUrl = picked.getAttribute('href') || picked.href || '';
                        try {
                            mediaUrl = new URL(mediaUrl, baseUrl).href;
                        } catch {
                            return;
                        }

                        const img = card.querySelector('img');
                        let thumbnail =
                            img?.getAttribute('data-src') ||
                            img?.getAttribute('data-original') ||
                            img?.getAttribute('src') ||
                            '';
                        if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;

                        const title =
                            picked.getAttribute('title') ||
                            img?.getAttribute('alt') ||
                            card.querySelector('.title, h2, h3, .name')?.textContent?.trim() ||
                            (card.textContent || '').trim().slice(0, 120) ||
                            "SxyPrn Post";

                        const duration =
                            card.querySelector('.duration, .time, [class*="duration"], [class*="time"]')?.textContent?.trim() || '';
                        const viewsText = card.querySelector('.views, .view-count, [class*="view"]')?.textContent || '';
                        const views = parseViews(viewsText);

                        const cardText = (card.innerText || card.textContent || '').replace(/\s+/g, ' ');
                        let quality = 'HD';
                        if (/4K|2160P/i.test(cardText)) quality = '4K';
                        else if (/1440P/i.test(cardText)) quality = '1440p';
                        else if (/1080P/i.test(cardText)) quality = '1080p';
                        else if (/720P/i.test(cardText)) quality = '720p';
                        else if (/480P|SD/i.test(cardText)) quality = 'SD';

                        out.push({
                            id: mediaUrl,
                            title: title.trim().slice(0, 260),
                            url: mediaUrl,
                            source_url: mediaUrl,
                            thumbnail: thumbnail || "MISSING_THUMBNAIL",
                            rating: 0,
                            views,
                            duration,
                            quality,
                            size: 0,
                        });
                    });

                    return out;
                };

                const fetchPage = async (base, pageNum) => {
                    const tries = [];
                    const u = new URL(base);
                    const cleanPath = u.pathname.replace(/\/+$/, '');

                    const withPage = new URL(base);
                    withPage.searchParams.set('page', String(pageNum));
                    tries.push(withPage.href);

                    const withP = new URL(base);
                    withP.searchParams.set('p', String(pageNum));
                    tries.push(withP.href);

                    tries.push(`${u.origin}${cleanPath}/page/${pageNum}`);
                    tries.push(`${u.origin}${cleanPath}/${pageNum}`);

                    for (const pageUrl of Array.from(new Set(tries))) {
                        try {
                            const response = await fetch(pageUrl);
                            if (!response.ok) continue;
                            const text = await response.text();
                            const pageDoc = new DOMParser().parseFromString(text, 'text/html');
                            const rows = extractFromDoc(pageDoc, pageUrl);
                            if (rows.length > 0) return rows;
                        } catch {
                            // continue
                        }
                    }
                    return [];
                };

                let allResults = extractFromDoc(document, window.location.href);
                if (limit > 1) {
                    const pages = await Promise.all(
                        Array.from({ length: Math.max(0, limit - 1) }, (_, i) => fetchPage(window.location.href, i + 2)),
                    );
                    pages.forEach((rows) => {
                        allResults = allResults.concat(rows);
                    });
                }

                const unique = [];
                const seen = new Set();
                allResults.forEach((v) => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit],
        });

        allVideos = (results[0]?.result || []).filter((v) => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        document.getElementById('folder-name').innerText = isDeep
            ? "SxyPrn Explorer (Deep)"
            : (isTurbo ? "SxyPrn Explorer (Turbo)" : "SxyPrn Explorer");
        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map((v) => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail === "MISSING_THUMBNAIL" ? null : v.thumbnail,
                filesize: v.size || 0,
                quality: v.quality,
                duration: parseDuration(v.duration),
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `${isDeep ? 'DeepScan' : 'Turbo'}: SxyPrn ${new Date().toLocaleDateString()}`,
                    videos: toImport,
                }),
            }).catch((err) => console.error("SxyPrn auto-send failed", err));
        }
    } catch (err) {
        console.error("Error during SxyPrn scraping:", err);
        showError(`Failed to scrape SxyPrn: ${err.message}`);
    }
}

async function handleFullpornerScraping(tab) {
    console.log("Starting FullPorner scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        document.getElementById('stats-text').innerText = isDeep
            ? "Deep Scan: Scraping up to 50 pages..."
            : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const parseViews = (raw) => {
                    const txt = String(raw || '').toUpperCase().trim();
                    if (!txt) return 0;
                    const num = parseFloat(txt.replace(/[^\d.]/g, '')) || 0;
                    if (txt.includes('B')) return Math.round(num * 1000000000);
                    if (txt.includes('M')) return Math.round(num * 1000000);
                    if (txt.includes('K')) return Math.round(num * 1000);
                    return parseInt(txt.replace(/[^\d]/g, ''), 10) || 0;
                };

                const toAbs = (href, baseUrl) => {
                    if (!href) return '';
                    try {
                        return new URL(href, baseUrl).href;
                    } catch {
                        return '';
                    }
                };

                const isLikelyVideoLink = (href, baseUrl) => {
                    const abs = toAbs(href, baseUrl);
                    if (!abs) return false;
                    try {
                        const u = new URL(abs);
                        const p = u.pathname.toLowerCase();
                        if (/\/(category|categories|model|models|pornstar|pornstars|tags?|search)\b/.test(p)) return false;
                        if (/\/(video|videos|watch|v)\b/.test(p)) return true;
                        return /-\d{4,}$/.test(p) || /\/\d{5,}(?:\/|$)/.test(p);
                    } catch {
                        return false;
                    }
                };

                const extractFromDoc = (doc, baseUrl) => {
                    const out = [];
                    const seen = new Set();

                    const addRow = (card, link, img) => {
                        const rawHref = link?.getAttribute('href') || link?.href || '';
                        if (!isLikelyVideoLink(rawHref, baseUrl)) return;
                        const videoUrl = toAbs(rawHref, baseUrl);
                        if (!videoUrl || seen.has(videoUrl)) return;

                        let thumbnail =
                            img?.getAttribute('data-src') ||
                            img?.getAttribute('data-original') ||
                            img?.getAttribute('data-thumb') ||
                            img?.getAttribute('src') ||
                            '';
                        if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;

                        const title =
                            link?.getAttribute('title') ||
                            link?.getAttribute('data-title') ||
                            img?.getAttribute('alt') ||
                            card?.querySelector('.title, .video-title, h2, h3, .name')?.textContent?.trim() ||
                            "FullPorner Video";

                        const duration =
                            card?.querySelector('.duration, .time, .video-duration, [class*="duration"], [class*="time"]')?.textContent?.trim() || '';

                        const cardText = ((card?.innerText || card?.textContent || '') + ' ' + (link?.innerText || '')).replace(/\s+/g, ' ');
                        let quality = 'HD';
                        if (/4K|2160P/i.test(cardText)) quality = '4K';
                        else if (/1440P/i.test(cardText)) quality = '1440p';
                        else if (/1080P/i.test(cardText)) quality = '1080p';
                        else if (/720P/i.test(cardText)) quality = '720p';
                        else if (/480P|SD/i.test(cardText)) quality = 'SD';

                        const ratingText = card?.querySelector('.rating, .percent, [class*="rating"]')?.textContent || '';
                        const rating = parseInt(String(ratingText).match(/(\d+)%?/)?.[1] || '0', 10) || 0;

                        const viewsText = card?.querySelector('.views, .view-count, [class*="view"]')?.textContent || '';
                        const views = parseViews(viewsText);

                        seen.add(videoUrl);
                        out.push({
                            id: videoUrl,
                            title: title.trim().slice(0, 260),
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail: thumbnail || "MISSING_THUMBNAIL",
                            rating,
                            views,
                            duration,
                            quality,
                            size: 0,
                        });
                    };

                    doc.querySelectorAll('.video-item, .thumb, .item, article, li, [class*="video"], [class*="thumb"], [class*="grid"]').forEach((card) => {
                        const link =
                            card.querySelector('a[href*="/video"], a[href*="/videos"], a[href*="/watch"], a[href*="/v/"]') ||
                            card.querySelector('a[href]');
                        if (!link) return;
                        const img = card.querySelector('img');
                        addRow(card, link, img);
                    });

                    doc.querySelectorAll('a[href] img').forEach((img) => {
                        const link = img.closest('a[href]');
                        if (!link) return;
                        const card =
                            link.closest('.video-item, .thumb, .item, article, li, [class*="video"], [class*="thumb"], [class*="grid"], [class*="cell"]') ||
                            link.parentElement;
                        addRow(card, link, img);
                    });

                    return out;
                };

                const fetchPage = async (base, pageNum) => {
                    const tries = [];
                    const u = new URL(base);
                    const cleanPath = u.pathname.replace(/\/+$/, '');

                    const withPage = new URL(base);
                    withPage.searchParams.set('page', String(pageNum));
                    tries.push(withPage.href);

                    const withP = new URL(base);
                    withP.searchParams.set('p', String(pageNum));
                    tries.push(withP.href);

                    const withPg = new URL(base);
                    withPg.searchParams.set('pg', String(pageNum));
                    tries.push(withPg.href);

                    tries.push(`${u.origin}${cleanPath}/page/${pageNum}`);
                    tries.push(`${u.origin}${cleanPath}/${pageNum}`);

                    for (const pageUrl of Array.from(new Set(tries))) {
                        try {
                            const response = await fetch(pageUrl);
                            if (!response.ok) continue;
                            const html = await response.text();
                            const pageDoc = new DOMParser().parseFromString(html, 'text/html');
                            const rows = extractFromDoc(pageDoc, pageUrl);
                            if (rows.length > 0) return rows;
                        } catch {
                            // continue
                        }
                    }
                    return [];
                };

                let allResults = extractFromDoc(document, window.location.href);
                if (limit > 1) {
                    const pages = await Promise.all(
                        Array.from({ length: Math.max(0, limit - 1) }, (_, i) => fetchPage(window.location.href, i + 2)),
                    );
                    pages.forEach((rows) => {
                        allResults = allResults.concat(rows);
                    });
                }

                const unique = [];
                const seen = new Set();
                allResults.forEach((v) => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit],
        });

        allVideos = (results[0]?.result || []).filter((v) => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        document.getElementById('folder-name').innerText = isDeep
            ? "FullPorner Explorer (Deep)"
            : (isTurbo ? "FullPorner Explorer (Turbo)" : "FullPorner Explorer");
        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            importVideos(allVideos, `FullPorner ${new Date().toLocaleDateString()}`);
        }
    } catch (err) {
        console.error("Error during FullPorner scraping:", err);
        showError(`Failed to scrape FullPorner: ${err.message}`);
    }
}

async function handleXvideosScraping(tab) {
    console.log("Starting XVideos scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        let pageLimit = isDeep ? 200 : (isTurbo ? 4 : 1);

        console.log(`XVideos scrape settings: turbo=${isTurbo}, deep=${isDeep}, autoSend=${autoSend}, pageLimit=${pageLimit}`);
        document.getElementById('stats-text').innerText = isDeep ? "Deep Scan: Scraping up to 200 pages..." : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const extractFromDoc = (doc, baseUrl) => {
                    const containers = doc.querySelectorAll('.thumb-block, .video-snippet, [data-id]');
                    
                    return Array.from(containers).map(container => {
                        const link = container.querySelector('a[href*="/video"]');
                        if (!link) return null;

                        const title = link.getAttribute('title') || 
                                     container.querySelector('.title, p a')?.innerText?.trim() || 
                                     "XVideos Video";
                        
                        const img = container.querySelector('img');
                        let thumbnail = img?.getAttribute('data-src') || img?.src;
                        if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;

                        const qRaw = container.innerText || "";
                        const qMatch = qRaw.match(/(4K|2160p|1440p|1080p|720p)/i);
                        const quality = qMatch ? qMatch[0] : (container.querySelector('.video-hd-mark, .hd-left') ? 'HD' : 'SD');

                        const duration = container.querySelector('.duration')?.innerText?.trim() || '';

                        let videoUrl = link.href;
                        if (!videoUrl.startsWith('http')) videoUrl = new URL(videoUrl, baseUrl).href;

                        return {
                            id: videoUrl,
                            title,
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail,
                            duration,
                            quality,
                            size: 0
                        };
                    }).filter(v => v && v.url);
                };

                let allResults = extractFromDoc(document, window.location.href);

                if (limit > 1) {
                    const pagerLinks = Array.from(document.querySelectorAll('.pagination a, .pager a, .pagination-links a'));
                    let maxPage = 1;
                    pagerLinks.forEach(a => {
                        const t = a.innerText.trim();
                        if (/^\d+$/.test(t)) maxPage = Math.max(maxPage, parseInt(t));
                    });

                    let detectedLimit = Math.min(limit, maxPage);
                    if (detectedLimit > 1) {
                        const currentUrl = window.location.href.split(/[?#]/)[0].replace(/\/$/, '');
                        const isFavorite = currentUrl.includes('/favorite/');
                        
                        // For favorites, ensure we have the base URL without page index
                        let baseUrl = currentUrl;
                        if (isFavorite) {
                            const parts = baseUrl.split('/');
                            if (/^\d+$/.test(parts[parts.length - 1])) {
                                parts.pop();
                                baseUrl = parts.join('/');
                            }
                        }

                        const fetchPage = async (pageNum) => {
                            try {
                                let url;
                                if (isFavorite) {
                                    url = `${baseUrl}/${pageNum - 1}`;
                                } else {
                                    const u = new URL(window.location.href);
                                    u.searchParams.set('p', pageNum - 1);
                                    url = u.href;
                                }
                                const response = await fetch(url);
                                const text = await response.text();
                                const doc = new DOMParser().parseFromString(text, 'text/html');
                                return extractFromDoc(doc, url);
                            } catch (e) { return []; }
                        };

                        const promises = [];
                        for (let i = 2; i <= detectedLimit; i++) {
                            promises.push(fetchPage(i));
                        }
                        const extras = await Promise.all(promises);
                        extras.forEach(res => { if (res) allResults = allResults.concat(res); });
                    }
                }
                // Global De-duplication
                const unique = [];
                const seen = new Set();
                allResults.forEach(v => {
                    if (v && v.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit]
        });

        const newVideos = (results[0].result || []).filter(v => v && v.url);
        allVideos = newVideos;
        currentlyFilteredVideos = [...allVideos];
        applyFilters();

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail,
                filesize: 0,
                quality: v.quality,
                duration: v.duration
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                batch_name: `${isDeep ? 'DeepScan' : 'Turbo'}: XVideos ${new Date().toLocaleDateString()}`, 
                videos: toImport 
            })
            }).catch(err => console.error("XVideos auto-send failed", err));
        }
    } catch (err) {
        console.error("Error during XVideos scraping:", err);
        showError(`Failed to scrape XVideos: ${err.message}`);
    }
}

async function handleEromeScraping(tab) {
    console.log("Starting Erome scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const qualityFromUrl = (url) => {
                    if (!url) return 'HD';
                    const m = url.match(/_(\d{3,4}p)\./i);
                    return m ? m[1] : 'HD';
                };

                const secsToStr = (sec) => {
                    if (!sec || !isFinite(sec) || sec <= 0) return '';
                    sec = Math.round(sec);
                    const h = Math.floor(sec / 3600);
                    const m = Math.floor((sec % 3600) / 60);
                    const s = sec % 60;
                    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
                    return `${m}:${String(s).padStart(2,'0')}`;
                };

                // Page-level metadata
                const pageTitle = document.querySelector('h1.title-h1, h1')?.textContent?.trim()
                    || document.querySelector('meta[property="og:title"]')?.content?.replace(' - Erome','').trim()
                    || document.title.replace(' - Erome','').trim();

                // Tags from the page's tag list
                const tagEls = document.querySelectorAll('.slogan-tag a, #tags a, .tags a, [href*="/tag/"], [href*="/search/"]');
                const tags = Array.from(tagEls)
                    .map(t => t.textContent.trim().replace(/^#/, ''))
                    .filter(t => t.length > 1);
                const tagsStr = tags.join(', ');

                const pageUrl = window.location.href;
                const isAlbum = pageUrl.includes('/a/');

                if (!isAlbum) {
                    // PROFILE MODE — return album links only (videos are inside albums)
                    const seen = new Set();
                    const albums = [];
                    document.querySelectorAll('a[href*="/a/"]').forEach(a => {
                        const href = a.href;
                        if (seen.has(href)) return;
                        seen.add(href);
                        const card = a.closest('.col-sm-6, .album-card, li, article') || a.parentElement;
                        const thumb = card?.querySelector('img')?.src || null;
                        const rawTitle = (card?.querySelector('.title, h4, .album-title, span')?.textContent
                            || a.textContent || 'Erome Album').trim().split('\n')[0];
                        const countMatch = (card?.innerText || '').match(/(\d+)\s*vids?/i);
                        albums.push({
                            id: href,
                            title: `[ALBUM] ${rawTitle}`,
                            url: href,
                            source_url: href,
                            thumbnail: thumb,
                            quality: 'ALBUM',
                            videoCount: countMatch ? parseInt(countMatch[1]) : 0,
                            duration: countMatch ? `${countMatch[1]} vids` : '',
                            tags: tagsStr,
                            size: 0
                        });
                    });
                    return { items: albums, albumTitle: pageTitle, tags: tagsStr };
                }

                // ALBUM MODE — extract ONLY video elements, skip images
                const seen = new Set();
                const videoItems = [];

                document.querySelectorAll('video').forEach((videoEl, idx) => {
                    const sourceEl = videoEl.querySelector('source');
                    let rawSrc = sourceEl?.getAttribute('src')
                        || videoEl.getAttribute('src')
                        || videoEl.getAttribute('data-src')
                        || '';
                    if (!rawSrc || rawSrc.startsWith('blob:')) return;
                    if (rawSrc.startsWith('//')) rawSrc = 'https:' + rawSrc;
                    if (seen.has(rawSrc)) return;
                    seen.add(rawSrc);

                    // Thumbnail: use video poster (Erome CDN thumbnail URL)
                    let poster = videoEl.getAttribute('poster') || null;
                    if (poster && poster.startsWith('//')) poster = 'https:' + poster;

                    // Quality from CDN URL filename
                    const quality = qualityFromUrl(rawSrc);

                    // Duration: JS property (available after metadata loads) or overlay text
                    let durationStr = '';
                    if (videoEl.duration && isFinite(videoEl.duration) && videoEl.duration > 0) {
                        durationStr = secsToStr(videoEl.duration);
                    } else {
                        const container = videoEl.closest('.media-group, .video-node, .video-container, .album-media') || videoEl.parentElement;
                        const durEl = container?.querySelector('.duration-badge, .video-duration, .duration, .time-overlay');
                        if (durEl) durationStr = durEl.textContent.trim();
                    }

                    // Per-video title (many Erome albums use album title for all clips)
                    const container = videoEl.closest('.media-group, .video-node, .video-container, .album-media') || videoEl.parentElement;
                    const titleEl = container?.querySelector('.video-title, .media-title, h4, h3');
                    const videoTitle = titleEl?.textContent?.trim() || pageTitle;

                    videoItems.push({
                        id: rawSrc,
                        title: videoTitle,
                        url: rawSrc,
                        source_url: pageUrl,
                        thumbnail: poster,
                        quality,
                        duration: durationStr,
                        tags: tagsStr,
                        size: 0
                    });
                });

                return { items: videoItems, albumTitle: pageTitle, tags: tagsStr };
            }
        });

        const data = results[0]?.result || { items: [], albumTitle: 'Erome', tags: '' };

        // Set folder-name so the import batch uses the album title
        const folderNameEl = document.getElementById('folder-name');
        if (folderNameEl) folderNameEl.innerText = data.albumTitle || 'Erome Import';

        allVideos = data.items.filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        applyFilters();
        updateStats();

        // Auto-send: select all and trigger import
        if (autoSend && allVideos.length > 0) {
            allVideos.forEach(v => selectedVideos.add(v.id));
            updateStats();
            document.getElementById('import-btn').click();
        }

    } catch (err) {
        console.error("Error during Erome scraping:", err);
        showError(`Failed to scrape Erome: ${err.message}`);
    }
}


async function handlePornhoarderScraping(tab) {
    console.log("Starting PornHoarder scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        const statsEl = document.getElementById('stats-text');
        if (statsEl) statsEl.innerText = isDeep ? 'PornHoarder Deep Scan…' : (isTurbo ? 'PornHoarder Turbo (4 stránky)…' : 'PornHoarder: načítavam…');

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const pageUrl = window.location.href;
                const isWatchPage = pageUrl.includes('/watch/');

                function parseSize(text) {
                    if (!text) return 0;
                    const m = String(text).match(/([\d.]+)\s*(GB|MB|KB)\b/i);
                    if (!m) return 0;
                    const n = parseFloat(m[1]);
                    const u = m[2].toUpperCase();
                    return Math.round(n * ({ GB: 1073741824, MB: 1048576, KB: 1024 }[u] || 1));
                }

                function parseDurationStr(text) {
                    if (!text) return 0;
                    const p = String(text).trim().split(':').map(Number);
                    if (p.some(isNaN)) return 0;
                    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
                    if (p.length === 2) return p[0] * 60 + p[1];
                    return 0;
                }

                function guessQuality(text) {
                    const t = String(text || '').toUpperCase();
                    if (/\b(4K|2160P|UHD)\b/.test(t)) return '4K';
                    if (/\b(1080P|FHD)\b/.test(t)) return '1080p';
                    if (/\b(720P)\b/.test(t)) return '720p';
                    if (/\b(480P)\b/.test(t)) return '480p';
                    return 'HD';
                }

                // ── SINGLE WATCH PAGE ─────────────────────────────────────────
                if (isWatchPage) {
                    const title = document.querySelector('h1')?.innerText?.trim()
                        || document.querySelector('meta[property="og:title"]')?.content?.replace('| Watch on PornHoarder.io', '').trim()
                        || document.title.replace('| Watch on PornHoarder.io', '').trim();

                    const thumbnail = document.querySelector('meta[property="og:image"]')?.content || '';

                    // Duration from JSON-LD
                    let duration = 0;
                    try {
                        const ld = document.querySelector('script[type="application/ld+json"]');
                        if (ld) {
                            const json = JSON.parse(ld.textContent);
                            if (json.duration) {
                                // ISO 8601 PT50M41S
                                const dm = json.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                                if (dm) duration = (parseInt(dm[1]||0)*3600) + (parseInt(dm[2]||0)*60) + parseInt(dm[3]||0);
                            }
                        }
                    } catch(e) {}

                    // Size + host from .video-info
                    const infoItems = document.querySelectorAll('.video-info .item');
                    let size = 0;
                    let host = '';
                    infoItems.forEach(el => {
                        const t = el.innerText.trim();
                        if (/GB|MB/i.test(t)) size = parseSize(t);
                        if (el.title && el.title.startsWith('hosted on')) host = el.title.replace('hosted on ', '');
                    });

                    // Studio
                    const studioEl = document.querySelector('.video-detail-keyword-list a[href*="/studio/"]');
                    const studio = studioEl?.innerText?.trim() || '';

                    // Quality from title
                    const quality = guessQuality(title);

                    // Try to get direct MP4/m3u8 URL for Nexus playback
                    let directVideoUrl = '';
                    const videoSrc = document.querySelector('video source[src], video[src]');
                    if (videoSrc) directVideoUrl = videoSrc.getAttribute('src') || videoSrc.src || '';
                    if (!directVideoUrl) {
                        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
                        for (const s of scripts) {
                            const m = s.textContent.match(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)['"]/);
                            if (m) { directVideoUrl = m[1]; break; }
                        }
                    }
                    // Extract provider embed URL (filemoon, voe, streamtape, doodstream, etc.)
                    // PornHoarder embeds these via iframe in player_t.php — check server buttons & links
                    let providerEmbedUrl = '';
                    const providerPatterns = [
                        /filemoon\.[a-z]+\/[a-z\/]+[a-zA-Z0-9_-]+/,
                        /voe\.sx\/[a-zA-Z0-9_-]+/,
                        /streamtape\.[a-z]+\/[a-z\/]+[a-zA-Z0-9_-]+/,
                        /dood(?:stream)?\.[a-z]+\/[a-z\/]+[a-zA-Z0-9_-]+/,
                        /bigwarp\.[a-z]+\/[a-z\/]+[a-zA-Z0-9_-]+/,
                        /lulustream\.[a-z]+\/[a-z\/]+[a-zA-Z0-9_-]+/,
                        /netu\.[a-z]+\/[a-z\/]+[a-zA-Z0-9_-]+/,
                    ];
                    const allText = document.documentElement.innerHTML;
                    for (const pat of providerPatterns) {
                        const m = allText.match(pat);
                        if (m) {
                            providerEmbedUrl = 'https://' + m[0];
                            break;
                        }
                    }

                    return {
                        mode: 'watch',
                        items: [{
                            id: pageUrl,
                            title,
                            url: directVideoUrl || providerEmbedUrl || embedUrl || pageUrl,
                            source_url: pageUrl,
                            thumbnail,
                            quality,
                            duration,
                            size,
                            studio,
                            host,
                        }],
                        pageTitle: title,
                    };
                }

                // ── LISTING PAGE (search, hp, categories, pornstars, studios…) ──
                function extractFromDoc(doc, baseUrl) {
                    const cards = doc.querySelectorAll('.video');
                    return Array.from(cards).map(card => {
                        const link = card.querySelector('a.video-link, a[href*="/watch/"]');
                        if (!link) return null;
                        let href = link.href || link.getAttribute('href') || '';
                        if (href.startsWith('/')) href = 'https://pornhoarder.io' + href;
                        if (!href.includes('/watch/')) return null;

                        const titleEl = card.querySelector('.video-content h1, .video-content h2, .video-content .title');
                        const title = titleEl?.innerText?.trim() || link.getAttribute('title') || href.split('/watch/')[1]?.split('/')[0]?.replace(/-/g, ' ') || 'PornHoarder Video';

                        // Thumbnail
                        const imgEl = card.querySelector('.video-image.primary, .video-image');
                        let thumbnail = '';
                        if (imgEl) {
                            const bg = imgEl.style.backgroundImage;
                            if (bg) {
                                const m = bg.match(/url\(["']?([^"')]+)/i);
                                if (m) thumbnail = m[1];
                            }
                            thumbnail = thumbnail || imgEl.getAttribute('data-src') || imgEl.src || '';
                        }
                        if (!thumbnail) {
                            const img = card.querySelector('img');
                            thumbnail = img?.getAttribute('data-src') || img?.src || '';
                        }

                        // Duration from .video-length overlay or title attr
                        const durEl = card.querySelector('.video-length');
                        const durationStr = durEl?.getAttribute('title') || durEl?.innerText?.trim() || '';
                        const duration = parseDurationStr(durationStr);

                        // Size from .video-meta items — prefer title attribute "video size is X.X GB"
                        let size = 0;
                        const metaItems = card.querySelectorAll('.video-meta .item');
                        metaItems.forEach(el => {
                            const ta = el.getAttribute('title') || '';
                            if (/video size is/i.test(ta)) {
                                size = parseSize(ta.replace(/video size is/i, '').trim());
                            } else if (!size && /GB|MB/i.test(ta)) {
                                size = parseSize(ta);
                            }
                        });
                        if (!size) {
                            const metaText = card.querySelector('.video-meta')?.innerText || '';
                            size = parseSize(metaText);
                        }

                        // Quality from title
                        const quality = guessQuality(title);

                        return {
                            id: href,
                            title,
                            url: href,
                            source_url: href,
                            thumbnail,
                            quality,
                            duration,
                            size,
                        };
                    }).filter(Boolean);
                }

                // Detect next-page URL pattern
                function nextPageUrl(currentUrl, pageNum) {
                    const url = new URL(currentUrl);
                    url.searchParams.set('page', pageNum);
                    return url.toString();
                }

                let allResults = extractFromDoc(document, pageUrl);
                const baseForPages = pageUrl.split(/[?#]/)[0];

                if (limit > 1 && allResults.length > 0) {
                    const fetches = [];
                    for (let p = 2; p <= limit; p++) {
                        fetches.push((async (pageNum) => {
                            try {
                                const url = nextPageUrl(pageUrl, pageNum);
                                const r = await fetch(url);
                                if (!r.ok) return [];
                                const html = await r.text();
                                return extractFromDoc(new DOMParser().parseFromString(html, 'text/html'), url);
                            } catch(e) { return []; }
                        })(p));
                    }
                    const extras = await Promise.all(fetches);
                    extras.forEach(arr => { allResults = allResults.concat(arr); });
                }

                // Deduplicate
                const seen = new Set();
                const unique = allResults.filter(v => {
                    if (!v || !v.url || seen.has(v.url)) return false;
                    seen.add(v.url);
                    return true;
                });

                const pageTitle = document.querySelector('h1')?.innerText?.trim()
                    || document.title.replace('| PornHoarder.io', '').trim()
                    || 'PornHoarder';

                return { mode: 'listing', items: unique, pageTitle };
            },
            args: [pageLimit]
        });

        const data = results[0]?.result || { mode: 'listing', items: [], pageTitle: 'PornHoarder' };

        allVideos = data.items.filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];

        const folderEl = document.getElementById('folder-name');
        if (folderEl) {
            folderEl.innerText = data.mode === 'watch'
                ? 'PornHoarder (video)'
                : `PornHoarder${isDeep ? ' (Deep)' : isTurbo ? ' (Turbo)' : ''}`;
        }

        applyFilters();
        updateStats();

        // Watch page — auto-import immediately, no user action needed
        if (data.mode === 'watch' && allVideos.length > 0) {
            const statsEl = document.getElementById('stats-text');
            if (statsEl) statsEl.innerText = 'PornHoarder: importujem…';
            await importVideos(allVideos, `PornHoarder: ${data.pageTitle}`);
            return;
        }

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail || null,
                filesize: v.size || 0,
                quality: v.quality,
                duration: v.duration || 0,
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `PornHoarder: ${data.pageTitle}`,
                    videos: toImport,
                }),
            }).catch(err => console.error('PornHoarder auto-send failed', err));
        }
    } catch (err) {
        console.error("Error during PornHoarder scraping:", err);
        showError(`Failed to scrape PornHoarder: ${err.message}`);
    }
}

async function handleArchivebateScraping(tab) {
    console.log("Starting Archivebate scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 40 : (isTurbo ? 5 : 1);
        const statsEl = document.getElementById('stats-text');
        if (statsEl) statsEl.innerText = isDeep ? 'Archivebate Deep Scan…' : (isTurbo ? 'Archivebate Turbo…' : 'Archivebate: načítavam…');

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const pageUrl = window.location.href;
                const isWatchPage = /\/watch\/\d+/i.test(pageUrl);

                const parseDurationToSeconds = (value) => {
                    if (!value) return 0;
                    const clean = String(value).trim();
                    const pt = clean.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
                    if (pt) return (parseInt(pt[1] || '0', 10) * 3600) + (parseInt(pt[2] || '0', 10) * 60) + parseInt(pt[3] || '0', 10);
                    const parts = clean.split(':').map(Number);
                    if (!parts.some(isNaN)) {
                        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                        if (parts.length === 2) return parts[0] * 60 + parts[1];
                    }
                    const m = clean.match(/(\d+)\s*(h|m|s|min|sec)/gi);
                    if (!m) return parseInt(clean.replace(/[^\d]/g, ''), 10) || 0;
                    let total = 0;
                    m.forEach((seg) => {
                        const n = parseInt(seg.replace(/[^\d]/g, ''), 10) || 0;
                        if (/h/i.test(seg)) total += n * 3600;
                        else if (/m|min/i.test(seg)) total += n * 60;
                        else if (/s|sec/i.test(seg)) total += n;
                    });
                    return total;
                };

                const parseSizeToBytes = (value) => {
                    if (!value) return 0;
                    const m = String(value).match(/([\d.]+)\s*(TB|GB|MB|KB|B)\b/i);
                    if (!m) return 0;
                    const n = parseFloat(m[1]);
                    const u = m[2].toUpperCase();
                    const mult = { TB: 1099511627776, GB: 1073741824, MB: 1048576, KB: 1024, B: 1 }[u] || 1;
                    return Math.round(n * mult);
                };

                const absolute = (raw, base) => {
                    try { return new URL(raw, base).href; } catch { return raw || ''; }
                };

                const detectQuality = (blob) => {
                    const t = String(blob || '').toUpperCase();
                    if (/\b(2160P?|4K|UHD)\b/.test(t)) return { quality: '4K', height: 2160, width: 3840 };
                    if (/\b(1440P?|2K)\b/.test(t)) return { quality: '1440p', height: 1440, width: 2560 };
                    if (/\b(1080P?|FHD)\b/.test(t)) return { quality: '1080p', height: 1080, width: 1920 };
                    if (/\b(720P?|HD)\b/.test(t)) return { quality: '720p', height: 720, width: 1280 };
                    if (/\b480P?\b/.test(t)) return { quality: '480p', height: 480, width: 854 };
                    return { quality: 'HD', height: 0, width: 0 };
                };

                const pickBestStream = (html, base) => {
                    if (!html) return { url: '', isHls: false, height: 0 };
                    const matches = [];
                    const re = /https?:\/\/[^"'\\\s<>]+?\.(?:m3u8|mp4)(?:\?[^"'\\\s<>]*)?/gi;
                    let m;
                    while ((m = re.exec(html))) {
                        const url = m[0];
                        const h = parseInt((url.match(/(?:^|[^\d])(2160|1440|1080|720|480|360)(?:p|[^\d]|$)/i)?.[1] || '0'), 10) || 0;
                        matches.push({ url: absolute(url, base), h, isHls: /\.m3u8(\?|$)/i.test(url) });
                    }
                    if (!matches.length) return { url: '', isHls: false, height: 0 };
                    matches.sort((a, b) => ((b.isHls ? 1 : 0) - (a.isHls ? 1 : 0)) || (b.h - a.h));
                    return { url: matches[0].url, isHls: matches[0].isHls, height: matches[0].h || 0 };
                };

                const collectListing = (doc, baseUrl) => {
                    const out = [];
                    const seen = new Set();
                    const links = Array.from(doc.querySelectorAll('a[href*="/watch/"]'));
                    const looksLikeDuration = (text) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(text || '').trim());
                    const isMetaLine = (text) => {
                        const t = String(text || '').trim();
                        return !t || looksLikeDuration(t) || /^\d+\s*(seconds?|minutes?|hours?|days?)\s+ago$/i.test(t) ||
                            /^(chaturbate|stripchat|camsoda|cam4|bongacams)$/i.test(t) || /^\d+\s+views?$/i.test(t) ||
                            /^#/.test(t) || /archivebate/i.test(t);
                    };
                    const compactTextLines = (el) => String(el?.innerText || el?.textContent || '')
                        .split(/\n+/)
                        .map(s => s.trim().replace(/\s+/g, ' '))
                        .filter(Boolean);
                    const findCard = (a) => {
                        let best = a;
                        for (let i = 0, node = a; node && i < 8; i++, node = node.parentElement) {
                            const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
                            const watchCount = node.querySelectorAll?.('a[href*="/watch/"]').length || 0;
                            const hasMedia = !!node.querySelector?.('img, picture, video, [style*="background-image"]');
                            if (watchCount > 4) break;
                            if (hasMedia && rect.width >= 90 && rect.height >= 70) best = node;
                        }
                        return best;
                    };
                    const pickTitle = (a, card, href) => {
                        const img = card?.querySelector('img');
                        const candidates = [
                            a.getAttribute('title'),
                            a.getAttribute('aria-label'),
                            img?.getAttribute('alt'),
                            card?.querySelector('[class*="title"],[class*="name"],h1,h2,h3')?.textContent,
                            ...compactTextLines(card).filter(line => !isMetaLine(line) && line.length <= 120),
                        ];
                        return (candidates.find(Boolean) || `Archivebate ${href.split('/watch/')[1] || 'video'}`)
                            .trim()
                            .replace(/\s+/g, ' ');
                    };
                    const srcsetBest = (srcset) => {
                        if (!srcset) return '';
                        const parts = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
                        return parts[parts.length - 1] || '';
                    };
                    const fromBackground = (el) => {
                        const bg = el?.style?.backgroundImage || '';
                        const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
                        return m ? m[1] : '';
                    };
                    const pickThumbnail = (card, base) => {
                        const candidates = [];
                        card?.querySelectorAll('img,picture source,video,[style*="background-image"]').forEach(el => {
                            candidates.push(
                                el.currentSrc,
                                el.getAttribute?.('data-src'),
                                el.getAttribute?.('data-original'),
                                el.getAttribute?.('data-lazy-src'),
                                el.getAttribute?.('poster'),
                                srcsetBest(el.getAttribute?.('srcset') || el.getAttribute?.('data-srcset')),
                                el.getAttribute?.('src'),
                                fromBackground(el)
                            );
                        });
                        for (const raw of candidates.filter(Boolean)) {
                            const url = absolute(raw, base);
                            if (!url || /^data:/i.test(url)) continue;
                            if (/\.(mp4|m3u8)(\?|$)/i.test(url)) continue;
                            if (/qr|qrcode|vlc|sprite|logo|avatar|placeholder/i.test(url)) continue;
                            return url;
                        }
                        return '';
                    };
                    const pickDuration = (card) => {
                        const textCandidates = [];
                        card?.querySelectorAll('*').forEach(el => {
                            const t = (el.innerText || el.textContent || '').trim();
                            if (looksLikeDuration(t)) textCandidates.push(t);
                        });
                        textCandidates.push(...compactTextLines(card).filter(looksLikeDuration));
                        return parseDurationToSeconds(textCandidates[0] || '');
                    };
                    links.forEach((a) => {
                        const href = absolute(a.getAttribute('href') || a.href || '', baseUrl);
                        if (!/\/watch\/\d+/i.test(href) || seen.has(href)) return;
                        seen.add(href);
                        const card = findCard(a);
                        const title = pickTitle(a, card, href);
                        const thumbnail = pickThumbnail(card, baseUrl);
                        const metaBlob = `${compactTextLines(card).slice(0, 8).join(' ')} ${title}`;
                        const duration = pickDuration(card);
                        const size = parseSizeToBytes(card?.textContent || '');
                        const q = detectQuality(metaBlob);
                        out.push({
                            id: href,
                            title,
                            url: href,
                            source_url: href,
                            thumbnail: thumbnail || '',
                            quality: q.quality,
                            duration,
                            size,
                            resolution: q.height ? `${q.height}p` : '',
                            width: q.width || 0,
                            height: q.height || 0,
                            stream_type: 'pending',
                            is_hls: false,
                        });
                    });
                    return out;
                };

                if (isWatchPage) {
                    const title = (
                        document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                        document.querySelector('h1')?.textContent ||
                        document.title
                    ).replace(/\s*[,|-]?\s*archivebate.*$/i, '').trim() || 'Archivebate Video';
                    const thumbnail = absolute(
                        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                        document.querySelector('video')?.getAttribute('poster') || '',
                        pageUrl
                    );
                    const ldJson = document.querySelector('script[type="application/ld+json"]')?.textContent || '';
                    const durMeta = document.querySelector('meta[property="video:duration"]')?.getAttribute('content') || '';
                    const duration = parseDurationToSeconds(durMeta || ldJson || document.body?.innerText || '');
                    const size = parseSizeToBytes(document.body?.innerText || '');
                    const streamFromDom =
                        absolute(document.querySelector('video source[src]')?.getAttribute('src') || document.querySelector('video[src]')?.getAttribute('src') || '', pageUrl);
                    const streamFromHtml = pickBestStream(document.documentElement.innerHTML, pageUrl);
                    const direct = streamFromDom || streamFromHtml.url || '';
                    const qualityMeta = detectQuality(`${title} ${document.body?.innerText || ''} ${direct}`);
                    const h = streamFromHtml.height || qualityMeta.height || 0;
                    return {
                        mode: 'watch',
                        pageTitle: title,
                        items: [{
                            id: pageUrl,
                            title,
                            url: direct || pageUrl,
                            source_url: pageUrl,
                            thumbnail: thumbnail || '',
                            quality: qualityMeta.quality || 'HD',
                            duration,
                            size,
                            resolution: h ? `${h}p` : '',
                            width: h ? Math.round(h * 16 / 9) : (qualityMeta.width || 0),
                            height: h,
                            is_hls: /\.m3u8(\?|$)/i.test(direct),
                            stream_type: direct ? (/\.m3u8(\?|$)/i.test(direct) ? 'HLS' : 'MP4') : 'pending',
                        }],
                    };
                }

                let all = collectListing(document, pageUrl);
                if (limit > 1) {
                    const tasks = [];
                    for (let p = 2; p <= limit; p++) {
                        tasks.push((async (pageNum) => {
                            try {
                                const u = new URL(pageUrl);
                                u.searchParams.set('page', String(pageNum));
                                const resp = await fetch(u.toString(), { credentials: 'include' });
                                if (!resp.ok) return [];
                                const html = await resp.text();
                                const doc = new DOMParser().parseFromString(html, 'text/html');
                                return collectListing(doc, u.toString());
                            } catch {
                                return [];
                            }
                        })(p));
                    }
                    const extra = await Promise.all(tasks);
                    extra.forEach((rows) => { all = all.concat(rows); });
                }

                const dedup = [];
                const seen = new Set();
                all.forEach((v) => {
                    if (!v || !v.url || seen.has(v.url)) return;
                    seen.add(v.url);
                    dedup.push(v);
                });
                return {
                    mode: 'listing',
                    pageTitle: document.querySelector('h1')?.textContent?.trim() || document.title.replace(/\s*[,|-]?\s*archivebate.*$/i, '').trim() || 'Archivebate',
                    items: dedup,
                };
            },
            args: [pageLimit]
        });

        const data = results[0]?.result || { mode: 'listing', pageTitle: 'Archivebate', items: [] };
        allVideos = (data.items || []).filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        const folderEl = document.getElementById('folder-name');
        if (folderEl) folderEl.innerText = data.mode === 'watch' ? 'Archivebate (video)' : `Archivebate${isDeep ? ' (Deep)' : isTurbo ? ' (Turbo)' : ''}`;

        applyFilters();
        updateStats();

        if (data.mode === 'watch' && allVideos.length > 0) {
            if (statsEl) statsEl.innerText = 'Archivebate: importujem…';
            await importVideos(allVideos, `Archivebate: ${data.pageTitle}`);
            return;
        }

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail || null,
                filesize: v.size || 0,
                quality: v.quality || v.resolution || 'HD',
                duration: v.duration || 0,
                is_hls: !!v.is_hls,
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `Archivebate: ${data.pageTitle}`,
                    videos: toImport,
                }),
            }).catch(err => console.error('Archivebate auto-send failed', err));
        }
    } catch (err) {
        console.error("Error during Archivebate scraping:", err);
        showError(`Failed to scrape Archivebate: ${err.message}`);
    }
}

async function handleRecurbateScraping(tab) {
    console.log("Starting Recurbate scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 40 : (isTurbo ? 5 : 1);
        const statsEl = document.getElementById('stats-text');
        if (statsEl) statsEl.innerText = isDeep ? 'Recurbate Deep Scan…' : (isTurbo ? 'Recurbate Turbo…' : 'Recurbate: načítavam…');

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const absolute = (value, base = location.href) => {
                    if (!value) return '';
                    try {
                        let u = String(value).trim();
                        if (u.startsWith('//')) u = 'https:' + u;
                        return new URL(u, base).href.split('#')[0];
                    } catch {
                        return '';
                    }
                };
                const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
                const isRecHost = (url) => /rec-ur-bate\.com|recurbate\.com/i.test(url || '');
                const looksLikeDuration = (txt) => /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(String(txt || ''));
                const guessQuality = (text) => {
                    const m = String(text || '').match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|HD)\b/i);
                    if (!m) return 'HD';
                    return m[1].toUpperCase() === 'HD' ? 'HD' : m[1].toUpperCase().replace('P', 'p');
                };
                const parseSize = (text) => {
                    const m = String(text || '').replace(',', '.').match(/\b([\d.]+)\s*(TB|GB|MB|KB)\b/i);
                    if (!m) return 0;
                    const mult = { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
                    return Math.round(parseFloat(m[1]) * (mult[m[2].toUpperCase()] || 1));
                };
                const isGarbageThumbToken = (value) => {
                    const t = String(value || '').trim();
                    if (!t) return true;
                    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true; // date
                    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t)) return true; // duration time
                    if (/^(hd|4k|play|views?)$/i.test(t)) return true;
                    if (/\s/.test(t) && !/^https?:\/\//i.test(t)) return true;
                    return false;
                };
                const isVideoUrl = (url, cardText) => {
                    try {
                        const u = new URL(url, location.href);
                        if (!isRecHost(u.href)) return false;
                        const path = u.pathname.toLowerCase().replace(/\/+$/, '');
                        if (!path || path === '/') return false;
                        if (/^\/(performers|live|categories|tags|genre|genres|account|login|signup|register|privacy|dmca|contact)$/i.test(path)) return false;
                        if (/\/(watch|video|embed|v|recording|recordings)\//i.test(path)) return true;
                        // Fallback: allow unknown URL shape only when card looks like a video tile.
                        return looksLikeDuration(cardText) && /\bhd\b|\b4k\b|\bviews?\b|\b\d+\s*%\b/i.test(cardText || '');
                    } catch {
                        return false;
                    }
                };
                const isLikelyVideoCard = (el) => {
                    if (!el) return false;
                    const txt = textOf(el);
                    const hasMedia = !!el.querySelector?.('img, picture, [style*="background-image"]');
                    return hasMedia && looksLikeDuration(txt) && /\bhd\b|\b4k\b|\bviews?\b|\b\d+\s*%\b/i.test(txt);
                };
                const findCard = (start) => {
                    let node = start;
                    let best = start;
                    for (let i = 0; node && i < 10; i++, node = node.parentElement) {
                        const links = node.querySelectorAll?.('a[href]').length || 0;
                        if (isLikelyVideoCard(node)) best = node;
                        if (isLikelyVideoCard(node) && links <= 8) break;
                    }
                    return best;
                };
                const pickThumb = (card, baseUrl) => {
                    const candidates = [];
                    card?.querySelectorAll('img,picture source,[style*="background-image"]').forEach((el) => {
                        const srcset = el.getAttribute?.('srcset');
                        const srcsetFirst = srcset ? String(srcset).split(',')[0].trim().split(/\s+/)[0] : '';
                        candidates.push(
                            el.currentSrc,
                            el.getAttribute?.('data-src'),
                            el.getAttribute?.('data-original'),
                            el.getAttribute?.('data-lazy-src'),
                            srcsetFirst,
                            el.getAttribute?.('src')
                        );
                        const bg = el?.style?.backgroundImage || '';
                        const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
                        if (m) candidates.push(m[1]);
                    });
                    let best = '';
                    let bestScore = -9999;
                    candidates.filter(Boolean).forEach((raw) => {
                        let src = String(raw).trim().split(/\s+/)[0];
                        if (isGarbageThumbToken(src)) return;
                        const url = absolute(src, baseUrl);
                        if (!url || /^data:/i.test(url)) return;
                        try {
                            const p = new URL(url);
                            const last = decodeURIComponent((p.pathname || '').split('/').filter(Boolean).pop() || '');
                            if (/^\d{4}-\d{2}-\d{2}$/.test(last)) return;
                        } catch (_) {}
                        let score = 0;
                        if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) score += 15;
                        if (/thumb|preview|poster|cover|record|video|gallery|cdn/i.test(url)) score += 20;
                        if (/flag|icon|logo|avatar|sprite|emoji|country|placeholder|blank|1x1|pixel|svg/i.test(url)) score -= 60;
                        if (/\.(mp4|m3u8)(\?|$)/i.test(url)) score -= 50;
                        if (score > bestScore) {
                            bestScore = score;
                            best = url;
                        }
                    });
                    return bestScore >= 0 ? best : '';
                };
                const titleFrom = (card, url) => {
                    const lines = String(card?.innerText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
                    const blocked = /^(play|watch|open|new|live|recordings?|share|clips?|videos?)$/i;
                    const candidateFromLines = lines.find((line) => {
                        if (line.length < 3 || line.length > 90) return false;
                        if (looksLikeDuration(line)) return false;
                        if (/^\W+$/.test(line)) return false;
                        if (blocked.test(line)) return false;
                        if (/\b(HD|4K|views?|mins?|hours?|ago|\d+%)\b/i.test(line)) return false;
                        return true;
                    });
                    if (candidateFromLines) return candidateFromLines;

                    // Recurbate cards usually contain creator usernames like "floret_joy_".
                    const userLike = lines.find((line) => /^[a-z0-9._-]{3,40}$/i.test(line) && !blocked.test(line));
                    if (userLike) return userLike;

                    const attrTitle =
                        card?.querySelector?.('[title]')?.getAttribute('title') ||
                        card?.querySelector?.('img[alt]')?.getAttribute('alt') ||
                        '';
                    if (attrTitle && !blocked.test(attrTitle.trim())) return attrTitle.trim();

                    try {
                        const parts = new URL(url).pathname.split('/').filter(Boolean);
                        const cleanedParts = parts.filter((p) =>
                            p &&
                            !/^(play|watch|video|videos|v|recording|recordings|embed)$/i.test(p) &&
                            !/^\d{4}-\d{2}-\d{2}$/.test(p)
                        );
                        const raw = cleanedParts[cleanedParts.length - 1] || parts[parts.length - 1] || 'Recurbate Video';
                        const title = decodeURIComponent(raw).replace(/[-_]+/g, ' ').trim();
                        if (title && !blocked.test(title)) return title;
                        return 'Recurbate Video';
                    } catch {
                        return 'Recurbate Video';
                    }
                };
                const scrapeDoc = (doc, baseUrl) => {
                    const items = [];
                    const seen = new Set();
                    const push = (rawUrl, card) => {
                        const url = absolute(rawUrl, baseUrl);
                        const text = textOf(card);
                        if (!url || seen.has(url) || !isVideoUrl(url, text)) return;
                        if (!looksLikeDuration(text)) return;
                        const thumb = pickThumb(card, baseUrl);
                        if (!thumb) return; // avoid noisy cards without real preview
                        seen.add(url);
                        items.push({
                            id: url,
                            title: titleFrom(card, url),
                            url,
                            source_url: url,
                            thumbnail: thumb,
                            duration: (String(text).match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [''])[0],
                            quality: guessQuality(text),
                            size: parseSize(text),
                            tags: 'recurbate',
                        });
                    };
                    const anchorSelector = 'a[href*="/record"],a[href*="/watch/"],a[href*="/video/"],a[href*="/v/"]';
                    doc.querySelectorAll(anchorSelector).forEach((a) => {
                        const card = findCard(a);
                        push(a.getAttribute('href') || a.href, card || a);
                    });
                    // fallback for custom cards with nested links
                    if (items.length < 3) {
                        doc.querySelectorAll('img').forEach((img) => {
                            const card = findCard(img);
                            if (!isLikelyVideoCard(card)) return;
                            const link = card.querySelector?.('a[href]');
                            if (link) push(link.getAttribute('href') || link.href, card);
                        });
                    }
                    return items;
                };

                let all = scrapeDoc(document, location.href);
                if (limit > 1 && !/\/(watch|video|embed|v|recording|recordings)\//i.test(location.pathname)) {
                    const pages = [];
                    for (let pageNum = 2; pageNum <= limit; pageNum++) {
                        pages.push((async () => {
                            try {
                                const u = new URL(location.href);
                                u.searchParams.set('page', pageNum);
                                const res = await fetch(u.href, { credentials: 'include' });
                                const html = await res.text();
                                return scrapeDoc(new DOMParser().parseFromString(html, 'text/html'), u.href);
                            } catch (e) {
                                console.warn('Recurbate page scrape failed', pageNum, e);
                                return [];
                            }
                        })());
                    }
                    (await Promise.all(pages)).forEach(items => { all = all.concat(items); });
                }
                const unique = [];
                const seen = new Set();
                all.forEach(v => {
                    if (v?.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return {
                    mode: /\/(watch|video|embed|v|recording|recordings)\//i.test(location.pathname) ? 'watch' : 'listing',
                    pageTitle: document.querySelector('h1')?.textContent?.trim() || document.title.replace(/\s*[,|-]?\s*(rec-ur-bate|recurbate).*$/i, '').trim() || 'Recurbate',
                    items: unique,
                };
            },
            args: [pageLimit],
        });

        const data = results[0]?.result || { mode: 'listing', pageTitle: 'Recurbate', items: [] };
        allVideos = (data.items || [])
            .filter(v => v && v.url)
            .map((v) => ({
                ...v,
                thumbnail_original: v.thumbnail || '',
                thumbnail: proxifyThumbnail(v.thumbnail || ''),
            }));
        currentlyFilteredVideos = [...allVideos];
        const folderEl = document.getElementById('folder-name');
        if (folderEl) folderEl.innerText = data.mode === 'watch' ? 'Recurbate (video)' : `Recurbate${isDeep ? ' (Deep)' : isTurbo ? ' (Turbo)' : ''}`;

        applyFilters();
        updateStats();

        if (data.mode === 'watch' && allVideos.length > 0 && statsEl) {
            statsEl.innerText = 'Recurbate video načítané. Import je manuálny (bez auto-importu).';
        }

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail_original || v.thumbnail,
                filesize: v.size || 0,
                quality: v.quality || 'HD',
                duration: parseDuration(v.duration),
                tags: v.tags || 'recurbate',
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `Recurbate: ${data.pageTitle}`,
                    videos: toImport,
                }),
            }).catch(err => console.error('Recurbate auto-send failed', err));
        }
    } catch (err) {
        console.error("Error during Recurbate scraping:", err);
        showError(`Failed to scrape Recurbate: ${err.message}`);
    }
}


function renderGrid(videos) {
    const grid = document.getElementById('video-grid');
    const loader = document.getElementById('loader');
    grid.innerHTML = '';

    // Apply list/grid class
    grid.classList.toggle('list-view', isListView);

    // Update videos badge
    const vcBadge = document.getElementById('videos-count-badge');
    if (vcBadge) vcBadge.textContent = videos.length;

    if (videos.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; opacity: 0.5;">Žiadne videá sa nenašli.</div>';
    } else {
        videos.forEach(video => {
            const isDup   = duplicateUrls.has(video.url);
            const isQueue = queuedVideos.has(video.id);
            const isSel   = selectedVideos.has(video.id);
            const isDirect = !!video.directUrl;

            const card = document.createElement('div');
            card.className = `video-card${isSel ? ' selected' : ''}${isDup ? ' duplicate' : ''}${isQueue ? ' queued' : ''}${isDirect ? ' direct-ok' : ''}`;
            card.setAttribute('data-id', video.id);

            const durDisplay = video.duration
                ? (typeof video.duration === 'number' ? formatTime(video.duration) : video.duration)
                : '';
            const qualityLabel = video.resolution || (video.quality && video.quality !== 'HD' ? String(video.quality).toUpperCase() : '');
            const hostLabel = getVideoHost(video);
            const pageHostLabel = getPageHost(video);
            const hostTooltip = pageHostLabel && pageHostLabel !== hostLabel
                ? `Stream: ${hostLabel} | Page: ${pageHostLabel}`
                : `Host: ${hostLabel}`;
            const smartMetaBits = [
                qualityLabel,
                durDisplay || '',
                video.size > 0 ? formatSizeCompact(video.size) : '',
                video.stream_type && video.stream_type !== 'pending' ? video.stream_type : (video.is_hls ? 'HLS' : (/\.(mp4)(\?|$)/i.test(video.url || '') ? 'MP4' : '')),
            ].filter(Boolean);

            card.innerHTML = `
                <div class="thumbnail">
                    <div class="selection-overlay"></div>
                    <div class="dup-badge">DUPE</div>
                    <div class="queue-badge">QUEUE</div>
                    <div class="direct-badge">DIRECT</div>
                    ${smartMetaBits.length ? `<div class="smart-preview-badge">${smartMetaBits.join(' · ')}</div>` : ''}
                    ${video.rating ? `<div style="position:absolute;bottom:5px;right:5px;background:rgba(0,0,0,0.8);color:#2ecc71;padding:2px 5px;border-radius:3px;font-size:10px;font-weight:bold;">★ ${video.rating}%</div>` : ''}
                </div>
                <div class="info">
                    <div class="title" title="${video.title}">${video.title}</div>
                    <div class="meta-info">
                        <span class="quality-badge">${video.quality || 'HD'}</span>
                        ${hostLabel ? `<span class="host-badge" title="${hostTooltip}">${hostLabel}</span>` : ''}
                        ${durDisplay ? `<span class="duration">🕒 ${durDisplay}</span>` : ''}
                        ${video.views ? `<span style="opacity:0.65;font-size:0.7rem;">👁 ${formatViews(video.views)}</span>` : ''}
                        ${video.size > 0 ? `<span class="file-size">${(video.size/1048576).toFixed(1)} MB</span>` : ''}
                    </div>
                </div>
            `;

            const img = document.createElement('img');
            const PLACEHOLDER_IMG = BUNKR_PLACEHOLDER_IMG;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';

            const srcUrl = String(video.source_url || '').toLowerCase();
            const isRecurbate = /rec-ur-bate\.com|recurbate\.com/i.test(srcUrl);

            if (video.bunkr_page_url && video.thumbnail && video.thumbnail !== 'MISSING_THUMBNAIL') {
                loadBunkrThumbnail(img, video.thumbnail, bunkrThumbPageOrigin);
            } else if (isRecurbate && video.thumbnail && video.thumbnail !== 'MISSING_THUMBNAIL') {
                img.src = video.thumbnail;
                img.referrerPolicy = 'no-referrer';
                img.onerror = () => {
                    const original = video.thumbnail_original;
                    if (original && img.src !== original) {
                        img.src = original;
                        img.referrerPolicy = 'strict-origin-when-cross-origin';
                        return;
                    }
                    if (img.src !== PLACEHOLDER_IMG) {
                        img.src = PLACEHOLDER_IMG;
                        img.onerror = null;
                    }
                };
            } else {
                img.src = video.thumbnail && video.thumbnail !== 'MISSING_THUMBNAIL' ? video.thumbnail : PLACEHOLDER_IMG;
                img.referrerPolicy = 'no-referrer';
                img.onerror = () => { if (img.src !== PLACEHOLDER_IMG) { img.src = PLACEHOLDER_IMG; img.onerror = null; } };
            }
            card.querySelector('.thumbnail').prepend(img);

            card.onclick = () => toggleSelection(video, card);
            grid.appendChild(card);
        });
    }

    loader.style.display = 'none';
    grid.style.display = 'grid';
}

function formatViews(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

function formatTime(seconds) {
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSizeCompact(bytes) {
    const val = Number(bytes || 0);
    if (!val || val <= 0) return '';
    if (val >= 1073741824) return `${(val / 1073741824).toFixed(1)} GB`;
    if (val >= 1048576) return `${(val / 1048576).toFixed(1)} MB`;
    if (val >= 1024) return `${(val / 1024).toFixed(1)} KB`;
    return `${val} B`;
}

function toggleSelection(video, card) {
    if (selectedVideos.has(video.id)) {
        selectedVideos.delete(video.id);
        card.classList.remove('selected');
    } else {
        selectedVideos.add(video.id);
        card.classList.add('selected');
    }
    updateStats();
}

function updateStats() {
    const statsText = document.getElementById('stats-text');
    const importBtn = document.getElementById('import-btn');
    const copyBtn   = document.getElementById('copy-btn');
    const copyDirectBtn = document.getElementById('copy-direct-btn');
    const queueBtn  = document.getElementById('queue-btn');

    if (statsText) statsText.innerText = `${allVideos.length} videí | Vybraných: ${selectedVideos.size}`;
    if (importBtn) { importBtn.innerText = `Importovať (${selectedVideos.size})`; importBtn.disabled = selectedVideos.size === 0; }
    if (copyBtn)   copyBtn.disabled   = selectedVideos.size === 0;
    if (queueBtn)  queueBtn.disabled  = selectedVideos.size === 0;

    // Direct copy button logic
    if (copyDirectBtn) {
        const selectedList = (currentlyFilteredVideos || []).filter(v => selectedVideos.has(v.id));
        const hasAnyDirect = selectedList.some(v => !!v.directUrl);
        copyDirectBtn.disabled = !hasAnyDirect;
    }

    // Badge
    const vcBadge = document.getElementById('videos-count-badge');
    if (vcBadge) vcBadge.textContent = allVideos.length;
    
    const findDirectBtn = document.getElementById('find-direct-btn');
    if (findDirectBtn) {
        findDirectBtn.style.display = (allVideos.length > 0 && !isBackgroundResolving) ? 'block' : 'none';
    }
}

function parseDuration(str) {
    if (!str) return 0;
    try {
        const parts = str.replace(/[^\d:]/g, '').split(':').map(p => parseInt(p, 10));
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0] || 0;
    } catch { return 0; }
};

const fullpornerDirectCache = new Map();
const noodleMetadataCache = new Map();

function noodleQualityFromMeta(doc, fallbackText = '') {
    const h = parseInt(doc.querySelector('meta[property="og:video:height"]')?.getAttribute('content') || '0', 10) || 0;
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';

    const t = String(fallbackText || '').toUpperCase();
    if (/4K|2160P|UHD/.test(t)) return '4K';
    if (/1440P|2K/.test(t)) return '1440p';
    if (/1080P|FHD/.test(t)) return '1080p';
    if (/720P|HD/.test(t)) return '720p';
    if (/480P|SD/.test(t)) return '480p';
    return 'HD';
}

async function resolveNoodleMetadata(watchUrl) {
    const key = String(watchUrl || '').trim();
    if (!/noodlemagazine\.com\/(watch|video)\//i.test(key)) return null;
    if (noodleMetadataCache.has(key)) return noodleMetadataCache.get(key);

    let out = null;
    try {
        const resp = await fetch(key, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const title =
            doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
            doc.querySelector('h1')?.textContent?.trim() ||
            doc.title?.replace(/\s*(watch online|video)\s*$/i, '').trim() ||
            '';
        const thumbnail = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
        const directUrl =
            doc.querySelector('meta[property="ya:ovs:content_url"]')?.getAttribute('content') ||
            doc.querySelector('meta[itemprop="contentUrl"]')?.getAttribute('content') ||
            '';
        const durSec =
            parseInt(doc.querySelector('meta[property="og:video:duration"]')?.getAttribute('content') || '0', 10) ||
            parseInt(doc.querySelector('meta[property="ya:ovs:duration"]')?.getAttribute('content') || '0', 10) ||
            0;
        const quality = noodleQualityFromMeta(doc, `${title} ${doc.body?.innerText || ''}`);

        out = {
            title: title || null,
            thumbnail: thumbnail || null,
            directUrl: directUrl || null,
            duration: durSec > 0 ? durSec : 0,
            quality: quality || null,
        };
    } catch (e) {
        console.warn('resolveNoodleMetadata failed', key, e);
    }

    noodleMetadataCache.set(key, out);
    return out;
}

let backgroundResolveAbortController = null;

async function startBackgroundResolution() {
    if (isBackgroundResolving) return;
    isBackgroundResolving = true;
    updateStats(); // Hide the button

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTabId = activeTab?.id || null;

    if (backgroundResolveAbortController) {
        backgroundResolveAbortController.abort();
    }
    backgroundResolveAbortController = new AbortController();
    const signal = backgroundResolveAbortController.signal;

    const bgStats = document.getElementById('bg-fetch-stats');
    if (bgStats) bgStats.style.display = 'inline';

    let processedCount = 0;
    let foundCount = 0;
    const toResolve = allVideos.filter(v => !v.directUrl);
    if (toResolve.length === 0) {
        isBackgroundResolving = false;
        if (bgStats) bgStats.style.display = 'none';
        updateStats();
        return;
    }

    console.log(`[BackgroundResolve] Starting for ${toResolve.length} videos...`);

    const CONCURRENCY = 2; // Low concurrency to avoid being blocked
    for (let i = 0; i < toResolve.length; i += CONCURRENCY) {
        if (signal.aborted) break;

        const chunk = toResolve.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(async (video) => {
            if (signal.aborted) return;

            try {
                let direct = null;
                const url = video.source_url || video.url;

                // 1. Check if already captured in background.js
                const captured = await new Promise(resolve => {
                    chrome.runtime.sendMessage({ action: "GET_CAPTURED_STREAM", pageUrl: url }, (resp) => {
                        resolve(resp?.data?.streamUrl || null);
                    });
                });

                if (captured) {
                    direct = captured;
                } else {
                    // 2. Site specific logic
                    if (/(?:leakporner\.com|djav\.org)/i.test(video.source_url || '') || /(?:leakporner\.com|djav\.org)/i.test(video.url || '')) {
                        direct = await resolveLeakLikeDirectUrlInTab(activeTabId, video.source_url || video.url);
                        if (!direct) {
                            direct = await resolveLeakLikeDirectViaBackend(video.source_url || video.url);
                        }
                    } else
                    if (/noodlemagazine\.com/i.test(url)) {
                        const meta = await resolveNoodleMetadata(url);
                        if (meta?.directUrl) direct = meta.directUrl;
                    } else if (/fullporner\.com/i.test(url)) {
                        direct = await resolveFullpornerDirectUrl(url);
                    } else if (/bunkr/i.test(url)) {
                        // For Bunkr, we might need to fetch the file page
                        if (video.bunkr_page_url) {
                            direct = await bunkrFetchPageExtract(video.bunkr_page_url);
                        } else if (url.includes('/v/') || url.includes('/f/')) {
                            direct = await bunkrFetchPageExtract(url);
                        }
                    } else if (/filester\.v/i.test(url)) {
                         // Filester resolution if possible
                         const resp = await fetch(url);
                         if (resp.ok) {
                             direct = extractMediaUrlFromHtml(await resp.text(), url);
                         }
                    } else {
                        // Generic fallback
                        const resp = await fetch(url);
                        if (resp.ok) {
                            direct = extractMediaUrlFromHtml(await resp.text(), url);
                        }
                    }
                }

                if (direct && direct !== url) {
                    video.directUrl = direct;
                    try {
                        video.playback_host = normalizeHostName(new URL(direct, location.href).hostname);
                    } catch {}
                    // Update the video in allVideos as well (redundant but safe)
                    const original = allVideos.find(v => v.id === video.id);
                    if (original) {
                        original.directUrl = direct;
                        if (!original.playback_host) {
                            try {
                                original.playback_host = normalizeHostName(new URL(direct, location.href).hostname);
                            } catch {}
                        }
                    }
                    
                    // Partial UI Update: find the card by data-id and add class
                    try {
                        const card = document.querySelector(`.video-card[data-id="${CSS.escape(video.id)}"]`);
                        if (card) {
                            card.classList.add('direct-ok');
                            foundCount++;
                            updateStats(); 
                        }
                    } catch (e) {
                        // Fallback to title matching if ID has problematic characters or querySelector fails
                        const grid = document.getElementById('video-grid');
                        if (grid) {
                            const cards = grid.querySelectorAll('.video-card');
                            for (const card of cards) {
                                const titleEl = card.querySelector('.title');
                                if (titleEl && titleEl.textContent === video.title) {
                                    card.classList.add('direct-ok');
                                    foundCount++;
                                    updateStats();
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn(`[BackgroundResolve] Failed for ${video.title}`, e);
            }
            processedCount++;
            if (bgStats) bgStats.innerText = `DIRECT: ${foundCount}/${toResolve.length} hľadá sa...`;
        }));

        // Throttle
        await new Promise(r => setTimeout(r, 1000));
    }

    if (bgStats) {
        bgStats.innerText = `DIRECT: ${foundCount} nájdených`;
        setTimeout(() => { if (bgStats) bgStats.style.display = 'none'; }, 5000);
    }

    // Save final state to cache
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && allVideos.length > 0) {
        await saveToCache(tab.url, allVideos);
    }
}

function extractMediaUrlFromHtml(html, baseUrl) {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const sourceNodes = Array.from(doc.querySelectorAll('video source[src], source[src], video[src]'));
    if (sourceNodes.length) {
        let best = null;
        let bestQ = -1;
        for (const node of sourceNodes) {
            const raw = node.getAttribute('src') || node.src || '';
            if (!raw) continue;
            try {
                const abs = new URL(raw, baseUrl).href;
                const qFromTitle = parseInt((node.getAttribute('title') || '').replace(/[^\d]/g, ''), 10) || 0;
                const qFromUrl = parseInt((abs.match(/\/(\d{3,4})(?:\/|$|\?)/)?.[1] || '0'), 10) || 0;
                const q = Math.max(qFromTitle, qFromUrl);
                const acceptable =
                    /\.(m3u8|mp4|mkv|webm|mov)(\?|$)/i.test(abs) ||
                    /\/\/[^/]*xiaoshenke\.net\/vid\/\d+\/\d+(?:\/b)?(?:\?|$)/i.test(abs);
                if (!acceptable) continue;
                if (q >= bestQ) {
                    bestQ = q;
                    best = abs;
                }
            } catch {}
        }
        if (best) return best;
    }

    const mediaRegex = /https?:\/\/[^"'\\\s<>]+?\.(m3u8|mp4|mkv|webm|mov)(?:\?[^"'\\\s<>]*)?/gi;
    const matches = html.match(mediaRegex);
    if (matches && matches.length) return matches[0];

    const xiaoRegex = /(?:https?:)?\/\/[^"'\\\s<>]*xiaoshenke\.net\/vid\/\d+\/\d+(?:\/b)?(?:\?[^"'\\\s<>]*)?/gi;
    const xiao = html.match(xiaoRegex);
    if (xiao && xiao.length) {
        let best = xiao[0].startsWith('//') ? `https:${xiao[0]}` : xiao[0];
        let bestQ = parseInt((best.match(/\/(\d{3,4})(?:\/|$|\?)/)?.[1] || '0'), 10) || 0;
        for (const candRaw of xiao) {
            const cand = candRaw.startsWith('//') ? `https:${candRaw}` : candRaw;
            const q = parseInt((cand.match(/\/(\d{3,4})(?:\/|$|\?)/)?.[1] || '0'), 10) || 0;
            if (q >= bestQ) {
                best = cand;
                bestQ = q;
            }
        }
        return best;
    }
    return null;
}

async function resolveFullpornerDirectUrl(watchUrl) {
    if (!watchUrl || !/fullporner\.com\/watch\//i.test(watchUrl)) return null;
    if (fullpornerDirectCache.has(watchUrl)) return fullpornerDirectCache.get(watchUrl);
    let resolved = null;
    try {
        const resp = await fetch(watchUrl, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        resolved = extractMediaUrlFromHtml(html, watchUrl);
        if (!resolved) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const iframe = doc.querySelector('.single-video iframe[src], iframe[src*="embed"], iframe[src]');
            const iframeSrcRaw = iframe?.getAttribute('src') || '';
            if (iframeSrcRaw) {
                const iframeUrl = new URL(iframeSrcRaw, watchUrl).href;
                const iframeResp = await fetch(iframeUrl, { credentials: 'include' });
                if (iframeResp.ok) {
                    resolved = extractMediaUrlFromHtml(await iframeResp.text(), iframeUrl);
                }
            }
        }
    } catch (e) {
        console.warn('resolveFullpornerDirectUrl failed', watchUrl, e);
    }
    const finalUrl = resolved || null;
    fullpornerDirectCache.set(watchUrl, finalUrl);
    return finalUrl;
}

async function resolveLeakLikeDirectUrlInTab(tabId, watchUrl) {
    if (!tabId || !watchUrl || !/(?:leakporner\.com|djav\.org)/i.test(watchUrl)) return null;
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (u) => {
                const isPlayable = (raw) => /\.(m3u8|mp4|webm|m4v)(\?|$)/i.test(String(raw || ''));
                const norm = (raw) => {
                    const s = String(raw || '').trim();
                    if (!s) return '';
                    if (s.startsWith('//')) return `https:${s}`;
                    return s;
                };
                const decodeB64Url = (raw) => {
                    const text = String(raw || '').trim().replace(/-/g, '+').replace(/_/g, '/');
                    const padded = text + '='.repeat((4 - (text.length % 4 || 4)) % 4);
                    const bin = atob(padded);
                    const out = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                    return out;
                };
                const concatBytes = (parts) => {
                    const total = parts.reduce((acc, p) => acc + p.length, 0);
                    const out = new Uint8Array(total);
                    let offset = 0;
                    for (const p of parts) {
                        out.set(p, offset);
                        offset += p.length;
                    }
                    return out;
                };
                const resolveBysePlayback = async (embedUrl) => {
                    try {
                        const m = String(embedUrl || '').match(/\/(?:e|kpw)\/([a-zA-Z0-9_-]+)/);
                        if (!m) return null;
                        const code = m[1];
                        const apiUrl = `https://bysezoxexe.com/api/videos/${code}/embed/playback`;
                        const resp = await fetch(apiUrl, {
                            credentials: 'omit',
                            headers: {
                                'Accept': 'application/json',
                                'Referer': 'https://w12.leakporner.com/',
                                'Origin': 'https://bysezoxexe.com',
                            },
                        });
                        if (!resp.ok) return null;
                        const data = await resp.json();
                        const playback = data?.playback || {};
                        const keyParts = Array.isArray(playback.key_parts) ? playback.key_parts : [];
                        const iv = playback.iv || '';
                        const payload = playback.payload || '';
                        if (!keyParts.length || !iv || !payload) return null;

                        const keyRaw = concatBytes(keyParts.map((p) => decodeB64Url(p)));
                        const nonce = decodeB64Url(iv);
                        const ciphertext = decodeB64Url(payload);
                        const cryptoKey = await crypto.subtle.importKey('raw', keyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
                        const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, ciphertext);
                        const plainJson = JSON.parse(new TextDecoder().decode(new Uint8Array(plainBuf)));
                        const sources = Array.isArray(plainJson?.sources) ? plainJson.sources : [];
                        if (!sources.length) return null;
                        const sorted = sources
                            .map((s) => ({
                                url: String(s?.url || '').trim(),
                                bitrate: Number(s?.bitrate_kbps || 0),
                                height: Number(s?.height || 0),
                            }))
                            .filter((s) => !!s.url)
                            .sort((a, b) => {
                                const aPlayable = isPlayable(a.url) ? 1 : 0;
                                const bPlayable = isPlayable(b.url) ? 1 : 0;
                                if (aPlayable !== bPlayable) return bPlayable - aPlayable;
                                if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
                                return b.height - a.height;
                            });
                        const best = sorted.find((s) => isPlayable(s.url));
                        return best?.url || null;
                    } catch {
                        return null;
                    }
                };
                const collectEmbedsFromHtml = (html, baseUrl) => {
                    const out = [];
                    const seen = new Set();
                    const push = (raw) => {
                        const n = norm(raw);
                        if (!n) return;
                        try {
                            const abs = new URL(n, baseUrl).href;
                            if (seen.has(abs)) return;
                            seen.add(abs);
                            out.push(abs);
                        } catch {}
                    };
                    try {
                        const doc = new DOMParser().parseFromString(html || '', 'text/html');
                        doc.querySelectorAll('.servideo .change-video, .change-video').forEach((el) => push(el.getAttribute('data-embed')));
                    } catch {}
                    const re = /data-embed=["']([^"']+)["']/gi;
                    for (const m of String(html || '').matchAll(re)) push(m[1]);
                    return out;
                };
                const extract = (html, baseUrl) => {
                    if (!html) return null;
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const nodes = Array.from(doc.querySelectorAll('video source[src], source[src], video[src], meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]'));
                    for (const node of nodes) {
                        const raw = node.getAttribute?.('src') || node.getAttribute?.('content') || node.src || '';
                        if (!raw) continue;
                        try {
                            const abs = new URL(norm(raw), baseUrl).href;
                            if (/^blob:/i.test(abs) || /^data:/i.test(abs)) continue;
                            if (isPlayable(abs)) return abs;
                        } catch {}
                    }
                    const re = /https?:\/\/[^"'\\\s<>]+?\.(?:m3u8|mp4|webm|m4v)(?:\?[^"'\\\s<>]*)?/gi;
                    const matches = String(html).match(re) || [];
                    return matches.length ? matches[0] : null;
                };
                const fetchHtml = async (urlToFetch, referer) => {
                    try {
                        const resp = await fetch(urlToFetch, {
                            credentials: 'include',
                            headers: referer ? { Referer: referer } : undefined,
                        });
                        if (!resp.ok) return null;
                        return await resp.text();
                    } catch {
                        return null;
                    }
                };

                const html = await fetchHtml(u, location.href);
                if (!html) return null;
                let resolved = extract(html, u);
                if (resolved && isPlayable(resolved)) return resolved;

                const embeds = collectEmbedsFromHtml(html, u);
                for (const embed of embeds.slice(0, 5)) {
                    if (/(?:bysezoxexe\.com|398fitus\.com)/i.test(embed)) {
                        const byse = await resolveBysePlayback(embed);
                        if (byse && isPlayable(byse)) return byse;
                    }
                    const embedHtml = await fetchHtml(embed, u);
                    const fromEmbed = extract(embedHtml, embed);
                    if (fromEmbed && isPlayable(fromEmbed)) return fromEmbed;
                }

                try {
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const iframe = doc.querySelector('iframe[src]');
                    const iframeSrc = iframe?.getAttribute('src') || '';
                    if (iframeSrc) {
                        const iframeUrl = new URL(norm(iframeSrc), u).href;
                        const iframeHtml = await fetchHtml(iframeUrl, u);
                        const fromIframe = extract(iframeHtml, iframeUrl);
                        if (fromIframe && isPlayable(fromIframe)) return fromIframe;
                    }
                } catch {}

                return null;
            },
            args: [watchUrl],
        });
        return results?.[0]?.result || null;
    } catch (e) {
        console.warn('resolveLeakLikeDirectUrlInTab failed', watchUrl, e);
        return null;
    }
}

async function resolveLeakLikeDirectViaBackend(watchUrl) {
    try {
        if (!watchUrl || !/(?:leakporner\.com|djav\.org)/i.test(String(watchUrl))) return null;
        const source = /djav\.org/i.test(String(watchUrl)) ? 'djav' : 'leakporner';
        const resp = await fetch(`${DASHBOARD_URL}/api/v1/videos/update_stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_url: watchUrl,
                stream_url: watchUrl,
                source,
                title: '',
            }),
        });
        if (!resp.ok) return null;
        const data = await resp.json().catch(() => null);
        const candidate = String(data?.stream_url || '').trim();
        return /\.(m3u8|mp4|webm|m4v)(\?|$)/i.test(candidate) ? candidate : null;
    } catch (e) {
        console.warn('resolveLeakLikeDirectViaBackend failed', watchUrl, e);
        return null;
    }
}

async function resolveFullpornerDirectUrlsInTab(tabId, watchUrls, onProgress) {
    const urls = Array.from(new Set((watchUrls || []).filter(u => /fullporner\.com\/watch\//i.test(String(u || '')))));
    if (!tabId || urls.length === 0) return {};
    
    const out = {};
    for (let i = 0; i < urls.length; i++) {
        const watchUrl = urls[i];
        if (onProgress) onProgress(i + 1, urls.length);
        
        try {
            // Resolve one by one in tab context to get progress and share session
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: async (u) => {
                    const extractLocal = (html, baseUrl) => {
                        if (!html) return null;
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        const sourceNodes = Array.from(doc.querySelectorAll('video source[src], source[src], video[src]'));
                        if (sourceNodes.length) {
                            let best = null, bestQ = -1;
                            for (const node of sourceNodes) {
                                const raw = node.getAttribute('src') || '';
                                if (!raw) continue;
                                try {
                                    const abs = new URL(raw, baseUrl).href;
                                    const q = Math.max(
                                        parseInt((node.getAttribute('title') || '').replace(/[^\d]/g,''), 10) || 0,
                                        parseInt((abs.match(/\/(\d{3,4})(?:\/|$|\?)/)||['','0'])[1], 10) || 0
                                    );
                                    const ok = /\.(m3u8|mp4|mkv|webm|mov)(\?|$)/i.test(abs) ||
                                               /xiaoshenke\.net\/vid\/\d+\/\d+/i.test(abs);
                                    if (!ok) continue;
                                    if (q >= bestQ) { bestQ = q; best = abs; }
                                } catch {}
                            }
                            if (best) return best;
                        }
                        const m = html.match(/https?:\/\/[^"'\\\s<>]+?\.(m3u8|mp4|mkv|webm|mov)(?:\?[^"'\\\s<>]*)?/i);
                        return m ? m[0] : null;
                    };
                    
                    try {
                        const resp = await fetch(u, { credentials: 'include' });
                        if (resp.ok) {
                            const html = await resp.text();
                            let resolved = extractLocal(html, u);
                            if (!resolved) {
                                const doc = new DOMParser().parseFromString(html, 'text/html');
                                const iframe = doc.querySelector('.single-video iframe[src], iframe[src*="embed"], iframe[src]');
                                if (iframe?.getAttribute('src')) {
                                    const iframeUrl = new URL(iframe.getAttribute('src'), u).href;
                                    const ir = await fetch(iframeUrl, { credentials: 'include' });
                                    if (ir.ok) resolved = extractLocal(await ir.text(), iframeUrl);
                                }
                            }
                            return resolved || null;
                        }
                    } catch { return null; }
                    return null;
                },
                args: [watchUrl]
            });
            out[watchUrl] = results?.[0]?.result || null;
        } catch (e) {
            console.warn(`FullPorner resolve failed for ${watchUrl}`, e);
            out[watchUrl] = null;
        }
        
        // Small throttle to be nice to the browser UI thread
        if (i < urls.length - 1) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    return out;
}

function applyFilters() {
    const searchQuery = document.getElementById('search-input')?.value?.toLowerCase() || '';
    const sortValue = document.getElementById('sort-select')?.value || 'name';
    const minDur = parseFloat(document.getElementById('min-duration')?.value || '0') * 60;
    const maxDur = parseFloat(document.getElementById('max-duration')?.value || '0') * 60;
    const qualityFilter = document.getElementById('quality-filter')?.value || 'all';

    refreshHostFilterOptions();
    const hostingFilter = document.getElementById('hosting-filter')?.value || 'all';

    let filtered = allVideos.filter(v => {
        if (searchQuery && !v.title?.toLowerCase().includes(searchQuery)) return false;
        const dur = typeof v.duration === 'number' ? v.duration : parseDuration(v.duration);
        if (minDur > 0 && dur < minDur) return false;
        if (maxDur > 0 && dur > maxDur) return false;
        const host = getVideoHost(v);
        if (hostingFilter !== 'all' && host !== hostingFilter) return false;
        if (qualityFilter !== 'all') {
            const q = (v.quality || '').toLowerCase();
            if (qualityFilter === '4K' && !q.includes('4k') && !q.includes('2160')) return false;
            if (qualityFilter === '1080p' && !q.includes('1080') && !q.includes('fhd')) return false;
            if (qualityFilter === '720p' && !q.includes('720')) return false;
            if (qualityFilter === 'SD' && !q.includes('480') && !q.includes('360') && !q.includes('sd')) return false;
        }
        return true;
    });

    filtered = filtered.sort((a, b) => {
        switch (sortValue) {
            case 'size-desc': return (b.size || 0) - (a.size || 0);
            case 'size-asc':  return (a.size || 0) - (b.size || 0);
            case 'duration-desc': {
                const da = typeof a.duration === 'number' ? a.duration : parseDuration(a.duration);
                const db = typeof b.duration === 'number' ? b.duration : parseDuration(b.duration);
                return db - da;
            }
            case 'duration-asc': {
                const da = typeof a.duration === 'number' ? a.duration : parseDuration(a.duration);
                const db = typeof b.duration === 'number' ? b.duration : parseDuration(b.duration);
                return da - db;
            }
            case 'video-count-desc': return (b.videoCount || 0) - (a.videoCount || 0);
            case 'name': default: return (a.title || '').localeCompare(b.title || '');
        }
    });

    currentlyFilteredVideos = filtered;
    renderGrid(currentlyFilteredVideos);
    updateStats();
}

// Filter listeners
['search-input', 'sort-select', 'min-duration', 'max-duration', 'quality-filter', 'hosting-filter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', applyFilters);
    document.getElementById(id)?.addEventListener('change', applyFilters);
});

// handleXgroovyScraping stub (xGroovy uses same logic as xHamster)
async function handleXgroovyScraping(tab) {
    return handleXhamsterScraping(tab);
}

async function handleXhamsterScraping(tab) {
    console.log('xHamster/xGroovy scraping tab:', tab.id);
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';

    const isTurbo = document.getElementById('turbo-mode')?.checked || false;
    const isDeep  = document.getElementById('deep-scan')?.checked  || false;
    const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
    const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

    const statsEl = document.getElementById('stats-text');
    if (statsEl) statsEl.innerText = isDeep ? 'xHamster Deep Scan…' : (isTurbo ? 'xHamster Turbo (4 str.)…' : 'xHamster: načítavam…');

    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                function extractFromDoc(doc, baseUrl) {
                    const cards = doc.querySelectorAll(
                        '.video-thumb, .thumb-list__item, [class*="videoThumb"], [class*="thumb-item"]'
                    );
                    return Array.from(cards).map(card => {
                        const link = card.querySelector('a[href*="/videos/"]');
                        if (!link) return null;
                        let href = link.href || link.getAttribute('href') || '';
                        if (href.startsWith('/')) href = location.origin + href;
                        if (!href.startsWith('http')) return null;

                        const title = link.getAttribute('title') ||
                            card.querySelector('.video-thumb__title, [class*="title"]')?.innerText?.trim() ||
                            'xHamster Video';

                        const img = card.querySelector('img');
                        let thumbnail = img?.getAttribute('data-src') || img?.getAttribute('src') || '';
                        if (thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;

                        const durEl = card.querySelector('.thumb-image-container__duration, [class*="duration"]');
                        const duration = durEl?.innerText?.trim() || '';

                        const views = 0;
                        const quality = /4k|2160/i.test(title) ? '4K'
                            : /1080/i.test(title) ? '1080p'
                            : /720/i.test(title) ? '720p' : 'HD';

                        return { id: href, title, url: href, source_url: href, thumbnail, quality, duration, size: 0, views };
                    }).filter(Boolean);
                }

                let results = extractFromDoc(document, location.href);

                if (limit > 1 && results.length > 0) {
                    const baseUrl = location.href.split(/[?#]/)[0].replace(/\/\d+$/, '');
                    const fetches = [];
                    for (let p = 2; p <= limit; p++) {
                        fetches.push((async (pg) => {
                            try {
                                const url = `${baseUrl}/${pg}`;
                                const r = await fetch(url);
                                if (!r.ok) return [];
                                return extractFromDoc(new DOMParser().parseFromString(await r.text(), 'text/html'), url);
                            } catch { return []; }
                        })(p));
                    }
                    const extras = await Promise.all(fetches);
                    extras.forEach(arr => { results = results.concat(arr); });
                }

                const seen = new Set();
                return results.filter(v => { if (!v?.url || seen.has(v.url)) return false; seen.add(v.url); return true; });
            },
            args: [pageLimit]
        });

        allVideos = (result || []).filter(v => v?.url);
        currentlyFilteredVideos = [...allVideos];
        const folderEl = document.getElementById('folder-name');
        if (folderEl) folderEl.innerText = `xHamster${isDeep ? ' (Deep)' : isTurbo ? ' (Turbo)' : ''}`;
        applyFilters();
        updateStats();


        if (autoSend && allVideos.length > 0) {
            importVideos(allVideos, `xHamster ${new Date().toLocaleDateString()}`);
        }
    } catch (err) {
        console.error('handleXhamsterScraping', err);
        showError('xHamster: ' + err.message);
    }
}

async function handleXgroovyScraping(tab) {
    return handleXhamsterScraping(tab);
}

// ── WHORESHUB ─────────────────────────────────────────────────────────────────
async function handleWhoresHubScraping(tab) {
    console.log('WhoresHub scraping tab:', tab.id, tab.url);
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';

    const isTurbo  = document.getElementById('turbo-mode')?.checked || false;
    const isDeep   = document.getElementById('deep-scan')?.checked  || false;
    const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
    const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);
    const isPlaylistUrl = /\/playlists\/\d+\//i.test(tab.url);

    const statsEl = document.getElementById('stats-text');
    if (statsEl) statsEl.innerText = isPlaylistUrl
        ? 'WhoresHub: Načítavam playlist (všetky strany)…'
        : isDeep ? 'WhoresHub: Deep Scan (až 50 strán)…'
        : isTurbo ? 'WhoresHub: Turbo (4 strany)…'
        : 'WhoresHub: Načítavam stránku…';

    // Live progress listener for playlist multi-page loading
    let _wh_progressListener = null;
    if (isPlaylistUrl) {
        _wh_progressListener = (msg) => {
            if (msg.action === 'PLAYLIST_PROGRESS' && statsEl) {
                statsEl.innerText = `WhoresHub PL: strana ${msg.page} / ${msg.maxPage} (${msg.count} videí)…`;
            }
        };
        chrome.runtime.onMessage.addListener(_wh_progressListener);
    }

    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                // ── helpers ──────────────────────────────────────────────────
                function parseDurStr(t) {
                    if (!t) return 0;
                    const p = String(t).trim().split(':').map(Number);
                    if (p.some(isNaN)) return 0;
                    if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
                    if (p.length === 2) return p[0]*60 + p[1];
                    return 0;
                }
                function guessQuality(badge, title) {
                    const b = String(badge || '').trim().toUpperCase();
                    if (b === '4K' || b === 'UHD') return '4K';
                    if (b === 'FHD' || b === '1080P') return '1080p';
                    if (b === '720P') return '720p';
                    if (b === 'HD') return '1080p';
                    const t2 = String(title || '').toUpperCase();
                    if (/4K|2160P/.test(t2)) return '4K';
                    if (/1080P|FHD/.test(t2)) return '1080p';
                    if (/720P/.test(t2)) return '720p';
                    return 'HD';
                }
                function normThumb(src) {
                    if (!src || typeof src !== 'string') return '';
                    const s = src.trim();
                    if (s.startsWith('//')) return 'https:' + s;
                    return s;
                }
                function buildItem(a, th) {
                    const href = a.getAttribute('href') || a.getAttribute('data-playlist-item') || '';
                    if (!href.includes('/videos/')) return null;
                    const title = (a.getAttribute('title') || '').trim()
                        || th.querySelector('.description')?.textContent?.trim()
                        || '';
                    const img = th.querySelector('img.img');
                    let thumbnail = normThumb(
                        img?.getAttribute('data-src') ||
                        img?.getAttribute('src') || ''
                    );
                    if (thumbnail && thumbnail.includes('/320x180/')) {
                        thumbnail = thumbnail.replace(/\/\d+x\d+\/\d+\.jpg/, '/preview.jpg');
                    }
                    const duration = parseDurStr(th.querySelector('.duration')?.textContent?.trim());
                    const quality  = guessQuality(th.querySelector('.is-hd')?.textContent?.trim(), title);
                    let views = 0;
                    const viewEl = th.querySelector('ul.info li:first-child .text');
                    if (viewEl) {
                        const vt = (viewEl.textContent || '').replace(/\s/g,'').toUpperCase();
                        if (vt.includes('K')) views = parseFloat(vt)*1000;
                        else if (vt.includes('M')) views = parseFloat(vt)*1000000;
                        else views = parseInt(vt) || 0;
                    }
                    let rating = 0;
                    const ratingEl = th.querySelector('.voters .text');
                    if (ratingEl) rating = parseInt(ratingEl.textContent) || 0;
                    const videoIdM = href.match(/\/videos\/(\d+)\//);
                    const id = videoIdM ? videoIdM[1] : href;
                    const embedUrl = videoIdM ? `https://www.whoreshub.com/embed/${videoIdM[1]}` : href;
                    return { id, title, url: embedUrl, source_url: href, thumbnail, duration, quality, views, rating, size: 0 };
                }

                // ── SINGLE VIDEO PAGE  (/videos/ID/slug/) ────────────────────
                const isSingleVideo = /\/videos\/\d+\//i.test(location.pathname);
                if (isSingleVideo) {
                    let embedUrl = '', thumbUrl = '', duration = 0, title = '';
                    try {
                        const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent || 'null');
                        if (ld) {
                            embedUrl = ld.embedUrl || '';
                            thumbUrl = normThumb(ld.thumbnailUrl || '');
                            const dm = String(ld.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                            if (dm) duration = (parseInt(dm[1])||0)*3600 + (parseInt(dm[2])||0)*60 + (parseInt(dm[3])||0);
                            title = ld.name || '';
                        }
                    } catch {}
                    if (!title) title = document.querySelector('.video-title h1, h1.title')?.textContent?.trim()
                        || document.querySelector('meta[property="og:title"]')?.content || document.title;
                    if (!thumbUrl) thumbUrl = normThumb(document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '');
                    return [{ id: location.href, title: title.trim(), url: embedUrl || location.href,
                        source_url: location.href, thumbnail: thumbUrl, duration,
                        quality: guessQuality('', title), size: 0 }];
                }

                // ── PLAYLIST PAGE  (/playlists/ID/slug/) ─────────────────────
                const isPlaylist = /\/playlists\/\d+\//i.test(location.pathname);
                if (isPlaylist) {
                    // Extract items from current DOM
                    function extractPlaylistItems(doc) {
                        const container = doc.querySelector('#playlist_view_playlist_view_items, .playlist-holder.thumbs');
                        const scope = container || doc;
                        const items = [];
                        scope.querySelectorAll('div.thumb').forEach(th => {
                            const a = th.querySelector('a.item[href], a[data-playlist-item]');
                            if (!a) return;
                            const item = buildItem(a, th);
                            if (item) items.push(item);
                        });
                        return items;
                    }

                    let results = extractPlaylistItems(document);

                    // ── PLAYLIST: vždy načítaj VŠETKY stránky ────────────────
                    // Detect total page count from AJAX pagination links
                    let maxPage = 1;
                    // Try specific block selector first
                    document.querySelectorAll('[data-block-id="playlist_view_playlist_view"][data-parameters], [data-parameters*="from:"]').forEach(el => {
                        const params = el.getAttribute('data-parameters') || '';
                        const m = params.match(/from:(\d+)/);
                        if (m) { const n = parseInt(m[1]); if (n > maxPage) maxPage = n; }
                    });
                    // Also check regular pagination links for last page number
                    if (maxPage === 1) {
                        document.querySelectorAll('#playlist_view_playlist_view_pagination a, .pagination a').forEach(a => {
                            const txt = (a.textContent || '').trim();
                            const n = parseInt(txt);
                            if (!isNaN(n) && n > maxPage && n < 500) maxPage = n;
                        });
                    }
                    // If still 1, try blind sequential (stop on empty)
                    const blindMode = maxPage === 1;
                    if (blindMode) maxPage = 200;
                    console.log('[WH] Playlist maxPage:', maxPage, blindMode ? '(blind)' : '(detected)');


                    if (maxPage > 1 && results.length > 0) {
                        const sortMatch = (document.querySelector('[data-parameters]')?.getAttribute('data-parameters') || '').match(/sort_by:([^;]+)/);
                        const sortBy = sortMatch ? sortMatch[1] : 'added2fav_date';
                        // Base URL without hash, without trailing page number
                        const base = location.href.replace(/#.*$/, '').replace(/\/(\d+)\/?$/, '/').replace(/\/$/, '');

                        async function fetchPlaylistPage(pg) {
                            // Approach A: full page URL with query params (most reliable)
                            try {
                                const urlA = `${base}/?sort_by=${sortBy}&from=${pg}`;
                                const rA = await fetch(urlA);
                                if (rA.ok) {
                                    const html = await rA.text();
                                    const items = extractPlaylistItems(new DOMParser().parseFromString(html, 'text/html'));
                                    if (items.length > 0) { console.log('[WH] PL page', pg, 'via URL param:', items.length, 'items'); return items; }
                                }
                            } catch(e) { console.warn('[WH] Approach A failed:', e); }

                            // Approach B: POST to playlist URL (Porntrex AJAX pattern)
                            try {
                                const rB = await fetch(`${base}/`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
                                    body: `_block=playlist_view_playlist_view&sort_by=${sortBy}&from=${pg}`
                                });
                                if (rB.ok) {
                                    const html = await rB.text();
                                    const items = extractPlaylistItems(new DOMParser().parseFromString(html, 'text/html'));
                                    if (items.length > 0) { console.log('[WH] PL page', pg, 'via POST:', items.length, 'items'); return items; }
                                }
                            } catch(e) { console.warn('[WH] Approach B failed:', e); }

                            // Approach C: GET with _block param (alt AJAX endpoint)
                            try {
                                const urlC = `${base}/?_block=playlist_view_playlist_view&sort_by=${sortBy}&from=${pg}`;
                                const rC = await fetch(urlC, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
                                if (rC.ok) {
                                    const html = await rC.text();
                                    const items = extractPlaylistItems(new DOMParser().parseFromString(html, 'text/html'));
                                    if (items.length > 0) { console.log('[WH] PL page', pg, 'via AJAX GET:', items.length, 'items'); return items; }
                                }
                            } catch(e) { console.warn('[WH] Approach C failed:', e); }

                            console.warn('[WH] All approaches failed for page', pg);
                            return [];
                        }

                        for (let pg = 2; pg <= Math.min(maxPage, 200); pg++) {
                            const pageItems = await fetchPlaylistPage(pg);
                            if (pageItems.length === 0) break;
                            results = results.concat(pageItems);
                            try {
                                chrome.runtime.sendMessage({
                                    action: 'PLAYLIST_PROGRESS',
                                    page: pg, maxPage, count: results.length
                                });
                            } catch {}
                        }
                    }

                    const seen = new Set();
                    return results.filter(v => { if (!v?.url || seen.has(v.url)) return false; seen.add(v.url); return true; });
                }

                // ── LISTING / CATEGORY / TAG / SEARCH / MODEL PAGE ───────────
                function extractFromDoc(doc) {
                    const items = [];
                    doc.querySelectorAll('div.thumb').forEach(th => {
                        const a = th.querySelector('a.item[href]');
                        if (!a) return;
                        const item = buildItem(a, th);
                        if (item) items.push(item);
                    });
                    return items;
                }

                let results = extractFromDoc(document);

                // ── MULTI-PAGE (URL-based) ────────────────────────────────────
                if (limit > 1 && results.length > 0) {
                    const base = location.href.replace(/\/(\d+)?\/?$/, '').replace(/\/$/, '');
                    const pageLinks = document.querySelectorAll('.pagination a[href]');
                    let lastPage = limit;
                    pageLinks.forEach(a => {
                        const m = a.href.match(/\/(\d+)\/?$/);
                        if (m) { const n = parseInt(m[1]); if (n > 1 && n < 10000) lastPage = Math.min(limit, Math.max(lastPage, n)); }
                    });

                    const fetches = [];
                    for (let p = 2; p <= Math.min(limit, lastPage); p++) {
                        fetches.push(((pg) => {
                            const url = `${base}/${pg}/`;
                            return fetch(url).then(r => r.ok ? r.text().then(html =>
                                extractFromDoc(new DOMParser().parseFromString(html, 'text/html'))
                            ) : []).catch(() => []);
                        })(p));
                    }
                    const extras = await Promise.all(fetches);
                    extras.forEach(arr => { results = results.concat(arr); });
                }

                const seen = new Set();
                return results.filter(v => { if (!v?.url || seen.has(v.url)) return false; seen.add(v.url); return true; });
            },
            args: [pageLimit]
        });

        allVideos = (result || []).filter(v => v?.url);
        currentlyFilteredVideos = [...allVideos];

        // Smart folder name: use page title for playlists
        const [{ result: folderName }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const isPlaylist = /\/playlists\/\d+\//i.test(location.pathname);
                if (isPlaylist) return document.title.trim() || 'WhoresHub Playlist';
                return null;
            }
        });

        const folderEl = document.getElementById('folder-name');
        if (folderEl) {
            if (folderName) {
                folderEl.innerText = `${folderName}${isDeep ? ' (Deep)' : isTurbo ? ' (Turbo)' : ''}`;
            } else {
                folderEl.innerText = `WhoresHub${isDeep ? ' (Deep)' : isTurbo ? ' (Turbo)' : ''}`;
            }
        }

        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            const label = folderName || `WhoresHub ${new Date().toLocaleDateString()}`;
            importVideos(allVideos, label);
        }
    } catch (err) {
        console.error('handleWhoresHubScraping', err);
        showError('WhoresHub: ' + err.message);
    } finally {
        // Cleanup progress listener
        if (_wh_progressListener) {
            try { chrome.runtime.onMessage.removeListener(_wh_progressListener); } catch {}
        }
    }
}

// ── THOTS.TV ────────────────────────────────────────────────────────────────
async function handleThotsTvScraping(tab) {
    console.log('Thots.tv scraping tab:', tab.id, tab.url);
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';

    const isTurbo = document.getElementById('turbo-mode')?.checked || false;
    const isDeep = document.getElementById('deep-scan')?.checked || false;
    const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
    const pageLimit = isDeep ? 30 : (isTurbo ? 4 : 1);

    const statsEl = document.getElementById('stats-text');
    if (statsEl) statsEl.innerText = isDeep
        ? 'Thots.tv: Deep Scan (až 30 strán)…'
        : isTurbo
            ? 'Thots.tv: Turbo (4 strany)…'
            : 'Thots.tv: Načítavam stránku…';

    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const absolute = (value, base = location.href) => {
                    if (!value) return '';
                    try {
                        let out = String(value).trim();
                        if (!out) return '';
                        if (out.startsWith('//')) out = 'https:' + out;
                        return new URL(out, base).href.split('#')[0];
                    } catch {
                        return '';
                    }
                };
                const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
                const parseDuration = (text) => {
                    const m = String(text || '').match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
                    if (!m) return 0;
                    const h = m[3] ? parseInt(m[1], 10) : 0;
                    const mm = m[3] ? parseInt(m[2], 10) : parseInt(m[1], 10);
                    const s = m[3] ? parseInt(m[3], 10) : parseInt(m[2], 10);
                    return h * 3600 + mm * 60 + s;
                };
                const guessQuality = (text) => {
                    const m = String(text || '').match(/\b(4K|2160p|1440p|1080p|720p|480p|360p|HD)\b/i);
                    if (!m) return 'HD';
                    const q = m[1].toUpperCase();
                    return q === 'HD' ? 'HD' : q.replace('P', 'p');
                };
                const pickThumb = (scope, baseUrl) => {
                    const candidates = [];
                    scope?.querySelectorAll?.('img,picture source,video,[style*="background-image"]').forEach((el) => {
                        const srcset = el.getAttribute?.('srcset') || '';
                        const srcsetFirst = srcset ? String(srcset).split(',')[0].trim().split(/\s+/)[0] : '';
                        candidates.push(
                            el.currentSrc,
                            el.getAttribute?.('data-src'),
                            el.getAttribute?.('data-lazy-src'),
                            el.getAttribute?.('data-original'),
                            el.getAttribute?.('poster'),
                            srcsetFirst,
                            el.getAttribute?.('src')
                        );
                        const bg = el?.style?.backgroundImage || '';
                        const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
                        if (m) candidates.push(m[1]);
                    });
                    for (const raw of candidates) {
                        const url = absolute(raw, baseUrl);
                        if (!url || /^data:/i.test(url)) continue;
                        if (/avatar|logo|icon|sprite|emoji|svg|1x1|pixel/i.test(url)) continue;
                        return url;
                    }
                    return '';
                };
                const makeTitle = (anchor, card, fallbackUrl) => {
                    const fromAttr = (
                        anchor?.getAttribute?.('title') ||
                        card?.querySelector?.('h1,h2,h3,.title,[title]')?.getAttribute?.('title') ||
                        card?.querySelector?.('img[alt]')?.getAttribute?.('alt') ||
                        ''
                    ).trim();
                    if (fromAttr && fromAttr.length > 2) return fromAttr;

                    const lines = String(card?.innerText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
                    const best = lines.find((line) => {
                        if (line.length < 3 || line.length > 110) return false;
                        if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(line)) return false;
                        if (/^\d+(\.\d+)?\s*(K|M)?\s*views?$/i.test(line)) return false;
                        if (/^(watch|play|open|video|videos)$/i.test(line)) return false;
                        return true;
                    });
                    if (best) return best;

                    try {
                        const raw = decodeURIComponent(new URL(fallbackUrl).pathname.split('/').filter(Boolean).pop() || 'Thots.tv video');
                        const clean = raw.replace(/[-_]+/g, ' ').trim();
                        return clean || 'Thots.tv video';
                    } catch {
                        return 'Thots.tv video';
                    }
                };
                const looksLikeVideoPageUrl = (href) => {
                    if (!href) return false;
                    try {
                        const u = new URL(href, location.href);
                        if (!/thots\.tv$/i.test(u.hostname)) return false;
                        const p = u.pathname.toLowerCase();
                        if (p === '/' || p === '') return false;
                        if (/\/(category|categories|tags|tag|models|model|search|login|signup|register|account|profile|upload|terms|dmca|privacy)/i.test(p)) return false;
                        return /\/(video|videos|watch|v)\//i.test(p) || /-\d+\/?$/.test(p);
                    } catch {
                        return false;
                    }
                };
                const directFromDocument = (doc, baseUrl) => {
                    const video = doc.querySelector('video');
                    const src = absolute(
                        video?.currentSrc ||
                        video?.src ||
                        video?.querySelector?.('source[src]')?.getAttribute('src') ||
                        doc.querySelector('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')?.getAttribute('content') ||
                        '',
                        baseUrl
                    );
                    if (!src || /^blob:/i.test(src)) return '';
                    return src;
                };
                const directFromHtml = (html, baseUrl) => {
                    if (!html) return '';
                    const patterns = [
                        /<source[^>]+src=["']([^"']+\.(?:mp4|m3u8|webm|m4v)(?:\?[^"']*)?)["'][^>]*>/i,
                        /<video[^>]+src=["']([^"']+\.(?:mp4|m3u8|webm|m4v)(?:\?[^"']*)?)["'][^>]*>/i,
                        /<iframe[^>]+src=["']([^"']+)["'][^>]*>/i,
                        /https?:\/\/[^"'\\\s<>]+?\.(?:mp4|m3u8|webm|m4v)(?:\?[^"'\\\s<>]*)?/i,
                    ];
                    for (const pat of patterns) {
                        const m = String(html).match(pat);
                        if (!m) continue;
                        const raw = m[1] || m[0] || '';
                        try {
                            const abs = new URL(raw, baseUrl).href;
                            if (/^blob:/i.test(abs)) continue;
                            return abs;
                        } catch {
                            if (raw && !/^blob:/i.test(raw)) return raw;
                        }
                    }
                    return '';
                };
                const extractFromDoc = (doc, baseUrl) => {
                    const out = [];
                    const seen = new Set();
                    const anchors = Array.from(doc.querySelectorAll('a[href]'));
                    for (const a of anchors) {
                        const href = absolute(a.getAttribute('href') || '', baseUrl);
                        if (!looksLikeVideoPageUrl(href)) continue;
                        const card = a.closest('article,.thumb,.video,.item,li,div') || a;
                        const title = makeTitle(a, card, href);
                        const text = textOf(card);
                        const duration = parseDuration(text);
                        const quality = guessQuality(text);
                        const thumbnail = pickThumb(card, baseUrl);
                        const id = href;
                        if (!id || seen.has(id)) continue;
                        seen.add(id);
                        out.push({
                            id,
                            title,
                            url: href,
                            source_url: href,
                            thumbnail,
                            duration,
                            quality,
                            size: 0,
                        });
                    }
                    return out;
                };

                // Single video/detail page: prefer raw HTML direct stream before blob playback.
                let rawPageHtml = '';
                try {
                    const resp = await fetch(location.href, { credentials: 'include' });
                    if (resp.ok) rawPageHtml = await resp.text();
                } catch {}

                const directNow = directFromDocument(document, location.href) || directFromHtml(rawPageHtml, location.href);
                if (directNow) {
                    const pageTitle =
                        document.querySelector('h1,.video-title,h2')?.textContent?.trim() ||
                        document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                        document.title ||
                        'Thots.tv video';
                    const thumbNow = pickThumb(document, location.href);
                    const durationNow = parseDuration(textOf(document.body));
                    return [{
                        id: location.href,
                        title: pageTitle,
                        url: directNow,
                        source_url: location.href,
                        thumbnail: thumbNow,
                        duration: durationNow,
                        quality: guessQuality([pageTitle, textOf(document.body).slice(0, 300)].join(' ')),
                        size: 0,
                    }];
                }

                let results = extractFromDoc(document, location.href);
                if (limit > 1 && results.length > 0) {
                    const pageUrls = new Set();
                    const current = new URL(location.href);
                    const basePath = current.pathname.replace(/\/+$/, '');
                    for (let p = 2; p <= limit; p++) {
                        pageUrls.add(`${current.origin}${basePath}?page=${p}`);
                        pageUrls.add(`${current.origin}${basePath}/page/${p}`);
                    }
                    const extras = await Promise.all(Array.from(pageUrls).map(async (url) => {
                        try {
                            const r = await fetch(url, { credentials: 'include' });
                            if (!r.ok) return [];
                            const html = await r.text();
                            const d = new DOMParser().parseFromString(html, 'text/html');
                            return extractFromDoc(d, url);
                        } catch {
                            return [];
                        }
                    }));
                    extras.forEach((arr) => { results = results.concat(arr); });
                }

                const dedupe = new Set();
                return results.filter((v) => {
                    const k = v?.url || v?.source_url;
                    if (!k || dedupe.has(k)) return false;
                    dedupe.add(k);
                    return true;
                });
            },
            args: [pageLimit],
        });

        allVideos = (result || []).filter(v => v?.url);
        currentlyFilteredVideos = [...allVideos];

        const folderEl = document.getElementById('folder-name');
        if (folderEl) folderEl.innerText = `Thots.tv${isDeep ? ' (Deep)' : isTurbo ? ' (Turbo)' : ''}`;

        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            importVideos(allVideos, `Thots.tv ${new Date().toLocaleDateString()}`);
        }
    } catch (err) {
        console.error('handleThotsTvScraping', err);
        showError('Thots.tv: ' + err.message);
    }
}

