import asyncio
import logging
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class ThotsTvExtractor(VideoExtractor):
    _request_lock = threading.Lock()
    _last_request_ts = 0.0
    _min_interval_seconds = 1.35

    @property
    def name(self) -> str:
        return "ThotsTv"

    def can_handle(self, url: str) -> bool:
        low = (url or "").lower()
        return "thots.tv/" in low or "thot.tv/" in low

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        return await asyncio.to_thread(self._extract_sync, url)

    def _extract_sync(self, url: str) -> Optional[Dict[str, Any]]:
        page_url = self._canonical_watch_url(url)
        if not page_url:
            logger.warning("[ThotsTv] unsupported URL for extraction: %s", url)
            return None

        headers = {
            "User-Agent": _UA,
            "Referer": "https://thots.tv/",
            "Accept-Language": "en-US,en;q=0.9",
        }
        resp = self._fetch_watch_page(page_url, headers)
        if resp is None:
            return None

        html = resp.text or ""
        if not html:
            return None

        title = self._extract_first(
            html,
            [
                r"<title>(.*?)</title>",
                r'<meta\s+property="og:title"\s+content="([^"]+)"',
            ],
            flags=re.I | re.S,
        ) or "Thots.tv Video"
        title = re.sub(r"\s+", " ", title).strip()

        thumbnail = self._extract_first(
            html,
            [
                r'preview_url\s*:\s*[\'"]([^\'"]+)[\'"]',
                r'<meta\s+property="og:image"\s+content="([^"]+)"',
            ],
            flags=re.I,
        )

        duration_raw = self._extract_first(
            html,
            [
                r'<meta\s+property="video:duration"\s+content="(\d+)"',
                r'video_duration\s*:\s*[\'"]?(\d+)',
            ],
            flags=re.I,
        )
        duration = int(duration_raw or 0)

        candidates = self._extract_candidates(html)
        if not candidates:
            logger.warning("[ThotsTv] no stream candidates found for %s", page_url)
            return None

        best_url, best_height = self._pick_best_candidate(candidates)
        if not best_url:
            return None

        return {
            "id": self._extract_first(page_url, [r"/video/(\d+)"], flags=re.I),
            "title": title,
            "description": "",
            "thumbnail": thumbnail,
            "duration": duration,
            "stream_url": best_url,
            "width": 1280 if best_height >= 720 else 854 if best_height >= 480 else 0,
            "height": best_height,
            "tags": [],
            "uploader": "",
            "is_hls": ".m3u8" in best_url.lower(),
            "source_url": page_url,
        }

    def _canonical_watch_url(self, url: str) -> Optional[str]:
        raw = (url or "").strip()
        if not raw.startswith(("http://", "https://")):
            return None
        low = raw.lower()
        if "/video/" in low:
            return raw
        if "/get_file/" in low or "/remote_control.php" in low:
            return None
        return None

    def _fetch_watch_page(self, page_url: str, headers: Dict[str, str]) -> Optional[requests.Response]:
        delays = [0.0, 2.5, 5.0, 9.0]
        last_exc: Optional[Exception] = None
        for attempt, backoff in enumerate(delays, start=1):
            if backoff:
                time.sleep(backoff)
            self._respect_rate_limit()
            try:
                resp = requests.get(page_url, headers=headers, timeout=20)
                if resp.status_code == 429:
                    logger.warning(
                        "[ThotsTv] rate limited on attempt %s for %s",
                        attempt,
                        page_url,
                    )
                    continue
                resp.raise_for_status()
                return resp
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "[ThotsTv] watch page fetch failed on attempt %s for %s: %s",
                    attempt,
                    page_url,
                    exc,
                )
        logger.warning("[ThotsTv] giving up on %s after retries: %s", page_url, last_exc)
        return None

    @classmethod
    def _respect_rate_limit(cls) -> None:
        with cls._request_lock:
            now = time.monotonic()
            wait_for = cls._min_interval_seconds - (now - cls._last_request_ts)
            if wait_for > 0:
                time.sleep(wait_for)
            cls._last_request_ts = time.monotonic()

    def _extract_candidates(self, html: str) -> List[Tuple[str, int]]:
        candidates: List[Tuple[str, int]] = []
        patterns = [
            (r'video_alt_url(?:_\d+)?\s*:\s*[\'"]([^\'"]+)[\'"]', True),
            (r'video_url(?:_\d+)?\s*:\s*[\'"]([^\'"]+)[\'"]', True),
            (r'(https?://[^\'"]+\.mp4/?\?v-acctoken=[^\'"]+)', False),
        ]
        for pattern, infer_quality in patterns:
            for match in re.findall(pattern, html, re.I):
                stream_url = match.replace("\\/", "/").strip()
                height = self._infer_height(stream_url if infer_quality else "")
                candidates.append((stream_url, height))
        deduped: List[Tuple[str, int]] = []
        seen = set()
        for stream_url, height in candidates:
            if stream_url in seen:
                continue
            seen.add(stream_url)
            deduped.append((stream_url, height))
        return deduped

    def _pick_best_candidate(self, candidates: List[Tuple[str, int]]) -> Tuple[Optional[str], int]:
        best_url: Optional[str] = None
        best_height = 0
        best_score = -1
        for stream_url, height in candidates:
            score = height
            low = stream_url.lower()
            if "v-acctoken=" in low:
                score += 10000
            if ".mp4" in low:
                score += 100
            if score > best_score:
                best_score = score
                best_url = stream_url
                best_height = height
        return best_url, best_height

    def _infer_height(self, stream_url: str) -> int:
        low = (stream_url or "").lower()
        match = re.search(r'_(\d{3,4})p\.mp4', low)
        if match:
            return int(match.group(1))
        if ".mp4" in low:
            return 480
        return 0

    def _extract_first(self, text: str, patterns: List[str], flags: int = 0) -> Optional[str]:
        for pattern in patterns:
            match = re.search(pattern, text, flags)
            if match:
                return match.group(1)
        return None
