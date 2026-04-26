import asyncio
import json
import logging
import re
from typing import Any, Dict, Optional

import requests
import yt_dlp

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class NoodleMagazineExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "NoodleMagazine"

    def can_handle(self, url: str) -> bool:
        u = (url or "").lower()
        return "noodlemagazine.com" in u and "/watch/" in u

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        manual = await asyncio.to_thread(self._extract_manual, url)
        if manual and manual.get("stream_url"):
            return manual
        return await asyncio.to_thread(self._extract_ytdlp, url)

    def _extract_manual(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            resp = requests.get(
                url,
                headers={
                    "User-Agent": _UA,
                    "Referer": "https://noodlemagazine.com/",
                    "Accept-Language": "en-US,en;q=0.9",
                },
                timeout=20,
            )
            if resp.status_code != 200:
                logger.warning("[NoodleMagazine] HTTP %s for %s", resp.status_code, url)
                return None

            html = resp.text or ""
            if not html:
                return None

            title = ""
            thumbnail = ""
            duration = 0
            tags = []

            ld_match = re.search(
                r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                html,
                re.DOTALL | re.IGNORECASE,
            )
            if ld_match:
                try:
                    ld = json.loads(ld_match.group(1))
                    if isinstance(ld, list) and ld:
                        ld = ld[0]
                    if isinstance(ld, dict):
                        title = str(ld.get("name") or ld.get("headline") or "").strip()
                        t = ld.get("thumbnailUrl") or ld.get("thumbnail")
                        if isinstance(t, list):
                            thumbnail = (t[0] or "").strip() if t else ""
                        elif isinstance(t, dict):
                            thumbnail = str(t.get("url") or "").strip()
                        else:
                            thumbnail = str(t or "").strip()
                        tags = ld.get("keywords") or []
                        if isinstance(tags, str):
                            tags = [x.strip() for x in tags.split(",") if x.strip()]
                        dur_raw = str(ld.get("duration") or "")
                        dm = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", dur_raw, re.I)
                        if dm:
                            duration = (
                                int(dm.group(1) or 0) * 3600
                                + int(dm.group(2) or 0) * 60
                                + int(dm.group(3) or 0)
                            )
                except Exception:
                    pass

            if not title:
                m = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
                if m:
                    title = re.sub(r"\s+", " ", m.group(1)).strip()
            if not thumbnail:
                m = re.search(
                    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
                    html,
                    re.I,
                )
                if m:
                    thumbnail = m.group(1).strip()
            if not duration:
                m = re.search(
                    r'<meta[^>]+property=["\']video:duration["\'][^>]+content=["\'](\d+)["\']',
                    html,
                    re.I,
                )
                if m:
                    duration = int(m.group(1))

            stream_url = None
            candidates = []
            patterns = [
                r'["\']?(https?://[^"\'>\s]+\.m3u8[^"\'>\s]*)["\']?',
                r'["\']?(https?://[^"\'>\s]+\.mp4[^"\'>\s]*)["\']?',
                r'file\s*:\s*["\'](https?://[^"\']+)["\']',
                r'sources?\s*:\s*(\[[^\]]+\])',
            ]
            for pat in patterns:
                for match in re.findall(pat, html, re.I | re.S):
                    if isinstance(match, str):
                        if pat.endswith(r"(\[[^\]]+\])"):
                            try:
                                arr = json.loads(match)
                                if isinstance(arr, list):
                                    for item in arr:
                                        if isinstance(item, dict) and item.get("file"):
                                            candidates.append(str(item["file"]).replace("\\/", "/"))
                            except Exception:
                                continue
                        else:
                            candidates.append(match.replace("\\/", "/"))

            best_score = -1
            for c in candidates:
                if not c.startswith("http"):
                    continue
                low = c.lower()
                score = 0
                if ".m3u8" in low:
                    score += 2000
                if ".mp4" in low:
                    score += 1000
                q = re.search(r"(\d{3,4})p", low)
                if q:
                    score += int(q.group(1))
                if score > best_score:
                    best_score = score
                    stream_url = c

            if not stream_url:
                return None

            is_hls = ".m3u8" in stream_url.lower()
            return {
                "id": None,
                "title": title or "NoodleMagazine Video",
                "description": "",
                "thumbnail": thumbnail or None,
                "duration": int(duration or 0),
                "stream_url": stream_url,
                "width": 0,
                "height": 0,
                "tags": tags if isinstance(tags, list) else [],
                "uploader": "",
                "is_hls": is_hls,
            }
        except Exception as exc:
            logger.warning("[NoodleMagazine] manual extraction failed for %s: %s", url, exc)
            return None

    def _extract_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            opts = {
                "quiet": True,
                "skip_download": True,
                "no_warnings": True,
                "extract_flat": False,
                "format": "best[protocol*=m3u8]/best[ext=mp4]/best",
                "user_agent": _UA,
                "http_headers": {
                    "User-Agent": _UA,
                    "Referer": "https://noodlemagazine.com/",
                },
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if not info:
                return None
            stream_url = info.get("url")
            if not stream_url:
                fmts = [f for f in (info.get("formats") or []) if f.get("url")]
                if fmts:
                    fmts.sort(key=lambda f: (f.get("height") or 0), reverse=True)
                    stream_url = fmts[0]["url"]
            if not stream_url:
                return None
            return {
                "id": info.get("id"),
                "title": info.get("title") or "NoodleMagazine Video",
                "description": info.get("description") or "",
                "thumbnail": info.get("thumbnail"),
                "duration": int(info.get("duration") or 0),
                "stream_url": stream_url,
                "width": int(info.get("width") or 0),
                "height": int(info.get("height") or 0),
                "tags": info.get("tags") or [],
                "uploader": info.get("uploader") or "",
                "is_hls": ".m3u8" in str(stream_url).lower(),
            }
        except Exception as exc:
            logger.warning("[NoodleMagazine] yt-dlp fallback failed for %s: %s", url, exc)
            return None
