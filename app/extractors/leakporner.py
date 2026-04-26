import logging
import re
import asyncio
import base64
import json
import subprocess
from urllib.parse import urljoin
from typing import Optional, Dict, Any, List
from bs4 import BeautifulSoup
import aiohttp
import requests
import yt_dlp
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class LeakPornerExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "LeakPorner"

    def can_handle(self, url: str) -> bool:
        u = url.lower()
        return "leakporner.com" in u or "djav.org" in u

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        # Strategy 1: Try yt-dlp on the page directly
        result = await asyncio.to_thread(self._try_ytdlp, url)
        if result and self._is_direct_playable_url(result.get('stream_url')):
            logger.info(f"LeakPorner yt-dlp success: {url}")
            return result
        if result and result.get('stream_url'):
            logger.debug(
                "LeakPorner yt-dlp returned non-direct stream URL, continuing with HTML parsing: %s",
                result.get('stream_url'),
            )

        # Strategy 2: Parse page for embeds, then resolve them
        return await self._parse_and_resolve(url)

    @staticmethod
    def _normalize_embed_url(embed_url: str) -> Optional[str]:
        url = (embed_url or "").strip()
        if not url or not url.startswith(("http://", "https://")):
            return None
        if 'luluvids.top' in url:
            url = url.replace('/v/', '/e/').replace('luluvids.top', 'luluvids.com')
        return url

    @staticmethod
    def _collect_embed_urls(html: str, soup: BeautifulSoup) -> List[str]:
        embed_urls: List[str] = []
        servideo = soup.find('div', class_='servideo')
        if servideo:
            for span in servideo.find_all('span', class_='change-video'):
                e = LeakPornerExtractor._normalize_embed_url(span.get('data-embed') or "")
                if e and e not in embed_urls:
                    embed_urls.append(e)
        for match in re.findall(r'data-embed=["\']([^"\']+)["\']', html):
            e = LeakPornerExtractor._normalize_embed_url(match)
            if e and e not in embed_urls:
                embed_urls.append(e)
        return embed_urls

    @staticmethod
    def _extract_direct_media_url(html: str, page_url: str) -> Optional[str]:
        if not html:
            return None

        soup = BeautifulSoup(html, "html.parser")
        candidates: List[str] = []

        for tag in soup.select(
            "video source[src], video[src], meta[property='og:video'], meta[property='og:video:url'], meta[property='og:video:secure_url']"
        ):
            candidate = (tag.get("src") or tag.get("content") or "").strip()
            if candidate:
                candidates.append(candidate)

        for match in re.findall(r'https?://[^"\']+\.(?:mp4|m3u8|webm|m4v)(?:\?[^"\']*)?', html, flags=re.I):
            candidates.append(match)

        for candidate in candidates:
            try:
                candidate = urljoin(page_url, candidate.strip())
            except Exception:
                continue
            low = candidate.lower()
            if low.startswith("blob:") or low.startswith("data:"):
                continue
            if any(token in low for token in (".mp4", ".m3u8", ".webm", ".m4v")):
                return candidate
        return None

    @staticmethod
    def _is_direct_playable_url(url: Optional[str]) -> bool:
        low = (url or "").lower()
        return any(token in low for token in (".m3u8", ".mp4", ".webm", ".m4v"))

    @staticmethod
    def _decode_b64url(raw: str) -> bytes:
        text = (raw or "").strip().replace("-", "+").replace("_", "/")
        text += "=" * (-len(text) % 4)
        return base64.b64decode(text)

    @classmethod
    def _resolve_byse_playback(cls, embed_url: str) -> Optional[Dict[str, Any]]:
        url = (embed_url or "").strip()
        if not url:
            return None
        match = re.search(r"/(?:e|kpw)/([a-zA-Z0-9_-]+)", url)
        if not match:
            return None

        code = match.group(1)
        api_url = f"https://bysezoxexe.com/api/videos/{code}/embed/playback"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://w12.leakporner.com/",
            "Origin": "https://bysezoxexe.com",
        }
        resp = requests.get(api_url, headers=headers, timeout=20)
        if resp.status_code != 200:
            return None

        data = resp.json() or {}
        playback = data.get("playback") or {}
        key_parts = playback.get("key_parts") or []
        iv = playback.get("iv") or ""
        payload = playback.get("payload") or ""
        if not key_parts or not iv or not payload:
            return None

        try:
            key = b"".join(cls._decode_b64url(part) for part in key_parts)
            nonce = cls._decode_b64url(iv)
            ciphertext = cls._decode_b64url(payload)
            plain = AESGCM(key).decrypt(nonce, ciphertext, None)
            parsed = json.loads(plain.decode("utf-8", errors="replace"))
            sources = parsed.get("sources") or []
            if not sources:
                return None
            # Prefer the first real playable source.
            sorted_sources = sorted(
                sources,
                key=lambda s: (
                    0 if cls._is_direct_playable_url(s.get("url")) else 1,
                    -(int(s.get("bitrate_kbps") or 0)),
                    -(int(s.get("height") or 0)),
                ),
            )
            for source in sorted_sources:
                candidate = (source.get("url") or "").strip()
                if candidate and cls._is_direct_playable_url(candidate):
                    return {
                        "title": "",
                        "thumbnail": parsed.get("poster_url") or data.get("poster_url") or "",
                        "duration": 0.0,
                        "stream_url": candidate,
                        "width": 0,
                        "height": int(source.get("height") or 0),
                        "uploader": "LeakPorner",
                        "is_hls": ".m3u8" in candidate.lower(),
                    }
        except Exception as exc:
            logger.debug("LeakPorner byse playback decrypt failed for %s: %s", embed_url, exc)
        return None

    @staticmethod
    def _resolve_jwplayer_script(script_text: str, page_url: str) -> Optional[str]:
        if not script_text or "jwplayer" not in script_text.lower():
            return None

        node_code = r"""
const vm = require('node:vm');
const script = Buffer.from(process.argv[1], 'base64').toString('utf8');
const pageUrl = process.argv[2];
const hits = [];

function makeStubElement(tag) {
  return {
    tagName: String(tag || '').toUpperCase(),
    style: {},
    children: [],
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) {
      this.children.push(child);
      if (child && typeof child.textContent === 'string' && child.textContent.trim()) {
        try { vm.runInContext(child.textContent, context, { timeout: 3000 }); } catch (e) {}
      }
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
    },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    innerHTML: '',
    textContent: '',
  };
}

const body = makeStubElement('body');
const document = {
  body,
  createElement: makeStubElement,
  scripts: [],
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};

const chain = {
  on() { return this; },
  click() { return this; },
  ready(cb) { try { if (typeof cb === 'function') cb(); } catch (e) {} return this; },
  attr() { return ''; },
  text() { return ''; },
  html() { return ''; },
  append() { return this; },
  addClass() { return this; },
  removeClass() { return this; },
  hide() { return this; },
  show() { return this; },
  find() { return this; },
  each() { return this; },
  data() { return null; },
  val() { return ''; },
  length: 0,
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  window: null,
  document,
  location: {
    href: pageUrl,
    host: new URL(pageUrl).host,
    pathname: new URL(pageUrl).pathname,
    protocol: new URL(pageUrl).protocol,
  },
  navigator: { userAgent: 'Mozilla/5.0' },
  localStorage: {
    _s: {},
    getItem(k) { return this._s[k] ?? null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
  },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  fetch: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}), headers: { get: () => null } }),
  DOMParser: class { parseFromString(txt) { return { textContent: txt, querySelector() { return null; }, querySelectorAll() { return []; }, body: { innerHTML: txt } }; } },
  URL,
  Blob,
  FormData,
  Headers,
  MutationObserver: class { observe() {} disconnect() {} },
  performance: { now: () => Date.now() },
  open: (link) => { hits.push({ type: 'open', link }); return null; },
  alert() {},
  confirm: () => true,
  prompt: () => '',
};

const $ = function () { return chain; };
$.cookie = () => {};
$.ajaxSetup = () => {};
$.ajax = () => chain;
$.get = () => chain;
$.post = () => chain;
$.fn = {};

sandbox["$"] = $;
sandbox.jwplayer = function () {
  return {
    setup(cfg) { hits.push({ type: 'jwsetup', cfg }); return this; },
    on() { return this; },
    addButton() { return this; },
    playlistItem() { return this; },
    load() { return this; },
    play() { return this; },
    getPlaylistItem() { return {}; },
    getCurrentTime() { return 0; },
    getPosition() { return 0; },
    setCurrentAudioTrack() { return this; },
    getAudioTracks() { return []; },
    onReady() { return this; },
  };
};
sandbox.window = sandbox;

const context = vm.createContext(sandbox);
try { vm.runInContext(script, context, { timeout: 5000 }); } catch (e) {}

for (const hit of hits) {
  if (hit.type === 'jwsetup' && hit.cfg) {
    const sources = Array.isArray(hit.cfg.sources) ? hit.cfg.sources : [];
    for (const source of sources) {
      const file = source && source.file ? String(source.file) : '';
      if (file) {
        process.stdout.write(new URL(file, pageUrl).href);
        process.exit(0);
      }
    }
  }
}
for (const hit of hits) {
  if (hit.type === 'open' && hit.link) {
    process.stdout.write(String(hit.link));
    process.exit(0);
  }
}
"""
        try:
            payload = base64.b64encode(script_text.encode("utf-8")).decode("ascii")
            completed = subprocess.run(
                ["node", "-e", node_code, payload, page_url],
                capture_output=True,
                text=True,
                timeout=8,
            )
            candidate = (completed.stdout or "").strip()
            if candidate.startswith(("http://", "https://")):
                return candidate
        except Exception as exc:
            logger.debug(f"LeakPorner jwplayer sandbox failed: {exc}")
        return None

    def _try_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        def _try_ytdlp_cli_impersonate(target_url: str) -> Optional[str]:
            try:
                completed = subprocess.run(
                    [
                        "yt-dlp",
                        "--extractor-args",
                        "generic:impersonate",
                        "-g",
                        target_url,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                direct = (completed.stdout or "").strip().splitlines()
                for line in direct:
                    line = line.strip()
                    if line.startswith(("http://", "https://")):
                        return line
            except Exception as cli_exc:
                logger.debug(f"LeakPorner djav yt-dlp CLI fallback failed: {cli_exc}")
            return None

        try:
            ydl_opts = {
                'quiet': True, 'no_warnings': True, 'skip_download': True,
                'format': 'best[ext=mp4]/best[protocol*=m3u8]/best',
                'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if not info:
                return None
            stream_url = info.get('url')
            if not stream_url and info.get('formats'):
                fmts = sorted([f for f in info['formats'] if f.get('url')],
                               key=lambda f: f.get('height') or 0, reverse=True)
                if fmts:
                    stream_url = fmts[0]['url']
            if not stream_url:
                if "djav.org" in url.lower():
                    stream_url = _try_ytdlp_cli_impersonate(url)
                if not stream_url:
                    return None
            return {
                "id": info.get('id', ''),
                "title": info.get('title', ''),
                "description": info.get('description', ''),
                "thumbnail": info.get('thumbnail', ''),
                "duration": float(info.get('duration') or 0.0),
                "stream_url": stream_url,
                "width": int(info.get('width') or 0),
                "height": int(info.get('height') or 0),
                "tags": info.get('tags', []),
                "uploader": "LeakPorner",
                "is_hls": '.m3u8' in stream_url.lower(),
            }
        except Exception as e:
            logger.debug(f"LeakPorner yt-dlp failed: {e}")
            if "djav.org" in url.lower():
                stream_url = _try_ytdlp_cli_impersonate(url)
                if stream_url:
                    return {
                        "id": "",
                        "title": "",
                        "description": "",
                        "thumbnail": "",
                        "duration": 0.0,
                        "stream_url": stream_url,
                        "width": 0,
                        "height": 0,
                        "tags": [],
                        "uploader": "LeakPorner",
                        "is_hls": '.m3u8' in stream_url.lower(),
                    }
            return None

    async def _parse_and_resolve(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://leakporner.com/'
            }
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status != 200:
                        return None
                    html = await resp.text()

            soup = BeautifulSoup(html, 'lxml')

            # Title
            title = (soup.find('meta', property='og:title') or {}).get('content', '')
            if not title:
                h1 = soup.find('h1', class_='entry-title')
                title = h1.get_text(strip=True) if h1 else (soup.title.get_text(strip=True) if soup.title else "LeakPorner Video")
            title = title.replace(' - LeakPorner', '').strip()

            # Thumbnail
            thumbnail = (soup.find('meta', property='og:image') or {}).get('content', '')
            if not thumbnail:
                vi_on = soup.find('div', class_='vi-on')
                if vi_on:
                    thumbnail = (vi_on.get('data-thum') or '').strip()

            # Duration from span.duration text
            dur_span = soup.find('span', class_='duration')
            duration = 0.0
            if dur_span:
                dur_text = dur_span.get_text(strip=True).replace('\xa0', '').strip()
                parts = [p for p in re.split(r'[:\s]+', dur_text) if p.isdigit()]
                if len(parts) == 3:
                    duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    duration = int(parts[0]) * 60 + int(parts[1])

            # Embed URLs
            embed_urls = self._collect_embed_urls(html, soup)

            video_id = url.rstrip('/').split('/')[-1] or url.rstrip('/').split('/')[-2]

            direct_media_url = self._extract_direct_media_url(html, url)

            # Resolve embeds to direct stream
            stream_url = direct_media_url
            async with aiohttp.ClientSession(headers=headers) as session:
                if not stream_url:
                    for embed_url in embed_urls[:4]:
                        stream_url = await self._resolve_embed(embed_url, session, url)
                        if stream_url:
                            logger.info(f"Resolved embed {embed_url} -> {stream_url[:60]}")
                            break

            # Fallback: try yt-dlp on embed URL
            if not stream_url and embed_urls:
                ytdlp_result = await asyncio.to_thread(self._try_ytdlp, embed_urls[0])
                if ytdlp_result:
                    stream_url = ytdlp_result.get('stream_url')
                    if not thumbnail and ytdlp_result.get('thumbnail'):
                        thumbnail = ytdlp_result['thumbnail']

            if not stream_url:
                stream_url = embed_urls[0] if embed_urls else url

            return {
                "id": video_id,
                "title": title,
                "description": title,
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": stream_url,
                "width": 0, "height": 720,
                "tags": [],
                "uploader": "LeakPorner",
                "is_hls": '.m3u8' in (stream_url or '').lower(),
                "embed_urls": embed_urls,
            }
        except Exception as e:
            logger.error(f"LeakPorner extraction failed for {url}: {e}")
            return None

    async def _resolve_embed(self, embed_url: str, session: aiohttp.ClientSession, referer: str) -> Optional[str]:
        """Fetch embed page and find direct video URL inside."""
        try:
            embed_url = self._normalize_embed_url(embed_url or "")
            if not embed_url:
                return None

            if any(domain in embed_url.lower() for domain in ("bysezoxexe.com", "398fitus.com")):
                byse_meta = self._resolve_byse_playback(embed_url)
                if byse_meta and byse_meta.get("stream_url"):
                    return byse_meta["stream_url"]

            async with session.get(embed_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': referer
            }, timeout=aiohttp.ClientTimeout(total=12), ssl=False) as resp:
                if resp.status != 200:
                    return None
                html = await resp.text()

            # Ordered patterns - most specific first
            patterns = [
                r'["\']?(https?://[^"\'>\s]+\.m3u8(?:\?[^"\'>\s]*)?)["\']?',
                r'["\']?(https?://[^"\'>\s]+\.mp4(?:\?[^"\'>\s]*)?)["\']?',
                r'file\s*:\s*["\']([^"\']+)["\']',
                r'"hls"\s*:\s*["\']([^"\']+)["\']',
                r'"src"\s*:\s*"(https?://[^"]+\.(?:m3u8|mp4)[^"]*)"',
                r'src=["\'](https?://[^"\']+\.(?:m3u8|mp4)[^"\']*)["\']',
                r'sources\s*:\s*\[\s*\{\s*file\s*:\s*["\']([^"\']+)["\']',
            ]

            for pattern in patterns:
                for match in re.findall(pattern, html, re.IGNORECASE):
                    url_cand = match.strip().strip('"\'')
                    if not url_cand.startswith('http'):
                        if url_cand.startswith('//'):
                            url_cand = 'https:' + url_cand
                        else:
                            continue
                    if any(x in url_cand.lower() for x in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.js', '.css']):
                        continue
                    if '.m3u8' in url_cand.lower() or '.mp4' in url_cand.lower():
                        if '.m3u8' in url_cand.lower():
                            try:
                                async with session.get(
                                    url_cand,
                                    headers={
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                        'Referer': referer,
                                    },
                                    timeout=aiohttp.ClientTimeout(total=10),
                                    ssl=False,
                                ) as probe_resp:
                                    if probe_resp.status != 200:
                                        continue
                                    probe_body = await probe_resp.text()
                                    probe_low = probe_body.lower()
                                    if any(token in probe_low for token in ('.image', 'tiktokcdn', 'ad-site')) and not any(token in probe_low for token in ('.ts', '.m4s', '.mp4')):
                                        continue
                            except Exception:
                                pass
                        return url_cand

            scripts = BeautifulSoup(html, 'lxml').find_all('script')
            for script in scripts:
                script_text = script.get_text("\n", strip=False)
                if any(token in script_text.lower() for token in ('jwplayer', 'currentfile', 'pickdirect', '__directlink')):
                    direct = self._resolve_jwplayer_script(script_text, embed_url)
                    if direct and ('.m3u8' in direct.lower() or '.mp4' in direct.lower()):
                        return direct
        except Exception as e:
            logger.debug(f"Embed resolve failed for {embed_url}: {e}")
        return None
