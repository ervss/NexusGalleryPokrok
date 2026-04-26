
let allVideos = [];
let currentlyFilteredVideos = [];
let selectedVideos = new Set();
const PORTS = [8000, 8001, 8002, 8003, 8004, 8005];
let DASHBOARD_URL = "http://localhost:8000"; // Default
let SELECTED_PORT = 8000;
/** Origin of the Bunkr tab (e.g. https://bunkr.pk) — Referer for CDN thumbs */
let bunkrThumbPageOrigin = null;

function escapeHtml(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Collapse grabber rows that resolve to the same CDN object (same host+path, different query
 * tokens / duplicate album rows). Non-HTTP keys fall back to raw string.
 */
function bunkrStreamIdentityKey(u) {
    if (!u) return '';
    const raw = String(u).trim();
    if (!/^https?:\/\//i.test(raw)) {
        try {
            const x = new URL(raw);
            return `page:${x.origin.toLowerCase()}${x.pathname.toLowerCase()}`;
        } catch {
            return `raw:${raw}`;
        }
    }
    try {
        const x = new URL(raw);
        const host = x.hostname.toLowerCase();
        const path = x.pathname.toLowerCase();
        const isMedia =
            /\.(mp4|m4v|mov|mkv|webm|m3u8)(\?|$)/i.test(path) ||
            /\.scdn\.st$/i.test(host) ||
            /cdn|media-files|get\.bunkr/i.test(host);
        if (isMedia) return `media:${host}${path}`;
        return `url:${x.origin.toLowerCase()}${path}`;
    } catch {
        return `url:${raw}`;
    }
}

function bunkrDedupeResolvedStreams(videos) {
    const seen = new Set();
    const out = [];
    for (const v of videos) {
        const k = bunkrStreamIdentityKey(v.url);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(v);
    }
    return out;
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

function isArchivebateUrl(url) {
    if (!url) return false;
    try {
        return new URL(url).hostname.toLowerCase().includes('archivebate.com');
    } catch {
        return url.toLowerCase().includes('archivebate.com');
    }
}

function isArchivebateVideoUrl(url) {
    if (!isArchivebateUrl(url)) return false;
    const p = String(url).split(/[?#]/)[0].toLowerCase();
    return /\/(watch|embed)\//.test(p);
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

function isRecurbateVideoUrl(url) {
    if (!isRecurbateUrl(url)) return false;
    const p = String(url).split(/[?#]/)[0].toLowerCase();
    return /\/(watch|video|embed|v|recording|recordings)\//.test(p);
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
        // f.url from window.albumFiles is typically a CDN URL (scdn.st/...) — NOT a /f/ page.
        // We keep it as cdnUrl for direct streaming; pageUrl must be the /f/slug page.
        const fUrlRaw = f.url || '';
        let cdnUrl = null;
        let pageUrl = null;
        if (fUrlRaw) {
            if (/\/(f|v)\/[^/]/.test(fUrlRaw)) {
                pageUrl = fUrlRaw; // f.url is already a /f/ page URL
            } else {
                cdnUrl = fUrlRaw; // f.url is a CDN URL — store separately
            }
        }
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
            cdnUrl: cdnUrl,
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

/** Filester.me Folder Probe */
function filesterProbe() {
    const origin = location.origin;
    const folderUrl = location.href.split(/[?#]/)[0];
    const folderTitle = document.querySelector('h1, .folder-name')?.innerText?.trim() || document.title || 'Filester Folder';

    function parseSize(s) {
        if (!s) return 0;
        const m = s.match(/([\d.]+)\s*(TB|GB|MB|KB|B)\b/i);
        if (m) {
            const n = parseFloat(m[1]);
            const u = (m[2] || 'B').toUpperCase();
            const mult = { B: 1, KB: 1024, MB: 1024 * 1024, GB: Math.pow(1024, 3), TB: Math.pow(1024, 4) };
            return Math.round(n * (mult[u] || 1));
        }
        return 0;
    }

    const rows = [];
    document.querySelectorAll('.file-item').forEach(item => {
        const title = item.getAttribute('data-name') || item.querySelector('.file-name')?.innerText?.trim() || 'video';
        const sizeStr = item.getAttribute('data-size') || item.querySelector('.file-meta')?.innerText?.trim() || '0';
        const size = isFinite(sizeStr) ? parseInt(sizeStr) : parseSize(sizeStr);
        const thumb = item.querySelector('.file-preview img')?.src || '';
        
        // Extract ID from onclick or similar
        let id = '';
        const oc = item.getAttribute('onclick') || '';
        const m = oc.match(/\/d\/([^'"]+)/);
        if (m) id = m[1];
        
        if (!id) {
            // Try to find it in any link inside
            const link = item.querySelector('a[href*="/d/"]');
            if (link) {
                const lm = link.href.match(/\/d\/([^/?#]+)/);
                if (lm) id = lm[1];
            }
        }

        if (id) {
            rows.push({
                id: id,
                title: title,
                pageUrl: origin + '/d/' + id,
                size: size,
                timestamp: item.getAttribute('data-date') || '',
                source_url: folderUrl,
                thumbnail: thumb,
                quality: (title.match(/(4K|2160p|1440p|1080p|720p)/i) || ['HD'])[0]
            });
        }
    });

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
                        if (!stream && r.cdnUrl) stream = r.cdnUrl; // use pre-known CDN URL
                        if (!stream) stream = await bunkrFetchPageExtract(r.pageUrl);
                        return bunkrCard(r, {
                            url: stream || r.pageUrl,
                            direct_ok: !!stream,
                        });
                    }),
                );
                out.push(...resolved);
            }
            allVideos = bunkrDedupeResolvedStreams(out);
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
    console.log('Filester scraping tab:', tab.id);
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('video-grid').style.display = 'none';
    document.getElementById('stats-text').innerText = 'Filester: načítavam zoznam súborov…';

    try {
        const probe = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: filesterProbe,
        });
        const data = probe && probe[0] && probe[0].result;
        if (!data || !data.rows || data.rows.length === 0) {
            showError('Na stránke Filester sa nenašli súbory. Skús obnoviť stránku.');
            return;
        }

        allVideos = data.rows.map(r => ({
            id: r.pageUrl,
            title: r.title,
            url: r.pageUrl,
            source_url: r.source_url,
            thumbnail: r.thumbnail,
            quality: r.quality,
            size: r.size,
            duration: '', // Filester usually doesn't show duration in folder view
        }));

        document.getElementById('folder-name').innerText = data.folderTitle || 'Filester Folder';
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
        console.log(`Dashboard verified at selected port: ${SELECTED_PORT}`);
        return;
    }

    // Fallback to hunting other ports
    console.log("Selected port not responding, hunting for others...");
    for (const port of PORTS) {
        if (port === SELECTED_PORT) continue;
        if (await checkPort(port)) {
            console.log(`Dashboard found at fallback port: ${port}`);
            DASHBOARD_URL = `http://localhost:${port}`;
            return;
        }
    }
    console.warn("Dashboard not found on any standard port.");
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
    // Initialize Port from storage
    const storage = await chrome.storage.local.get(['selected_port']);
    if (storage.selected_port) {
        SELECTED_PORT = parseInt(storage.selected_port);
        DASHBOARD_URL = `http://localhost:${SELECTED_PORT}`;
        const radio = document.querySelector(`input[name="dashboard-port"][value="${SELECTED_PORT}"]`);
        if (radio) radio.checked = true;
        console.log(`Port initialized from storage: ${SELECTED_PORT}`);
    }

    // Port change listener
    document.querySelectorAll('input[name="dashboard-port"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            SELECTED_PORT = parseInt(e.target.value);
            DASHBOARD_URL = `http://localhost:${SELECTED_PORT}`;
            chrome.storage.local.set({ selected_port: SELECTED_PORT });
            console.log(`Port manually changed to: ${SELECTED_PORT}`);
        });
    });

    const startScraper = async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            showError("Could not get active tab. Please try again.");
            return;
        }
        console.log("Active tab URL:", tab.url);

        const bunkrBar = document.getElementById('bunkr-controls');
        if (bunkrBar) bunkrBar.style.display = 'none';
        bunkrThumbPageOrigin = null;

        try {
            if (tab.url.includes('pornhub.com')) {
                console.log("Pornhub page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'flex';
                await handlePornhubScraping(tab);
            } else if (tab.url.includes('eporner.com')) {
                console.log("Eporner page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleEpornerScraping(tab);
            } else if (tab.url.includes('gofile.io/d/')) {
                console.log("GoFile page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'none';
                await handleGofileScraping(tab);
            } else if (isBunkrExplorerUrl(tab.url)) {
                console.log("Bunkr page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'none';
                if (bunkrBar) bunkrBar.style.display = 'flex';
                await handleBunkrScraping(tab);
            } else if (tab.url.includes('erome.com')) {
                console.log("Erome page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleEromeScraping(tab);
            } else if (tab.url.includes('xvideos.com') || tab.url.includes('xvideos.red')) {
                console.log("XVideos page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleXvideosScraping(tab);
            } else if (tab.url.includes('filester.me')) {
                console.log("Filester page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'none';
                await handleFilesterScraping(tab);
            } else if (tab.url.includes('pixeldrain.com/u/') || tab.url.includes('pixeldrain.com/l/')) {
                console.log("Pixeldrain page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'none';
                await handlePixeldrainScraping(tab);
            } else if (tab.url.includes('leakporner.com')) {
                console.log("LeakPorner page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleLeakPornerScraping(tab);
            } else if (isArchivebateUrl(tab.url)) {
                console.log("Archivebate page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleArchivebateScraping(tab);
            } else if (isRecurbateUrl(tab.url)) {
                console.log("Recurbate page detected. Starting scraper.");
                document.getElementById('turbo-controls').style.display = 'flex';
                await handleRecurbateScraping(tab);
            } else {

                const container = document.querySelector('.container');
                container.innerHTML = '<div style="padding: 40px; text-align: center;"><h3>Quantum Explorer</h3><p>Otvor podporovanú stránku (GoFile, Filester, Bunkr album/súbor, XVideos, Eporner, Pornhub, Erome, Pixeldrain, LeakPorner, Archivebate, Recurbate)</p></div>';
                console.log("No supported page detected.");
            }
        } catch (error) {
            console.error("An unexpected error occurred during initialization:", error);
            showError(`A critical error occurred: ${error.message}`);
        }
    };

    // Initial Start
    await startScraper();

    // Checkbox Listeners for instant reactivity
    document.getElementById('turbo-mode').addEventListener('change', (e) => {
        if (e.target.checked) document.getElementById('deep-scan').checked = false;
        startScraper();
    });

    document.getElementById('deep-scan').addEventListener('change', (e) => {
        if (e.target.checked) document.getElementById('turbo-mode').checked = false;
        startScraper();
    });

    const bunkrDirect = document.getElementById('bunkr-fetch-direct');
    if (bunkrDirect) {
        bunkrDirect.addEventListener('change', () => startScraper());
    }
});

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


async function handleArchivebateScraping(tab) {
    console.log("Starting Archivebate scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        const statsEl = document.getElementById('stats-text');
        if (statsEl) {
            statsEl.innerText = isDeep ? "Archivebate Deep Scan: scraping up to 50 pages..." : (isTurbo ? "Archivebate Turbo: scraping 4 pages..." : "Scraping current Archivebate page...");
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const normalizeUrl = (value, baseUrl) => {
                    if (!value) return '';
                    try {
                        let u = String(value).trim();
                        if (u.startsWith('//')) u = 'https:' + u;
                        return new URL(u, baseUrl).href.split('#')[0];
                    } catch {
                        return '';
                    }
                };

                const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

                const guessQuality = (text) => {
                    const m = String(text || '').match(/\b(4K|2160p|1440p|1080p|720p|480p|360p)\b/i);
                    return m ? m[1].toUpperCase().replace('P', 'p') : 'HD';
                };

                const extractDuration = (text) => {
                    const m = String(text || '').match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
                    return m ? m[0] : '';
                };

                const watchMode = /\/(watch|video|embed|v|recording|recordings)\//i.test(window.location.pathname);

                const extractDirectStream = (doc, baseUrl) => {
                    const toAbs = (u) => normalizeUrl(u, baseUrl);
                    const candidates = [];
                    const push = (u) => {
                        const x = toAbs(u);
                        if (x) candidates.push(x);
                    };

                    const vid = doc.querySelector('video');
                    if (vid) {
                        push(vid.currentSrc || vid.src || vid.getAttribute('src'));
                    }
                    doc.querySelectorAll('video source[src], source[src]').forEach((s) => push(s.getAttribute('src')));

                    const html = doc.documentElement?.outerHTML || '';
                    const re = /https?:\/\/[^"'\s<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>]*)?/gi;
                    (html.match(re) || []).forEach(push);

                    const valid = candidates.filter((u) => /\.(m3u8|mp4)(\?|$)/i.test(u));
                    const hls = valid.find((u) => /\.m3u8(\?|$)/i.test(u));
                    return hls || valid[0] || '';
                };

                const cleanTitle = (raw, fallbackUrl) => {
                    const blocked = /^(play|watch|open|new|live|recordings?|share|clips?|videos?)$/i;
                    const base = String(raw || '').replace(/\s+/g, ' ').trim();
                    if (base && !blocked.test(base)) return base.replace(/\s*[-|]\s*(Rec-ur-bate|Recurbate).*$/i, '').trim();
                    try {
                        const p = new URL(fallbackUrl).pathname.split('/').filter(Boolean);
                        const last = decodeURIComponent(p[p.length - 2] || p[p.length - 1] || '').replace(/[-_]+/g, ' ').trim();
                        if (last && !blocked.test(last)) return last;
                    } catch {}
                    return 'Recurbate Video';
                };

                const extractFromDoc = (doc, baseUrl) => {
                    const currentUrl = normalizeUrl(baseUrl, location.href);
                    const videos = [];
                    const seen = new Set();

                    if (watchMode) {
                        const pageUrl = currentUrl;
                        const directStream = extractDirectStream(doc, baseUrl);
                        const rawText = textOf(doc.body);
                        const rawTitle =
                            doc.querySelector('h1, h2, .title, .video-title')?.textContent ||
                            doc.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.content ||
                            doc.title ||
                            '';
                        videos.push({
                            id: pageUrl,
                            title: cleanTitle(rawTitle, pageUrl),
                            url: directStream || pageUrl,
                            source_url: pageUrl,
                            thumbnail: pickThumb(doc.body, doc, baseUrl),
                            duration: extractDuration(rawText),
                            quality: guessQuality(String(rawTitle) + ' ' + rawText),
                            size: parseSize(rawText),
                            tags: 'recurbate',
                        });
                        return videos;
                    }

                    const pushVideo = (rawUrl, context) => {
                        const videoUrl = normalizeUrl(rawUrl, baseUrl);
                        if (!videoUrl || !/archivebate\.com\/(watch|embed)\//i.test(videoUrl) || seen.has(videoUrl)) return;
                        seen.add(videoUrl);

                        const title =
                            context?.querySelector?.('[title]')?.getAttribute('title') ||
                            textOf(context?.querySelector?.('.title, .video-title, h2, h3, a')) ||
                            doc.querySelector('meta[property="og:title"]')?.content ||
                            doc.title ||
                            'Archivebate Video';

                        const img = context?.querySelector?.('img') || doc.querySelector('meta[property="og:image"]');
                        let thumbnail = img?.getAttribute?.('data-src') || img?.getAttribute?.('data-original') || img?.getAttribute?.('src') || img?.content || '';
                        thumbnail = normalizeUrl(thumbnail, baseUrl);

                        const rawText = textOf(context) || textOf(doc.body);
                        videos.push({
                            id: videoUrl,
                            title: title.replace(/\s*[-|]\s*Archivebate.*$/i, '').trim() || 'Archivebate Video',
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail,
                            duration: extractDuration(rawText),
                            quality: guessQuality(title + ' ' + rawText),
                            size: 0,
                            tags: 'archivebate'
                        });
                    };

                    doc.querySelectorAll('a[href*="/watch/"], a[href*="/embed/"]').forEach((a) => {
                        let card = a;
                        for (let i = 0; i < 8 && card?.parentElement; i++) {
                            card = card.parentElement;
                            if (card.querySelectorAll?.('a[href*="/watch/"], a[href*="/embed/"]').length <= 4 && card.querySelector?.('img')) {
                                break;
                            }
                        }
                        pushVideo(a.getAttribute('href') || a.href, card || a);
                    });

                    if (videos.length === 0 && /archivebate\.com\/(watch|embed)\//i.test(currentUrl)) {
                        pushVideo(currentUrl, doc.body);
                    }

                    return videos;
                };

                let allResults = extractFromDoc(document, window.location.href);

                if (limit > 1 && !/\/(watch|embed)\//i.test(window.location.pathname)) {
                    const fetchPage = async (pageNum) => {
                        try {
                            const pageUrl = new URL(window.location.href);
                            pageUrl.searchParams.set('page', pageNum);
                            const response = await fetch(pageUrl.href, { credentials: 'include' });
                            const text = await response.text();
                            const doc = new DOMParser().parseFromString(text, 'text/html');
                            return extractFromDoc(doc, pageUrl.href);
                        } catch (e) {
                            console.warn('Archivebate page scrape failed', pageNum, e);
                            return [];
                        }
                    };

                    const pages = [];
                    for (let pageNum = 2; pageNum <= limit; pageNum++) {
                        pages.push(fetchPage(pageNum));
                    }
                    const extra = await Promise.all(pages);
                    extra.forEach((items) => {
                        allResults = allResults.concat(items);
                    });
                }

                const unique = [];
                const seen = new Set();
                allResults.forEach((v) => {
                    if (v?.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return unique;
            },
            args: [pageLimit]
        });

        allVideos = (results[0].result || []).filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];

        const folderNameEl = document.getElementById('folder-name');
        if (folderNameEl) {
            folderNameEl.innerText = "Archivebate Explorer";
        }

        applyFilters();
        updateStats();

        if (autoSend && allVideos.length > 0) {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail,
                filesize: 0,
                quality: v.quality,
                duration: parseDuration(v.duration),
                tags: v.tags || 'archivebate'
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `Archivebate ${isDeep ? 'Deep' : (isTurbo ? 'Turbo' : 'Current')} ${new Date().toLocaleDateString()}`,
                    videos: toImport
                })
            }).catch(err => console.error("Archivebate auto-send failed", err));
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
        const pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        const statsEl = document.getElementById('stats-text');
        if (statsEl) {
            statsEl.innerText = isDeep ? "Recurbate Deep Scan: scraping up to 50 pages..." : (isTurbo ? "Recurbate Turbo: scraping 4 pages..." : "Scraping current Recurbate page...");
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const normalizeUrl = (value, baseUrl) => {
                    if (!value) return '';
                    try {
                        let u = String(value).trim();
                        if (u.startsWith('//')) u = 'https:' + u;
                        return new URL(u, baseUrl).href.split('#')[0];
                    } catch {
                        return '';
                    }
                };

                const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
                const isRecHost = (url) => /rec-ur-bate\.com|recurbate\.com/i.test(url || '');
                const isVideoUrl = (url) => {
                    try {
                        const u = new URL(url, location.href);
                        if (!isRecHost(u.href)) return false;
                        const path = u.pathname.toLowerCase().replace(/\/+$/, '');
                        if (!path || path === '/') return false;
                        if (/^\/(recordings|performers|live|login|signup|register|categories|tags|genre|genres|account|privacy|dmca|2257)$/i.test(path)) return false;
                        if (/\/(watch|video|embed|v|recording|recordings)\//i.test(path)) return true;
                        return false;
                    } catch {
                        return false;
                    }
                };

                const isLikelyVideoCard = (el) => {
                    const text = textOf(el);
                    return !!(
                        el &&
                        el.querySelector?.('img, picture, [style*="background-image"]') &&
                        (
                            /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(text) ||
                            /\bHD\b|\b4K\b|\b1080p\b|\b720p\b/i.test(text) ||
                            /\b\d+\s*%/.test(text) ||
                            /\bviews?\b|\bmins?\b|\bhours?\b/i.test(text)
                        )
                    );
                };

                const guessQuality = (text) => {
                    const m = String(text || '').match(/\b(4K|2160p|1440p|1080p|720p|480p|360p)\b/i);
                    return m ? m[1].toUpperCase().replace('P', 'p') : 'HD';
                };

                const extractDuration = (text) => {
                    const m = String(text || '').match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
                    return m ? m[0] : '';
                };

                const parseSize = (text) => {
                    const m = String(text || '').replace(',', '.').match(/\b([\d.]+)\s*(TB|GB|MB|KB)\b/i);
                    if (!m) return 0;
                    const n = parseFloat(m[1]);
                    const mult = { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
                    return Math.round(n * (mult[m[2].toUpperCase()] || 1));
                };

                const pickThumb = (context, doc, baseUrl) => {
                    const img = context?.querySelector?.('img') || doc.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
                    let raw = img?.getAttribute?.('data-src') || img?.getAttribute?.('data-original') || img?.getAttribute?.('data-lazy-src') || img?.getAttribute?.('srcset') || img?.getAttribute?.('src') || img?.content || '';
                    if (raw && raw.includes(',')) raw = raw.split(',')[0].trim().split(/\s+/)[0];
                    if (!raw) {
                        const styled = context?.querySelector?.('[style*="background-image"]');
                        const m = styled?.style?.backgroundImage?.match(/url\(["']?([^"')]+)/i);
                        if (m) raw = m[1];
                    }
                    return normalizeUrl(raw, baseUrl);
                };

                const extractFromDoc = (doc, baseUrl) => {
                    const currentUrl = normalizeUrl(baseUrl, location.href);
                    const videos = [];
                    const seen = new Set();

                    const pushVideo = (rawUrl, context) => {
                        const videoUrl = normalizeUrl(rawUrl, baseUrl);
                        if (!videoUrl || !isRecHost(videoUrl) || seen.has(videoUrl)) return;
                        if (!isVideoUrl(videoUrl) && !isLikelyVideoCard(context)) return;
                        seen.add(videoUrl);

                        const rawText = textOf(context) || textOf(doc.body);
                        const title =
                            context?.querySelector?.('[title]')?.getAttribute('title') ||
                            textOf(context?.querySelector?.('.title, .video-title, h1, h2, h3, a')) ||
                            doc.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.content ||
                            doc.title ||
                            'Recurbate Video';

                        videos.push({
                            id: videoUrl,
                            title: cleanTitle(title, videoUrl),
                            url: videoUrl,
                            source_url: videoUrl,
                            thumbnail: pickThumb(context, doc, baseUrl),
                            duration: extractDuration(rawText),
                            quality: guessQuality(title + ' ' + rawText),
                            size: parseSize(rawText),
                            tags: 'recurbate'
                        });
                    };

                    doc.querySelectorAll('a[href]').forEach((a) => {
                        const href = a.getAttribute('href') || a.href;
                        const absolute = normalizeUrl(href, baseUrl);
                        let card = a;
                        for (let i = 0; i < 10 && card?.parentElement; i++) {
                            card = card.parentElement;
                            if (isLikelyVideoCard(card) && card.querySelectorAll?.('a[href]').length <= 12) {
                                break;
                            }
                        }
                        pushVideo(absolute, card || a);
                    });

                    // Some cards wrap thumbnails in JS handlers instead of clean /watch/ URLs.
                    doc.querySelectorAll('img').forEach((img) => {
                        let card = img;
                        for (let i = 0; i < 10 && card?.parentElement; i++) {
                            card = card.parentElement;
                            if (isLikelyVideoCard(card)) break;
                        }
                        if (!isLikelyVideoCard(card)) return;
                        const link = card.querySelector?.('a[href]');
                        if (link) pushVideo(link.getAttribute('href') || link.href, card);
                    });

                    if (videos.length === 0 && isVideoUrl(currentUrl)) {
                        pushVideo(currentUrl, doc.body);
                    }
                    return videos;
                };

                let allResults = extractFromDoc(document, window.location.href);

                if (limit > 1 && !/\/(watch|video|embed|v|recording|recordings)\//i.test(window.location.pathname)) {
                    const fetchPage = async (pageNum) => {
                        try {
                            const pageUrl = new URL(window.location.href);
                            pageUrl.searchParams.set('page', pageNum);
                            const response = await fetch(pageUrl.href, { credentials: 'include' });
                            const text = await response.text();
                            const doc = new DOMParser().parseFromString(text, 'text/html');
                            return extractFromDoc(doc, pageUrl.href);
                        } catch (e) {
                            console.warn('Recurbate page scrape failed', pageNum, e);
                            return [];
                        }
                    };
                    const extra = await Promise.all(Array.from({ length: limit - 1 }, (_, i) => fetchPage(i + 2)));
                    extra.forEach((items) => {
                        allResults = allResults.concat(items);
                    });
                }

                const unique = [];
                const seen = new Set();
                allResults.forEach((v) => {
                    if (v?.url && !seen.has(v.url)) {
                        seen.add(v.url);
                        unique.push(v);
                    }
                });
                return {
                    mode: watchMode ? 'watch' : 'listing',
                    items: unique,
                };
            },
            args: [pageLimit]
        });

        const data = results[0]?.result || { mode: 'listing', items: [] };
        allVideos = (data.items || []).filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];

        const folderNameEl = document.getElementById('folder-name');
        if (folderNameEl) {
            folderNameEl.innerText = data.mode === 'watch' ? "Recurbate (video)" : "Recurbate Explorer";
        }

        applyFilters();
        updateStats();

        if (data.mode === 'watch' && allVideos.length > 0) {
            const first = allVideos[0];
            const hasDirectStream = /\.(m3u8|mp4)(\?|$)/i.test(first.url || '');
            if (hasDirectStream && first.source_url) {
                fetch(`${DASHBOARD_URL}/api/v1/videos/update_stream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_url: first.source_url,
                        stream_url: first.url,
                        source: 'recurbate',
                    }),
                }).catch((err) => console.warn('Recurbate stream sync failed', err));
            }
        }

        if (autoSend && allVideos.length > 0 && data.mode !== 'watch') {
            const toImport = allVideos.map(v => ({
                title: v.title,
                url: v.url,
                source_url: v.source_url,
                thumbnail: v.thumbnail,
                filesize: v.size || 0,
                quality: v.quality,
                duration: parseDuration(v.duration),
                tags: v.tags || 'recurbate'
            }));
            fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: `Recurbate ${isDeep ? 'Deep' : (isTurbo ? 'Turbo' : 'Current')} ${new Date().toLocaleDateString()}`,
                    videos: toImport
                })
            }).catch(err => console.error("Recurbate auto-send failed", err));
        } else if (data.mode === 'watch' && statsEl) {
            statsEl.innerText = "Recurbate video načítané. Import je manuálny (bez auto-importu).";
        }
    } catch (err) {
        console.error("Error during Recurbate scraping:", err);
        showError(`Failed to scrape Recurbate: ${err.message}`);
    }
}


async function handlePixeldrainScraping(tab) {
    console.log("Starting Pixeldrain scraping for tab:", tab.id);
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8'];

    const extractQuality = (name) => {
        const m = name.match(/(4K|2160p|1440p|1080p|720p|480p|360p)/i);
        return m ? m[0].toUpperCase().replace('P', 'p') : 'HD';
    };

    try {
        const listMatch = tab.url.match(/pixeldrain\.com\/l\/([^/?#]+)/);
        if (listMatch) {
            const listId = listMatch[1];
            const resp = await fetch(`https://pixeldrain.com/api/list/${listId}`, { signal: AbortSignal.timeout(10000) });
            if (!resp.ok) throw new Error(`Pixeldrain API error: ${resp.status}`);
            const data = await resp.json();
            if (!data.success) throw new Error(data.message || 'API returned failure');

            allVideos = (data.files || [])
                .filter(f => videoExtensions.some(ext => f.name.toLowerCase().endsWith(ext)))
                .map(f => ({
                    id: f.id,
                    title: f.name,
                    quality: extractQuality(f.name),
                    url: `https://pixeldrain.com/api/file/${f.id}`,
                    thumbnail: `https://pixeldrain.com/api/file/${f.id}/thumbnail`,
                    size: f.size || 0,
                    source_url: tab.url,
                    views: 0,
                    rating: 0,
                    duration: '',
                }));

            document.getElementById('folder-name').innerText = data.title || 'Pixeldrain Album';
        } else {
            const fileMatch = tab.url.match(/pixeldrain\.com\/u\/([^/?#]+)/);
            if (!fileMatch) { showError("Could not extract Pixeldrain ID from URL."); return; }
            const fileId = fileMatch[1];

            const resp = await fetch(`https://pixeldrain.com/api/file/${fileId}/info`, { signal: AbortSignal.timeout(10000) });
            if (!resp.ok) throw new Error(`Pixeldrain API error: ${resp.status}`);
            const f = await resp.json();
            if (!f.success) throw new Error(f.message || 'API returned failure');

            allVideos = videoExtensions.some(ext => f.name.toLowerCase().endsWith(ext))
                ? [{
                    id: f.id,
                    title: f.name,
                    quality: extractQuality(f.name),
                    url: `https://pixeldrain.com/api/file/${f.id}`,
                    thumbnail: `https://pixeldrain.com/api/file/${f.id}/thumbnail`,
                    size: f.size || 0,
                    source_url: tab.url,
                    views: 0,
                    rating: 0,
                    duration: '',
                }]
                : [];

            document.getElementById('folder-name').innerText = f.name || 'Pixeldrain File';
        }

        console.log(`Found ${allVideos.length} videos on Pixeldrain.`);
        applyFilters();
        updateStats();
    } catch (err) {
        console.error("Error during Pixeldrain scraping:", err);
        showError(`Pixeldrain: ${err.message}`);
    }
}

async function handleGofileScraping(tab) {
    console.log("Starting GoFile scraping for tab:", tab.id);
    const folderIdMatch = tab.url.match(/gofile\.io\/d\/([^/?#]+)/);

    if (!folderIdMatch) {
        showError("Could not extract GoFile folder ID from URL.");
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

async function handleXvideosScraping(tab) {
    console.log("Starting XVideos scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        let pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        console.log(`XVideos scrape settings: turbo=${isTurbo}, deep=${isDeep}, autoSend=${autoSend}, pageLimit=${pageLimit}`);
        document.getElementById('stats-text').innerText = isDeep ? "Deep Scan: Scraping up to 50 pages..." : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");

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
                    // Detect total pages
                    let detectedLimit = limit;
                    const pager = document.querySelectorAll('.pagination li a');
                    if (pager.length > 0) {
                        const lastPageText = pager[pager.length - 2]?.innerText;
                        const lastPage = parseInt(lastPageText);
                        if (!isNaN(lastPage)) detectedLimit = Math.min(limit, lastPage);
                    }

                    const url = new URL(window.location.href);
                    const fetchPage = async (pageNum) => {
                        try {
                            const pageUrl = new URL(window.location.href);
                            pageUrl.searchParams.set('p', pageNum - 1);
                            
                            const response = await fetch(pageUrl.href);
                            const text = await response.text();
                            const parser = new DOMParser();
                            const doc = parser.parseFromString(text, 'text/html');
                            return extractFromDoc(doc, pageUrl.href);
                        } catch (e) { return []; }
                    };

                    const promises = [];
                    for (let i = 2; i <= detectedLimit; i++) {
                        promises.push(fetchPage(i));
                    }
                    const extras = await Promise.all(promises);
                    extras.forEach(res => { allResults = allResults.concat(res); });
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

async function handleLeakPornerScraping(tab) {
    console.log("Starting LeakPorner scraping for tab:", tab.id);
    try {
        document.getElementById('loader').style.display = 'flex';
        document.getElementById('video-grid').style.display = 'none';

        const isTurbo = document.getElementById('turbo-mode')?.checked || false;
        const isDeep = document.getElementById('deep-scan')?.checked || false;
        const autoSend = document.getElementById('send-to-dashboard')?.checked || false;
        let pageLimit = isDeep ? 50 : (isTurbo ? 4 : 1);

        console.log(`LeakPorner scrape settings: turbo=${isTurbo}, deep=${isDeep}, autoSend=${autoSend}, pageLimit=${pageLimit}`);
        
        const statsEl = document.getElementById('stats-text');
        if (statsEl) {
            statsEl.innerText = isDeep ? "Deep Scan: Scraping up to 50 pages..." : (isTurbo ? "Turbo mode: Scraping 4 pages..." : "Scraping current page...");
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (limit) => {
                const extractFromDoc = (doc, baseUrl) => {
                    const containers = doc.querySelectorAll('article.loop-video, .loop-video');
                    
                    const videos = Array.from(containers).map(container => {
                        const link = container.querySelector('a[href*="leakporner.com/"]');
                        if (!link) return null;

                        const title = link.getAttribute('data-title') || 
                                     link.getAttribute('title') ||
                                     container.querySelector('.entry-header span')?.innerText?.trim() || 
                                     "LeakPorner Video";
                        
                        const img = container.querySelector('img');
                        let thumbnail = img?.getAttribute('data-src') || img?.src;
                        if (thumbnail && thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;

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
                            quality: 'HD',
                            size: 0
                        };
                    }).filter(v => v && v.url);

                    // If it's a single video page, extract the embeds
                    if (videos.length === 0) {
                        const singleTitle = doc.querySelector('h1.entry-title, .entry-title')?.innerText?.trim() || 
                                          doc.querySelector('meta[property="og:title"]')?.content || 
                                          doc.title;
                        
                        const singleThumb = doc.querySelector('meta[property="og:image"]')?.content || 
                                          doc.querySelector('.vi-on')?.getAttribute('data-thum');

                        const embeds = Array.from(doc.querySelectorAll('.servideo .change-video, .change-video'))
                            .map(span => span.getAttribute('data-embed'))
                            .filter(src => src);

                        if (embeds.length > 0) {
                            videos.push({
                                id: baseUrl,
                                title: singleTitle,
                                url: embeds[0], // Use first embed as primary
                                source_url: baseUrl,
                                thumbnail: singleThumb,
                                quality: 'HD',
                                duration: '',
                                embeds: embeds,
                                size: 0
                            });
                        }
                    }

                    return videos;
                };

                let allResults = extractFromDoc(document, window.location.href);

                if (limit > 1 && allResults.length > 0) {
                    // Pagination
                    const url = new URL(window.location.href);
                    const baseUrl = url.origin + url.pathname.replace(/\/page\/\d+/, '').replace(/\/$/, '');
                    
                    const fetchPage = async (pageNum) => {
                        try {
                            const pageUrl = `${baseUrl}/page/${pageNum}/`;
                            const response = await fetch(pageUrl);
                            const text = await response.text();
                            const parser = new DOMParser();
                            const doc = parser.parseFromString(text, 'text/html');
                            return extractFromDoc(doc, pageUrl);
                        } catch (e) { return []; }
                    };

                    const promises = [];
                    for (let i = 2; i <= limit; i++) {
                        promises.push(fetchPage(i));
                    }
                    const extras = await Promise.all(promises);
                    extras.forEach(res => { allResults = allResults.concat(res); });
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

        allVideos = (results[0].result || []).filter(v => v && v.url);
        currentlyFilteredVideos = [...allVideos];
        
        const folderNameEl = document.getElementById('folder-name');
        if (folderNameEl) {
            folderNameEl.innerText = "LeakPorner Explorer";
        }

        applyFilters();
        updateStats();

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
                    batch_name: `LeakPorner ${isDeep ? 'Deep' : 'Turbo'} ${new Date().toLocaleDateString()}`, 
                    videos: toImport 
                })
            }).catch(err => console.error("LeakPorner auto-send failed", err));
        }

    } catch (err) {
        console.error("Error during LeakPorner scraping:", err);
        showError(`Failed to scrape LeakPorner: ${err.message}`);
    }
}



function renderGrid(videos) {
    const grid = document.getElementById('video-grid');
    const loader = document.getElementById('loader');
    grid.innerHTML = '';

    if (videos.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; opacity: 0.5;">Žiadne videá sa nenašli.</div>';
    } else {
        videos.forEach(video => {
            const card = document.createElement('div');
            card.className = `video-card ${selectedVideos.has(video.id) ? 'selected' : ''}`;

            const isDirect =
                video.direct_ok === true ||
                (video.url &&
                    /^https?:\/\//i.test(video.url) &&
                    /\.(mp4|m4v|mov|mkv|webm|m3u8)(\?|$)/i.test(video.url));
            const typeTag = isDirect
                ? '<span class="type-tag type-direct">DIRECT</span>'
                : '<span class="type-tag type-page">PAGE</span>';
            const streamLine =
                video.url && String(video.url).trim()
                    ? `<div class="stream-url-line" title="${escapeHtml(video.url)}">${escapeHtml(video.url)}</div>`
                    : '';

            // Create inner HTML structure
            card.innerHTML = `
                <div class="thumbnail">
                    <div class="selection-overlay"></div>
                    ${video.rating ? `<div class="rating-badge" style="position:absolute; bottom:5px; right:5px; background:rgba(0,0,0,0.8); color:#2ecc71; padding:2px 5px; border-radius:3px; font-size:10px; font-weight:bold;">★ ${escapeHtml(String(video.rating))}%</div>` : ''}
                </div>
                <div class="info">
                    <div class="title-row">
                        ${typeTag}
                        <div class="title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
                    </div>
                    ${streamLine}
                    <div class="meta-info">
                        <span class="quality-badge">${escapeHtml(video.quality || 'HD')}</span>
                        ${video.duration ? `<span class="duration">🕒 ${escapeHtml(String(video.duration))}</span>` : ''}
                        ${video.views ? `<span class="views-count" style="margin-left:8px; opacity:0.7; font-size:11px;">👁 ${formatViews(video.views)}</span>` : ''}
                        ${video.size > 0 ? `<span class="file-size" style="margin-left: auto;">${(video.size / (1024 * 1024)).toFixed(1)} MB</span>` : ''}
                    </div>
                </div>
            `;

            const img = document.createElement('img');
            const PLACEHOLDER_IMG = BUNKR_PLACEHOLDER_IMG;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';

            if (video.bunkr_page_url && video.thumbnail && video.thumbnail !== 'MISSING_THUMBNAIL') {
                loadBunkrThumbnail(img, video.thumbnail, bunkrThumbPageOrigin);
            } else {
                img.src = video.thumbnail && video.thumbnail !== 'MISSING_THUMBNAIL' ? video.thumbnail : PLACEHOLDER_IMG;
                img.referrerPolicy = 'no-referrer';
                img.onerror = () => {
                    if (img.src !== PLACEHOLDER_IMG) {
                        img.src = PLACEHOLDER_IMG;
                        img.onerror = null;
                    }
                };
            }

            // Prepend image to thumbnail div
            card.querySelector('.thumbnail').prepend(img);

            const urlLine = card.querySelector('.stream-url-line');
            if (urlLine) {
                urlLine.addEventListener('click', (e) => e.stopPropagation());
            }

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
    const copyBtn = document.getElementById('copy-btn');

    statsText.innerText = `Nájdených ${allVideos.length} videí | Vybraných ${selectedVideos.size}`;
    importBtn.innerText = `Importovať (${selectedVideos.size})`;

    // Enable/Disable buttons
    const hasSelection = selectedVideos.size > 0;
    importBtn.disabled = !hasSelection;
    copyBtn.disabled = !hasSelection;
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

// Select All (Respects Filters)
document.getElementById('select-all').onclick = () => {
    if (currentlyFilteredVideos.length === 0) return;

    const allVisibleSelected = currentlyFilteredVideos.every(v => selectedVideos.has(v.id));
    
    if (allVisibleSelected) {
        // If all filtered items are already selected, deselect them
        currentlyFilteredVideos.forEach(v => selectedVideos.delete(v.id));
    } else {
        // Otherwise, select only the currently filtered items
        currentlyFilteredVideos.forEach(v => selectedVideos.add(v.id));
    }
    
    renderGrid(currentlyFilteredVideos);
    updateStats();
};

// Update applyFilters to track current result set
function applyFilters() {
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    const sortBy = document.getElementById('sort-select').value;
    const minMin = parseInt(document.getElementById('min-duration').value) || 0;
    const maxMin = parseInt(document.getElementById('max-duration').value) || 999999;
    const qual = document.getElementById('quality-filter').value;

    currentlyFilteredVideos = allVideos.filter(v => {
        const hay = `${v.title || ''} ${v.url || ''}`.toLowerCase();
        const matchesQuery = !query || hay.includes(query);

        // Bunkr: `duration` holds upload timestamp (HH:MM:SS DD/MM/YYYY), not video length —
        // parseDuration would interpret it as huge seconds and drop every row.
        const seconds = parseDuration(v.duration);
        const minutes = seconds / 60;
        const matchesDuration = v.bunkr_page_url
            ? true
            : minutes >= minMin && minutes <= maxMin;
        
        // Quality filter
        let matchesQuality = true;
        if (qual !== 'all') {
            const q = (v.quality || 'HD').toUpperCase();
            if (qual === 'SD') {
                matchesQuality = !q.includes('720') && !q.includes('1080') && !q.includes('4K') && !q.includes('HD');
            } else {
                matchesQuality = q.includes(qual.toUpperCase());
            }
        }

        return matchesQuery && matchesDuration && matchesQuality;
    });

    if (sortBy === 'name') {
        currentlyFilteredVideos.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortBy === 'size-desc') {
        currentlyFilteredVideos.sort((a, b) => b.size - a.size);
    } else if (sortBy === 'size-asc') {
        currentlyFilteredVideos.sort((a, b) => a.size - b.size);
    } else if (sortBy === 'video-count-desc') {
        currentlyFilteredVideos.sort((a, b) => (b.videoCount || 0) - (a.videoCount || 0));
    }

    renderGrid(currentlyFilteredVideos);
    updateStats();
}

document.getElementById('search-input').oninput = applyFilters;
document.getElementById('sort-select').onchange = applyFilters;
document.getElementById('min-duration').oninput = applyFilters;
document.getElementById('max-duration').oninput = applyFilters;
document.getElementById('quality-filter').onchange = applyFilters;

// Copy to Profile Action
document.getElementById('copy-btn').onclick = async () => {
    const btn = document.getElementById('copy-btn');
    const originalText = btn.innerText;

    // Check token first
    const token = await getGofileToken();
    if (!token) {
        btn.innerText = "Chýba prihlásenie!";
        btn.style.background = "#e74c3c";
        setTimeout(() => { btn.innerText = originalText; btn.style.background = ""; }, 2000);
        return;
    }

    btn.disabled = true;
    btn.innerText = "Kopírujem...";

    try {
        // 1. Get Root Folder ID
        const contentsId = Array.from(selectedVideos).join(',');

        // Delegate EVERYTHING to Content Script (Fixes 403 on getAccountDetails)
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        const copyData = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, {
                action: "COPY_TO_ROOT",
                data: {
                    contentsId: contentsId,
                    token: token
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ status: 'error', message: chrome.runtime.lastError.message });
                } else {
                    resolve(response || { status: 'error', message: "No response from page" });
                }
            });
        });

        if (copyData && copyData.status === 'ok') {
            btn.innerText = "Skopírované!";
            btn.style.background = "#9d50bb"; // Secondary accent color
        } else {
            throw new Error(copyData ? copyData.status : "Unknown error");
        }

    } catch (err) {
        console.error(err);
        btn.innerText = "Chyba: " + err.message;
        btn.style.background = "#e74c3c";
    }

    setTimeout(() => {
        btn.disabled = false;
        btn.innerText = originalText;
        btn.style.background = "";
    }, 3000);
};

// Import Action
document.getElementById('import-btn').onclick = async () => {
    const btn = document.getElementById('import-btn');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Importujem...";

    // Helper to parse duration string OR number to seconds for backend
    const parseDuration = (val) => {
        if (!val) return 0;
        if (typeof val === 'number') return Math.round(val);
        try {
            const parts = String(val).replace(/[^\d:]/g, '').split(':').map(p => parseInt(p, 10));
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return parseInt(parts[0]) || 0;
        } catch { return 0; }
    };

    const toImport = allVideos.filter(v => selectedVideos.has(v.id)).map(v => ({
        title: v.title,
        url: v.url,
        source_url: (v.bunkr_page_url || v.source_url),
        thumbnail: v.thumbnail === "MISSING_THUMBNAIL" ? null : v.thumbnail,
        filesize: v.size || 0,
        quality: v.quality,
        duration: parseDuration(v.duration),
        tags: v.tags || ''
    }));

    // ... rest of dashboard import logic ...
    try {
        const resp = await fetch(`${DASHBOARD_URL}/api/v1/import/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batch_name: `Explorer: ${document.getElementById('folder-name').innerText}`,
                videos: toImport
            })
        });

        if (resp.ok) {
            btn.innerText = "Hotovo!";
            btn.style.background = "#2ecc71";
            setTimeout(() => { window.close(); }, 1000);
        } else {
            throw new Error("Dashboard chyba");
        }
    } catch (err) {
        btn.innerText = "Chyba!";
        btn.style.background = "#e74c3c";
        setTimeout(() => {
            btn.disabled = false;
            btn.innerText = originalText;
            btn.style.background = "";
        }, 2000);
    }
};
