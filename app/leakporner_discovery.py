"""
LeakPorner Discovery Module
Smart discovery and import system for LeakPorner listing pages.
"""
import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_BASE_URL = "https://w12.leakporner.com/"
_ROOT_REFERER = "https://leakporner.com/"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def _parse_duration_seconds(raw: str) -> int:
    text = (raw or "").strip()
    if not text:
        return 0
    match = re.search(r"(\d+):(\d+)(?::(\d+))?", text)
    if not match:
        return 0
    if match.group(3):
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
    return int(match.group(1)) * 60 + int(match.group(2))


def _normalize_thumb_url(raw: Optional[str]) -> Optional[str]:
    thumb = (raw or "").strip()
    if not thumb:
        return None
    if thumb.startswith("//"):
        return f"https:{thumb}"
    if thumb.startswith("/"):
        return urljoin(_BASE_URL, thumb)
    return thumb if thumb.startswith(("http://", "https://")) else None


def _extract_from_listing(article) -> Optional[Dict[str, Any]]:
    try:
        link = article.find("a", href=True)
        if not link:
            return None

        video_url = urljoin(_BASE_URL, link["href"])
        title = (
            (link.get("data-title") or "").strip()
            or (link.get("title") or "").strip()
        )

        thumb_wrap = article.find("div", class_=re.compile(r"post-thumbnail", re.I))
        img = thumb_wrap.find("img") if thumb_wrap else article.find("img")
        if not title and img and img.get("alt"):
            title = img.get("alt", "").strip()
        if not title:
            header = article.find(["header", "div", "span"], class_=re.compile(r"entry-header|title", re.I))
            if header:
                title = header.get_text(" ", strip=True)
        if not title:
            slug = video_url.rstrip("/").split("/")[-1]
            title = slug.replace("-", " ").replace("_", " ").title() if slug else "LeakPorner Video"

        duration = 0
        duration_elem = article.find(["span", "div"], class_=re.compile(r"duration|time|length", re.I))
        if duration_elem:
            duration = _parse_duration_seconds(duration_elem.get_text(" ", strip=True))

        thumbnail = None
        if img:
            thumbnail = _normalize_thumb_url(
                img.get("data-src")
                or img.get("data-original")
                or img.get("data-lazy-src")
                or img.get("src")
            )

        return {
            "title": title,
            "url": video_url,
            "thumbnail": thumbnail,
            "duration": duration,
            "quality": "unknown",
            "resolution": 0,
            "upload_type": "studio",
            "views": 0,
            "stream_url": None,
            "source": "leakporner",
        }
    except Exception as exc:
        logger.warning("[LEAKPORNER_DISCOVERY] Failed to parse listing card: %s", exc)
        return None


def scrape_leakporner_discovery(
    keyword: str = "",
    pages: int = 1,
    min_duration: int = 0,
    sort: str = "latest",
) -> List[Dict[str, Any]]:
    """
    Discover videos from LeakPorner listing pages.

    Args:
        keyword: Optional title filter applied locally.
        pages: Number of pages to scan.
        min_duration: Minimum duration in seconds.
        sort: latest, longest, or random.
    """
    pages = min(max(int(pages or 1), 1), 10)
    keyword_norm = (keyword or "").strip().lower()
    sort_norm = (sort or "latest").strip().lower()
    if sort_norm not in {"latest", "longest", "random"}:
        sort_norm = "latest"

    headers = {
        "User-Agent": _UA,
        "Referer": _ROOT_REFERER,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }

    results: List[Dict[str, Any]] = []
    seen_urls = set()

    logger.info(
        "[LEAKPORNER_DISCOVERY] Starting scrape keyword='%s' pages=%s min_duration=%s sort=%s",
        keyword,
        pages,
        min_duration,
        sort_norm,
    )

    for page_num in range(1, pages + 1):
        try:
            if page_num == 1:
                page_url = _BASE_URL
            else:
                page_url = urljoin(_BASE_URL, f"page/{page_num}/")

            params = {}
            if sort_norm != "latest":
                params["filter"] = sort_norm

            resp = requests.get(page_url, headers=headers, params=params, timeout=20, allow_redirects=True)
            if resp.status_code != 200:
                logger.warning("[LEAKPORNER_DISCOVERY] Page %s returned %s", page_num, resp.status_code)
                continue

            soup = BeautifulSoup(resp.text, "html.parser")
            articles = soup.find_all("article", class_=re.compile(r"loop-video|thumb-block", re.I))
            logger.info("[LEAKPORNER_DISCOVERY] Page %s yielded %s listing cards", page_num, len(articles))

            for article in articles:
                item = _extract_from_listing(article)
                if not item or not item.get("url"):
                    continue
                if item["url"] in seen_urls:
                    continue
                seen_urls.add(item["url"])

                if keyword_norm and keyword_norm not in (item.get("title") or "").lower():
                    continue
                if min_duration and int(item.get("duration") or 0) < min_duration:
                    continue

                results.append(item)
        except Exception as exc:
            logger.error("[LEAKPORNER_DISCOVERY] Error on page %s: %s", page_num, exc, exc_info=True)

    logger.info("[LEAKPORNER_DISCOVERY] Finished with %s results", len(results))
    return results
