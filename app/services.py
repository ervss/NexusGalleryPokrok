import os
import ffmpeg
import concurrent.futures
import urllib.parse
from typing import Optional
import yt_dlp
import glob
import logging
import subprocess
from sqlalchemy.orm import Session
from .database import Video, SessionLocal
from .websockets import manager # Import the manager
import re
import requests
from bs4 import BeautifulSoup
import time
import httpx
import json
import shutil
import asyncio
import sys
import threading
import urllib.parse
from collections import Counter

logger = logging.getLogger(__name__)

# Ensure we can import from the root extractors and archivist
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from .extractors.bunkr import BunkrExtractor
from .extractors.gofile import GoFileExtractor
from extractors.generic import PixeldrainExtractor
from scripts.archivist import Archivist

# --- Eporner API import ---
def fetch_eporner_videos(query=None, page=1, per_page=20, tags=None, gay=None, hd=None, pornstar=None, order=None):
    base_url = "https://www.eporner.com/api/v2/video/search/"
    params = { "query": query or "", "per_page": per_page, "page": page }
    if tags: params["tags"] = tags
    if gay is not None: params["gay"] = int(bool(gay))
    if hd is not None: params["hd"] = int(bool(hd))
    if pornstar: params["pornstar"] = pornstar
    if order: params["order"] = order
    try:
        resp = requests.get(base_url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logging.error(f"Eporner API Error: {e}")
        return []

    videos = []
    for v in data.get("videos", []):
        duration = v.get("length_sec")
        if not duration and v.get("length_min"):
            try:
                # If length_min is "10:30", convert to seconds
                parts = str(v.get("length_min")).split(':')
                if len(parts) == 2:
                    duration = int(parts[0]) * 60 + int(parts[1])
                else:
                    duration = int(v.get("length_min")) * 60
            except:
                duration = v.get("length_min")

        videos.append({
            "title": v.get("title"),
            "url": v.get("url"),
            "thumbnail": v.get("default_thumb", {}).get("src") if isinstance(v.get("default_thumb"), dict) else v.get("default_thumb"),
            "video_url": None,
            "duration": duration,
            "quality": "HD" if v.get("hd") else "SD",
            "embed_url": v.get("embed")
        })
    return videos

# --- Eporner Smart Discovery (HTML Scraping) ---
def scrape_eporner_discovery(keyword: str, min_quality: int = 1080, pages: int = 2, auto_skip_low_quality: bool = True):
    """
    Scrapes Eporner tag/search pages directly via HTML parsing.
    Does NOT use the Eporner API.
    
    Args:
        keyword: Tag or search term (e.g., "bbc sloppy")
        min_quality: Minimum resolution in pixels (720, 1080, 1440, 2160)
        pages: Number of pages to scrape
        auto_skip_low_quality: If True, filter out videos below min_quality
    
    Returns:
        List of video dictionaries with metadata
    """
    results = []
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.eporner.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    }
    
    # Determine mode and base URL
    is_tag_mode = keyword.lower().startswith('tag:')
    clean_keyword = keyword[4:].strip() if is_tag_mode else keyword.strip()
    
    if is_tag_mode:
        tag_slug = clean_keyword.lower().replace(' ', '-').replace('_', '-')
        base_url = f"https://www.eporner.com/tag/{tag_slug}/"
        logging.info(f"[EPORNER_DISCOVERY] Mode: TAG | Tag: '{tag_slug}'")
    else:
        search_slug = clean_keyword.replace(' ', '+')
        base_url = f"https://www.eporner.com/search/{search_slug}/"
        logging.info(f"[EPORNER_DISCOVERY] Mode: SEARCH | Query: '{clean_keyword}'")
    
    logging.info(f"[EPORNER_DISCOVERY] Starting scrape (min_quality={min_quality}p, pages={pages})")
    
    for page_num in range(1, pages + 1):
        try:
            # Construct page URL
            if is_tag_mode:
                page_url = f"{base_url}?p={page_num}" if page_num > 1 else base_url
            else:
                page_url = f"{base_url}{page_num}/" if page_num > 1 else base_url
            
            logging.info(f"[EPORNER_DISCOVERY] Fetching page {page_num}: {page_url}")
            
            # FAST MODE: No delays, maximum speed
            resp = requests.get(page_url, headers=headers, timeout=15)
            
            if resp.status_code != 200:
                logging.error(f"[EPORNER_DISCOVERY] Page {page_num} returned status {resp.status_code}")
                continue
            
            soup = BeautifulSoup(resp.text, 'html.parser')
            
            # Find all video containers
            # Eporner uses div.mb with data-id attribute for each video
            video_containers = soup.find_all('div', class_='mb')
            
            if not video_containers:
                logging.warning(f"[EPORNER_DISCOVERY] No videos found on page {page_num}")
                continue
            
            logging.info(f"[EPORNER_DISCOVERY] Found {len(video_containers)} videos on page {page_num}")
            
            for container in video_containers:
                try:
                    # Extract video page URL
                    link_tag = container.find('a', href=True)
                    if not link_tag:
                        continue
                    
                    video_url = link_tag['href']
                    if not video_url.startswith('http'):
                        video_url = f"https://www.eporner.com{video_url}"
                    
                    # Extract title - try multiple methods
                    title = None
                    
                    # Method 1: Look for title in link tag
                    if link_tag.get('title'):
                        title = link_tag.get('title').strip()
                    
                    # Method 2: Look for title div/span (mbtit or mbt)
                    if not title or title == '':
                        # Search for mbtit OR mbt classes
                        title_tag = container.find('div', class_=re.compile(r'mbt(it)?'))
                        if title_tag:
                            title = title_tag.get_text().strip()
                    
                    # Method 3: Look in any h3, h4, or strong tag
                    if not title or title == '':
                        for tag_name in ['h3', 'h4', 'strong', 'b']:
                            title_tag = container.find(tag_name)
                            if title_tag and title_tag.get_text().strip():
                                title = title_tag.get_text().strip()
                                break
                    
                    # Method 4: Extract from URL slug
                    if not title or title == '' or title == 'Unknown' or title.lower() == 'https':
                        # Extract title from URL like /video-xxxxx/title-here/
                        try:
                            # Remove protocol and domain
                            url_path = video_url.replace('https://', '').replace('http://', '')
                            if '/' in url_path:
                                url_path = '/' + '/'.join(url_path.split('/')[1:])  # Remove domain
                            
                            url_parts = url_path.split('/')
                            for part in url_parts:
                                # Skip empty, 'video-xxxxx', domain parts, and short parts
                                if part and not part.startswith('video-') and 'eporner.com' not in part and len(part) > 5:
                                    title = part.replace('-', ' ').replace('_', ' ').title()
                                    break
                        except:
                            pass
                    
                    # Fallback
                    if not title or title == '' or title.lower() == 'https':
                        title = 'Eporner Video'
                    
                    # Extract thumbnail (lazy-loaded via data-src)
                    img_tag = container.find('img')
                    thumbnail = None
                    if img_tag:
                        thumbnail = img_tag.get('data-src') or img_tag.get('src')
                        if thumbnail and not thumbnail.startswith('http'):
                            thumbnail = f"https:{thumbnail}" if thumbnail.startswith('//') else f"https://www.eporner.com{thumbnail}"
                    
                    # Extract duration - try multiple methods
                    duration_seconds = 0
                    duration_str = None
                    
                    # Method 1: Look for duration div/span
                    duration_tag = container.find('div', class_='mbtim')
                    if not duration_tag:
                        duration_tag = container.find('span', class_='dur')
                    if not duration_tag:
                        duration_tag = container.find('div', class_='duration')
                    if not duration_tag:
                        duration_tag = container.find('span', class_='duration')
                    
                    if duration_tag:
                        duration_str = duration_tag.text.strip()
                    
                    # Method 2: Search for time pattern in container text
                    if not duration_str:
                        container_text = container.get_text()
                        # Look for patterns like "12:34" or "1:23:45"
                        time_match = re.search(r'(\d{1,2}):(\d{2})(?::(\d{2}))?', container_text)
                        if time_match:
                            duration_str = time_match.group(0)
                    
                    # Parse duration string
                    if duration_str:
                        try:
                            # Parse MM:SS or HH:MM:SS
                            parts = duration_str.split(':')
                            if len(parts) == 3:  # HH:MM:SS
                                duration_seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                            elif len(parts) == 2:  # MM:SS
                                duration_seconds = int(parts[0]) * 60 + int(parts[1])
                        except:
                            pass
                    
                    # Extract quality label - try multiple methods with debug logging
                    quality_str = 'SD'
                    quality_tag = None
                    resolution = 480  # Default SD
                    
                    # Method 1: Look for quality badge/label with various class names
                    quality_tag = container.find('div', class_='mbqual')
                    if not quality_tag:
                        quality_tag = container.find('span', class_='hd')
                    if not quality_tag:
                        quality_tag = container.find('div', class_='hd')
                    if not quality_tag:
                        quality_tag = container.find('span', class_='quality')
                    if not quality_tag:
                        quality_tag = container.find('div', class_='quality')
                    
                    if quality_tag:
                        quality_str = quality_tag.get_text().strip()
                        logging.debug(f"[EPORNER_DISCOVERY] Found quality tag: '{quality_str}'")
                    else:
                        # Method 2: Search entire container HTML for quality indicators
                        container_html = str(container).upper()
                        
                        # Look for quality in HTML attributes or text
                        if '4K' in container_html or '2160P' in container_html:
                            quality_str = '4K'
                            resolution = 2160
                        elif '1440P' in container_html or '2K' in container_html:
                            quality_str = '1440p'
                            resolution = 1440
                        elif '1080P' in container_html or 'FHD' in container_html:
                            quality_str = '1080p'
                            resolution = 1080
                        elif '720P' in container_html or 'HD' in container_html:
                            quality_str = '720p'
                            resolution = 720
                        
                        logging.debug(f"[EPORNER_DISCOVERY] No quality tag, inferred from HTML: '{quality_str}' ({resolution}p)")
                    
                    # Parse quality string to resolution if not already set
                    if resolution == 480 and quality_str != 'SD':
                        if '4K' in quality_str.upper() or '2160' in quality_str:
                            resolution = 2160
                        elif '1440' in quality_str or '2K' in quality_str.upper():
                            resolution = 1440
                        elif '1080' in quality_str or 'FHD' in quality_str.upper():
                            resolution = 1080
                        elif '720' in quality_str or 'HD' in quality_str.upper():
                            resolution = 720
                    
                    # Extract upload date (if available)
                    upload_date = None
                    date_tag = container.find('div', class_='mbdate')
                    if not date_tag:
                        date_tag = container.find('span', class_='date')
                    if not date_tag:
                        date_tag = container.find('div', class_='added')
                    if not date_tag:
                        # Try to find date in container text (e.g., "Added: 2 days ago", "1 week ago")
                        container_text = container.get_text()
                        date_patterns = [
                            r'(\d+)\s*(day|days|week|weeks|month|months|year|years)\s*ago',
                            r'Added:\s*(.+?)(?:\n|$)',
                            r'(\d{4}-\d{2}-\d{2})',  # YYYY-MM-DD
                            r'(\d{1,2}/\d{1,2}/\d{4})'  # MM/DD/YYYY
                        ]
                        for pattern in date_patterns:
                            match = re.search(pattern, container_text, re.IGNORECASE)
                            if match:
                                upload_date = match.group(0).strip()
                                break
                    else:
                        upload_date = date_tag.text.strip()
                    
                    # Extract rating and views (if available)
                    rating = None
                    views = None
                    rating_tag = container.find('div', class_='mbrate')
                    if rating_tag:
                        rating_text = rating_tag.text.strip()
                        try:
                            rating = int(re.search(r'(\d+)%', rating_text).group(1))
                        except:
                            pass
                    
                    views_tag = container.find('div', class_='mbvie')
                    if views_tag:
                        views_text = views_tag.text.strip()
                        try:
                            # Parse "1.2M" or "500K" format
                            if 'M' in views_text:
                                views = int(float(views_text.replace('M', '').strip()) * 1000000)
                            elif 'K' in views_text:
                                views = int(float(views_text.replace('K', '').strip()) * 1000)
                            else:
                                views = int(re.sub(r'[^\d]', '', views_text))
                        except:
                            pass
                    
                    # Determine if video matches quality filter
                    matched = resolution >= min_quality
                    
                    # Skip if auto_skip is enabled AND video doesn't match
                    if auto_skip_low_quality and not matched:
                        logging.debug(f"[EPORNER_DISCOVERY] Skipping '{title}' ({resolution}p < {min_quality}p)")
                        continue
                    
                    video_data = {
                        'title': title,
                        'url': video_url,
                        'source_url': video_url,
                        'thumbnail': thumbnail,
                        'duration': duration_seconds,
                        'quality': quality_str,
                        'resolution': resolution,
                        'rating': rating,
                        'views': views,
                        'upload_date': upload_date,
                        'origin_keyword': keyword,
                        'matched': matched
                    }
                    
                    results.append(video_data)
                    
                    # Debug: Log first video from each page
                    if len(results) == 1 or (len(results) - 1) % 100 == 0:
                        logging.info(f"[EPORNER_DISCOVERY] Sample: '{title}' | Duration: {duration_seconds}s | Quality: {quality_str} ({resolution}p) | Matched: {matched}")
                    
                    
                except Exception as e:
                    logging.error(f"[EPORNER_DISCOVERY] Error parsing video container: {e}")
                    continue
            
        except Exception as e:
            logging.error(f"[EPORNER_DISCOVERY] Error fetching page {page_num}: {e}")
            continue
    
    # Remove duplicates based on URL
    unique_results = []
    seen_urls = set()
    
    for video in results:
        if video['url'] not in seen_urls:
            seen_urls.add(video['url'])
            unique_results.append(video)
            
    matched_count = sum(1 for v in unique_results if v.get('matched', False))
    logging.info(f"[EPORNER_DISCOVERY] Scrape complete: {matched_count}/{len(unique_results)} unique videos matched quality filter")
    
    return unique_results

# --- Konfigurácia ---

THUMB_DIR = "app/static/thumbnails"
PREVIEW_DIR = "app/static/previews"
SUBTITLE_DIR = "app/static/subtitles"
os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)
os.makedirs(SUBTITLE_DIR, exist_ok=True)

# Auto-install/setup ffmpeg paths
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
    logging.info("static-ffmpeg paths added.")
except ImportError:
    logging.warning("static-ffmpeg not installed, relying on system PATH.")

# FFMPEG is missing from local dir, assuming system PATH
FFMPEG_CMD = 'ffmpeg'
FFPROBE_CMD = 'ffprobe'

# Only warn if system command fails basic check
if not shutil.which(FFMPEG_CMD):
    logging.warning(f"CRITICAL WARNING: ffmpeg not found in system PATH.")

FFMPEG_NETWORK_ARGS = [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-timeout', '20000000', '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
]

NLP = None
try:
    import spacy
except (ImportError, OSError) as e:
    logging.warning("spaCy unavailable (AI noun tags disabled): %s", e)
else:
    try:
        NLP = spacy.load('en_core_web_sm')
    except OSError:
        NLP = None

# --- Helper Functions ---

def calculate_aspect_ratio(width: int, height: int) -> Optional[str]:
    """
    Calculate aspect ratio from video dimensions.

    Args:
        width: Video width in pixels
        height: Video height in pixels

    Returns:
        Aspect ratio string (e.g., "16:9", "9:16") or None if invalid dimensions
    """
    if not width or not height or width <= 0 or height <= 0:
        return None

    ratio = width / height

    # Common aspect ratios with tolerance ranges
    # Landscape ratios
    if 2.3 <= ratio <= 2.5:
        return "21:9"  # Ultra-wide
    elif 1.85 <= ratio <= 1.95:
        return "2:1"  # Univisium
    elif 1.7 <= ratio <= 1.8:
        return "16:9"  # HD Standard
    elif 1.55 <= ratio <= 1.68:
        return "5:3"  # Common video
    elif 1.3 <= ratio <= 1.35:
        return "4:3"  # SD Standard

    # Portrait ratios (vertical)
    elif 0.55 <= ratio <= 0.58:
        return "9:16"  # Vertical HD (TikTok, Stories)
    elif 0.52 <= ratio <= 0.54:
        return "9:19.5"  # Full-screen mobile
    elif 0.73 <= ratio <= 0.78:
        return "3:4"  # Vertical SD

    # Square
    elif 0.95 <= ratio <= 1.05:
        return "1:1"  # Square (Instagram)

    # If doesn't match common ratios, return calculated ratio
    from math import gcd
    divisor = gcd(width, height)
    return f"{width // divisor}:{height // divisor}"

# --- Hlavná trieda ---

class VIPVideoProcessor:
    _webshare_lock = threading.Lock()
    async def _broadcast_status(self, video_id: int, status: str, extra_data: dict = None):
        message = {"type": "status_update", "video_id": video_id, "status": status}
        if extra_data:
            message.update(extra_data)
        await manager.broadcast(json.dumps(message))

    def log_sync(self, message: str, level: str = "info"):
        """A synchronous helper to call the async manager.log"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # 'RuntimeError: There is no current event loop...'
            loop = None

        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.log(message, level), loop)
        else:
            asyncio.run(manager.log(message, level))

    def broadcast_sync(self, video_id: int, status: str, extra_data: dict = None):
        """Robust broadast helper that handles event loops safely"""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(self._broadcast_status(video_id, status, extra_data), loop)
            else:
                loop.run_until_complete(self._broadcast_status(video_id, status, extra_data))
        except:
            # Fallback for background threads
            try:
                new_loop = asyncio.new_event_loop()
                new_loop.run_until_complete(self._broadcast_status(video_id, status, extra_data))
                new_loop.close()
            except: pass

    def broadcast_new_video(self, video):
        """Broadcasts a newly created video to the frontend."""
        data = {
            "type": "new_video",
            "video": {
                "id": video.id,
                "title": video.title,
                "url": video.url,
                "thumbnail_path": video.thumbnail_path or "/static/placeholder.jpg",
                "duration": video.duration or 0,
                "status": video.status,
                "batch_name": video.batch_name,
                "storage_type": video.storage_type or "remote",
                "created_at": video.created_at.isoformat() if video.created_at else None,
                "tags": video.tags or "",
                "ai_tags": video.ai_tags or "",
                "height": video.height or 0,
                "resume_time": video.resume_time or 0
            }
        }
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(manager.broadcast(json.dumps(data)), loop)
            else:
                loop.run_until_complete(manager.broadcast(json.dumps(data)))
        except:
            try:
                new_loop = asyncio.new_event_loop()
                new_loop.run_until_complete(manager.broadcast(json.dumps(data)))
                new_loop.close()
            except: pass

    def process_batch(self, video_ids: list[int]):
        """
        Process multiple videos with a concurrency limit (Fix 2).
        """
        max_workers = 4
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            executor.map(self.process_single_video, video_ids)

    def process_single_video(self, video_id, force=False, quality_mode="mp4", extractor="auto"):
        import time # Ensuring 'time' is always available locally to avoid UnboundLocalError
        self.log_sync(f"VIPVideoProcessor: Processing ID {video_id}...", "working")
        db = SessionLocal()
        try:
            video = db.query(Video).get(video_id)
            if not video: return

            # Skip processing for VK videos that were already processed during import
            if video.status == 'ready_to_stream' and video.source_url and any(d in video.source_url for d in ['vk.com', 'vk.video', 'vkvideo.ru']):
                logging.info(f"VK video {video_id} already processed during import, skipping")
                db.close()
                return

            thumb_exists = video.thumbnail_path and os.path.exists(f"app{video.thumbnail_path}")
            if not force and video.status == 'ready' and thumb_exists:
                db.close(); return

            # Improved direct file detection (ignoring query params)
            parsed_url = urllib.parse.urlparse(video.url.lower())
            is_direct_file = any(parsed_url.path.endswith(ext) for ext in ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8'])
            
            is_pixeldrain = "pixeldrain.com" in video.url
            is_bunkr = "bunkr" in video.url or (video.source_url and "bunkr" in video.source_url)
            is_gofile = "gofile.io" in video.url or (video.source_url and "gofile.io" in video.source_url)
            
            # Use source_url for domain checks to ensure they work on "Regenerate" too
            search_url = video.source_url if video.source_url else video.url
            is_xvideos = "xvideos.com" in search_url
            is_xhamster = "xhamster.com" in search_url
            is_bunkr = "bunkr" in search_url or "scdn.st" in search_url
            is_gofile = "gofile.io" in search_url
            is_webshare = "webshare.cz" in search_url or "wsfiles.cz" in search_url or search_url.startswith("webshare:")
            _cw_match = re.search(r"/videos/(\d+)", f"{video.source_url or ''} {video.url or ''}", re.I)
            cw_corr = f"cw:{_cw_match.group(1)}" if _cw_match else "cw:unknown"
            if "camwhores" in (video.url or "").lower() or "camwhores" in (video.source_url or "").lower():
                logging.info(
                    "[CW_PROCESS][%s] start video_id=%s url=%s source=%s status=%s",
                    cw_corr,
                    video_id,
                    (video.url or "")[:120],
                    (video.source_url or "")[:120],
                    video.status,
                )

            # Camwhores: bulk/extension often sets source_url to search HTML — scraping needs the /videos/… watch URL.
            if video.url and "camwhores.tv" in video.url.lower() and "/videos/" in video.url.lower():
                search_url = video.url
                su_low = (video.source_url or "").lower()
                if "camwhores.tv/videos/" not in su_low:
                    video.source_url = video.url
                    db.commit()

            video.status = "processing"
            video.storage_type = "remote" # Default on import
            db.commit()
            self.broadcast_sync(video_id, "processing")


                        

            stream_url = video.url
            # Watch-page URLs are not playable streams; do not skip yt-dlp / generic scrapers.
            _vurl = (stream_url or "").lower()
            if "camwhores.tv" in _vurl and "/videos/" in _vurl and "get_file" not in _vurl:
                stream_url = None

            meta = {}
            yt_id = None
            pd_id = None
            
            # --- PLUGIN SYSTEM (NEW) ---
            from app.extractors.registry import ExtractorRegistry
            from app.extractors import init_registry, register_extended_extractors

            init_registry()
            register_extended_extractors()

            # Try to find a dedicated plugin first
            plugin = ExtractorRegistry.find_extractor(search_url)
            if plugin and extractor == 'auto':
                logging.info(f"Using Plugin: {plugin.name} for {search_url}")
                try:
                    def _is_playable_stream_url(u: str) -> bool:
                        if not u or not isinstance(u, str):
                            return False
                        ul = u.lower()
                        return (
                            ul.startswith(("http://", "https://")) and
                            (
                                bool(re.search(r"\.(mp4|m3u8|mpd)(\?|$)", ul)) or
                                "/api/v1/proxy/hls?url=" in ul or
                                "/hls_proxy?url=" in ul
                            )
                        )

                    def _normalize_thumbnail_value(value):
                        # Some extractors return thumbnailUrl as list/dict from JSON-LD.
                        if isinstance(value, list):
                            return str(value[0]).strip() if value else ""
                        if isinstance(value, dict):
                            return str(value.get("url") or value.get("src") or "").strip()
                        return str(value or "").strip()

                    # Run async plugin in this thread
                    res = asyncio.run(plugin.extract(search_url))
                    if res:
                        pl_stream = res.get("stream_url")
                        current_stream = (video.url or "").strip()
                        # Prevent regressions where a resolved direct stream gets overwritten
                        # by an embed/player URL (observed on PornHoarder player.php).
                        if pl_stream and (_is_playable_stream_url(pl_stream) or not _is_playable_stream_url(current_stream)):
                            video.url = pl_stream
                            stream_url = pl_stream
                        else:
                            stream_url = current_stream
                        meta['title'] = res.get('title') or meta.get('title')
                        meta['description'] = res.get('description')
                        thumb = _normalize_thumbnail_value(res.get('thumbnail'))
                        if thumb:
                            meta['thumbnail_url'] = thumb
                        meta['duration'] = res.get('duration')
                        meta['width'] = res.get('width')
                        meta['height'] = res.get('height')
                        if res.get('tags'): meta['tags'] = ",".join(res['tags'])
                        if res.get('views'): meta['views'] = res.get('views')
                        if res.get('upload_date'): meta['upload_date'] = res.get('upload_date')
                        if res.get('size_bytes'): meta['size_bytes'] = res.get('size_bytes')
                        
                        if pl_stream:
                            self.log_sync(f"Plugin {plugin.name} success for {video_id}", "success")
                except Exception as e:
                     logging.error(f"Plugin {plugin.name} failed: {e}")
                     # Fallthrough to legacy methods if plugin crashes?
            
            # --- LEGACY EXTRACTORS (To be migrated) ---
            
            # 1. Bunkr Scraper (Playwright)
            if is_bunkr and extractor == 'auto' and not is_direct_file and not stream_url:
                try:
                    # Try the new plugin first for better reliability
                    plugin = ExtractorRegistry.find_extractor(video.url if not is_direct_file else search_url)
                    if plugin and plugin.name == "Bunkr":
                        logging.info(f"Using new Bunkr plugin for {video_id}")
                        res = asyncio.run(plugin.extract(search_url or video.url))
                        if res:
                            stream_url = res.get('stream_url')
                            video.url = stream_url
                            if not video.source_url:
                                video.source_url = search_url or video.url
                            meta.update({
                                'title': res.get('title'),
                                'thumbnail_url': res.get('thumbnail'),
                                'description': res.get('description')
                            })
                            # No intermediate commit — will be committed at end of processing
                        else:
                            # Fallback to legacy if plugin fails
                            raise Exception("New Bunkr extractor failed, falling back")
                    else:
                        be = BunkrExtractor()
                    # Preserve original Bunkr page URL as source_url for referrer headers
                    original_bunkr_url = video.url
                    
                    if "/a/" in video.url or "/album/" in video.url:
                        # For albums, we pick the first video to represent it for now
                        files = asyncio.run(be.extract_album(video.url))
                        if files:
                            f = files[0]
                            cdn = f['cdn']
                            if cdn.startswith("//"):  cdn = "https:" + cdn
                            stream_url = f"{cdn}/{f['name']}"
                            meta['title'] = f.get('name', video.title)
                            if f.get('thumb'): meta['thumbnail_url'] = f['thumb']
                            # Update video URL to the direct stream link
                            video.url = stream_url
                            if not video.source_url:
                                video.source_url = original_bunkr_url
                            # No intermediate commit — committed at end
                    else:
                         # For individual files (/f/ URLs)
                         direct_link = asyncio.run(be.extract_file(video.url))
                         if direct_link:
                             stream_url = direct_link
                             video.url = stream_url
                             # CRITICAL: Preserve original Bunkr page URL for referrer
                             if not video.source_url:
                                 video.source_url = original_bunkr_url
                             # No intermediate commit — committed at end
                             logging.info(f"Bunkr file extracted: {original_bunkr_url} -> {stream_url}")
                except Exception as e:
                    logging.error(f"Bunkr extraction failed: {e}")


            # 2. Gofile Scraper
            if is_gofile and extractor == 'auto' and not is_direct_file and not stream_url:
                try:
                    ge = GoFileExtractor()
                    content_id = video.url.split('/')[-1] if '/d/' in video.url else None
                    if content_id:
                        files = ge.get_content(content_id)
                        if files:
                            target_file = next((f for f in files if f['mimetype'].startswith('video')), files[0])
                            stream_url = target_file['link']
                            meta['title'] = target_file['name']
                            if target_file.get('thumbnail'): meta['thumbnail_url'] = target_file['thumbnail']
                            # Update video URL — no intermediate commit
                            video.url = stream_url
                except Exception as e:
                    logging.error(f"Gofile extraction failed: {e}")

            # 3. Webshare VIP Resolver
            if is_webshare:
                try:
                    from extractors.webshare import WebshareAPI
                    ws = WebshareAPI() # Will load token from env

                    ident = None
                    original_webshare_url = video.source_url or video.url
                    # Case 1: Internal format from a previous Webshare search
                    if video.url.startswith("webshare:"):
                        ident = video.url.split(":", 2)[1]
                    # Case 2: A raw webshare.cz URL was imported
                    elif video.source_url and "/file/" in video.source_url:
                        # Handle both /file/ident and /#/file/ident
                        part = video.source_url.split('/file/')[1]
                        ident = part.split('/')[0] if '/' in part else part
                    
                    # Case 3: A direct wsfiles.cz link was imported
                    if not ident and 'wsfiles.cz' in (video.source_url or ""):
                        # Extract ident from CDN path: ...wsfiles.cz/STORAGE_ID/IDENT/...
                        path_parts = video.source_url.split('/')
                        for p in path_parts:
                            if len(p) == 10 and p.isalnum() and not p.isdigit():
                                ident = p
                                break

                    if ident:
                        # Webshare is sensitive to concurrent sessions. Serialize and retry a few times.
                        real_url = None
                        with VIPVideoProcessor._webshare_lock:
                            for attempt in range(1, 4):
                                real_url = ws.get_vip_link(ident)
                                if real_url:
                                    break
                                time.sleep(2 * attempt)

                        if real_url:
                            logging.info(f"Webshare VIP Link Resolved for video {video_id}: {real_url}")
                            stream_url = real_url
                            video.url = real_url # Update to direct, processable link
                            # Defer commit — will run at end of processing

                            # Attempt to grab technical metadata and thumbnail via API
                            file_info = ws.get_file_info(ident)
                            if file_info:
                                if file_info.get('thumbnail'):
                                    meta['thumbnail_url'] = file_info['thumbnail']
                                if file_info.get('duration'):
                                    meta['duration'] = file_info['duration']
                                if file_info.get('width'):
                                    meta['width'] = file_info['width']
                                if file_info.get('height'):
                                    meta['height'] = file_info['height']
                                if file_info.get('name'):
                                    meta['title'] = file_info['name']
                                if file_info.get('size_bytes'):
                                    meta['size_bytes'] = file_info['size_bytes']
                                    # If size is missing from download_stats, populate it now
                                    stats = video.download_stats or {}
                                    if not stats.get('size_mb') and not stats.get('reported_size_bytes'):
                                        stats['reported_size_bytes'] = file_info['size_bytes']
                                        video.download_stats = stats
                                        from sqlalchemy.orm.attributes import flag_modified
                                        flag_modified(video, "download_stats")
                            logging.info(f"Webshare metadata resolved via API for video {video_id}: {meta}")
                            
                            # Fallback thumbnail scrape if still missing
                            if not meta.get('thumbnail_url'):
                                thumb = self._fetch_webshare_thumbnail(ident, original=original_webshare_url)
                                if thumb:
                                    meta['thumbnail_url'] = thumb
                                    logging.info(f"Webshare thumbnail resolved via page scrape for video {video_id}")
                        else:
                            # If we can't get a VIP link, we cannot stream or thumbnail.
                            raise Exception("Could not resolve Webshare VIP link (token missing/expired or Webshare limit hit).")
                    # If we have a 'free' link, we need an ident to try and get a VIP one. If no ident, we can't proceed.
                    elif 'wsfiles.cz' in video.url and not ident:
                        raise Exception("Webshare 'free' link detected without a usable file 'ident' in source_url. Cannot upgrade to VIP link.")

                except Exception as e:
                    # Catch the exception raised above or any other error
                    logging.error(f"Webshare processing failed for video {video_id}: {e}")
                    video.status = "error"
                    video.error_msg = str(e)
                    db.commit()
                    self.broadcast_sync(video_id, "error", {"error": str(e)})
                    db.close() # Close session
                    return   # STOP PROCESSING THIS VIDEO

            # 4. Pixeldrain Scraper (Direct & Generic)
            # CRITICAL: Always run for Pixeldrain to convert user URLs to API URLs
            if (is_pixeldrain or "pixeldrain.com" in video.url) and extractor == 'auto':
                try:
                    pe = PixeldrainExtractor()
                    # It handles full URL now
                    info = pe.get_file_info(video.url)
                    if info:
                        stream_url = info['link']
                        meta['title'] = info['name']
                        if info.get('thumbnail'): meta['thumbnail_url'] = info.get('thumbnail')
                        # Update video URL to the direct stream API link which is streamable
                        # But keep source_url intact
                        video.url = stream_url 
                        logging.info(f"Pixeldrain API URL resolved for video {video_id}: {stream_url}")
                        
                except Exception as e:
                    logging.error(f"Pixeldrain extraction failed: {e}")

            
            # --- METADATA EXTRACTION (Legacy Blocks removed for migrated plugins) ---
                       
            # 1.1 Custom Scraper for XHAMSTER (To migrate next)
            if is_xhamster and extractor == 'auto' and not stream_url:
                xh_meta, xh_stream_url = self._fetch_xhamster_meta(search_url)
                if xh_stream_url:
                    stream_url = xh_stream_url
                    video.url = xh_stream_url
                    meta.update(xh_meta)
                    self.log_sync(f"xHamster scraper success for {video_id}", "success")

            # 1.5 Generic Scraper
            if not is_direct_file and not stream_url and extractor == 'auto':
                logging.info(f"Running generic scraper for {video.url}")
                scraped_meta, scraped_stream_url = asyncio.run(self._scrape_generic_video_page(video.url))
                if scraped_stream_url:
                    stream_url = scraped_stream_url
                    video.url = scraped_stream_url  # Update URL to the direct stream
                    meta.update(scraped_meta)
                    self.log_sync(f"Generic scraper success for {video_id}, found stream: {stream_url}", "success")

            # 2. Pixeldrain API
            pd_id_match = re.search(r'/(?:u|l|file)/([a-zA-Z0-9]+)', video.url)
            if is_pixeldrain and pd_id_match:
                pd_id = pd_id_match.group(1)
                pd_info = self._fetch_pixeldrain_info_api(pd_id)
                if pd_info and pd_info.get("name"):
                    meta['title'] = pd_info['name']

            # 3. Generic Fallback (yt-dlp)
            # Trigger if title is missing OR if technical metadata (duration or height) is missing/low
            # For XVideos in particular, we want to try deep extraction if initial scraper got low quality
            needs_better_meta = not (meta.get('duration') and meta.get('height') and meta.get('height') >= 720)
            if (not meta.get('title') or needs_better_meta) and not stream_url:
                should_run_ytdlp = False
                if extractor == "yt-dlp": should_run_ytdlp = True
                elif extractor == "auto" and not is_pixeldrain and not is_direct_file: should_run_ytdlp = True

                if should_run_ytdlp:
                    try:
                        # For XVideos/XHamster, we MUST set extract_flat=False to get format/HLS info properly
                        ytdlp_opts = {
                            'quiet': True, 'ignoreerrors': True, 'no_warnings': True,
                            'format': 'bestvideo+bestaudio/best',
                            'extract_flat': False if (is_xvideos or is_xhamster) else True
                        }
                        info_id = yt_dlp.YoutubeDL(ytdlp_opts).extract_info(search_url, download=False)
                        yt_id = info_id.get('id') if info_id else None
                        
                        dlp_meta, fetched_stream_url = self._fetch_metadata(search_url, yt_id, quality_mode)
                        
                        if fetched_stream_url and not meta.get('stream_url'):
                            stream_url = fetched_stream_url
                        
                        meta.update(dlp_meta)

                    except Exception as e: logging.warning(f"yt-dlp failed: {e}")
            
            # 3. FFprobe
            if (not meta.get('duration') or not meta.get('height') or extractor == "ffprobe") and stream_url:
                extraction_referer = search_url
                if "camwhores" in (search_url or ""):
                    extraction_referer = (
                        video.source_url
                        if (video.source_url and "camwhores.tv/videos/" in video.source_url)
                        else "https://www.camwhores.tv/"
                    )
                elif "erome.com" in (search_url or ""):
                    extraction_referer = "https://www.erome.com/"
                elif is_bunkr:
                    # Bunkr CDN requires Referer from a bunkr.* domain root, NOT scdn.st or CDN itself
                    extraction_referer = self._bunkr_cdn_referer(video.source_url or stream_url)

                meta = self._ffprobe_fallback(stream_url, meta, referer=extraction_referer)

            # 4. Názov a Tagy
            new_title = meta.get('title')
            # Filter out generic titles
            if new_title and not any(x in new_title.lower() for x in ["hls", "index", "m3u8", "video", "queued"]):
                video.title = new_title
            
            if not video.title or len(video.title) < 4:
                 path_title = self._extract_title_from_url(search_url)
                 video.title = path_title if path_title else f"Video #{video_id}"

            # Keep duration provided by extension import when already present.
            # Some providers return noisy/blocked metadata during processing, which can
            # otherwise overwrite a correct imported duration with 0 or bogus values.
            existing_duration = float(video.duration or 0)
            meta_duration = float(meta.get('duration') or 0)
            video.duration = existing_duration if existing_duration > 0 else meta_duration
            video.width = meta.get('width') or 0
            video.height = meta.get('height') or 0
            if meta.get('views') is not None: video.views = meta.get('views')
            if meta.get('upload_date'): video.upload_date = meta.get('upload_date')
            video.aspect_ratio = calculate_aspect_ratio(video.width, video.height)

            if not video.tags: video.tags = meta.get('tags') or self._generate_smart_tags(video.title)
            video.ai_tags = self._generate_ai_tags(video.title, meta.get('description', ''))
            
            if not is_direct_file and yt_id:
                video.subtitle = self._read_and_clean_vtt(yt_id)

            # 5. Vizuály
            # TODO: Add Watermark Detector (detect text overlays in thumbnails/frames)
            # TODO: Add Classification System (auto-tag "solo", "BJ", "facial" from metadata/frames)
            visuals_ok = False
            # Use scraper thumbnail if available — download asynchronously with httpx
            if meta.get('thumbnail_url'):
                try:
                    dl_headers = {'User-Agent': 'Mozilla/5.0'}
                    if is_bunkr:
                        dl_headers['Referer'] = self._bunkr_cdn_referer(video.source_url or video.url)
                    elif video.url:
                        dl_headers['Referer'] = video.url

                    async def _dl_thumb():
                        async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
                            r = await client.get(meta['thumbnail_url'], headers=dl_headers)
                            return r.status_code, r.content

                    th_status, th_content = asyncio.run(_dl_thumb())
                    if th_status == 200:
                        thumb_path = os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg")
                        with open(thumb_path, 'wb') as f:
                            f.write(th_content)
                        visuals_ok = True
                except Exception as e:
                    logging.error(f"Failed to download thumbnail from URL {meta['thumbnail_url']}: {e}")

            if not visuals_ok and is_pixeldrain and pd_id and extractor == "auto":
                if self._download_pixeldrain_thumbnail(video_id, pd_id): visuals_ok = True
            
            if not visuals_ok and stream_url:
                # Determine best referer for extraction
                current_referer = video.source_url if video.source_url else video.url
                
                if "camwhores" in video.url or "camwhores" in (video.source_url or ""):
                     current_referer = (
                         video.source_url
                         if (video.source_url and "camwhores.tv/videos/" in video.source_url)
                         else "https://www.camwhores.tv/"
                     )
                elif "erome.com" in video.url or "erome.com" in (video.source_url or ""):
                     current_referer = "https://www.erome.com/"
                elif "eporner.com" in (video.source_url or ""):
                     current_referer = video.source_url
                elif "webshare" in video.url or "webshare.cz" in (video.source_url or ""):
                     current_referer = None
                elif "pornone.com" in (video.source_url or ""):
                     current_referer = video.source_url if video.source_url else "https://www.pornone.com/"
                elif is_bunkr:
                    current_referer = self._bunkr_cdn_referer(video.source_url or stream_url)

                # For Webshare, if we haven't found a thumbnail by now, we will not use ffmpeg.
                is_webshare_link = self._is_webshare_host(stream_url) or \
                                   (video.source_url and self._is_webshare_host(video.source_url))

                if is_webshare_link:
                    is_free_link = "free" in stream_url.lower()
                    if is_free_link:
                         logging.warning(f"Could not resolve thumbnail for Webshare FREE video {video_id} via API or scrape. Skipping ffmpeg.")
                         visuals_ok = True 
                    else:
                         logging.info(f"Webshare VIP link detected, proceeding with FFmpeg fallback for {video_id}")
                         asyncio.run(manager.log(f"Generating FFmpeg thumbnail for {video_id}...", "working"))
                         self._generate_visuals(stream_url, video_id, video.duration, referer=current_referer)
                else:
                    try:
                        asyncio.run(manager.log(f"Generating FFmpeg thumbnail for {video_id}...", "working"))
                        self._generate_visuals(stream_url, video_id, video.duration, referer=current_referer)
                    except Exception as e: 
                         logging.error(f"Visuals gen failed for {video_id}: {e}")
                         self.log_sync(f"FFmpeg error for {video_id}: {e}", "error")

                if os.path.exists(os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg")):
                    visuals_ok = True
                    self.log_sync(f"Thumbnail created for {video_id}", "success")
                else:
                    self.log_sync(f"Thumbnail generation failed (no output) for {video_id}", "warning")

            if os.path.exists(os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg")):
                # Add timestamp to force browser cache refresh
                video.thumbnail_path = f"/static/thumbnails/thumb_{video_id}.jpg?t={int(time.time())}"
            
            gif_preview_path = os.path.join(THUMB_DIR, f"thumb_{video_id}.gif")
            if os.path.exists(gif_preview_path):
                video.gif_preview_path = f"/static/thumbnails/thumb_{video_id}.gif"

            video.preview_path = f"/static/previews/{video_id}"
            video.status = "ready_to_stream"
            video.error_msg = None
            
            # Auto-fetch file size if missing
            try:
                if meta.get('size_bytes'):
                    stats = video.download_stats or {}
                    if not stats.get('reported_size_bytes'):
                        stats['reported_size_bytes'] = meta['size_bytes']
                        video.download_stats = stats
                        from sqlalchemy.orm.attributes import flag_modified
                        flag_modified(video, "download_stats")
                self.fetch_and_update_video_size(video_id, db=db)
            except Exception as e:
                logging.debug(f"Size auto-fetch failed for {video_id}: {e}")

            db.commit()
            if "camwhores" in (video.url or "").lower() or "camwhores" in (video.source_url or "").lower():
                logging.info(
                    "[CW_PROCESS][%s] done video_id=%s duration=%s height=%s source=%s",
                    cw_corr,
                    video_id,
                    int(video.duration or 0),
                    int(video.height or 0),
                    (video.source_url or "")[:120],
                )

            # Broadcast READY status with final data
            this_stats = video.download_stats
            self.broadcast_sync(video_id, "ready_to_stream", {
                "title": video.title,
                "thumbnail_path": video.thumbnail_path,
                "storage_type": video.storage_type,
                "duration": video.duration,
                "height": video.height,
                "download_stats": this_stats
            })

        except Exception as e:
            logging.error(f"Error processing video {video_id}: {e}")
            video.status = "error"
            video.error_msg = str(e)
            db.commit()
            # Broadcast ERROR status
            self.log_sync(f"Error processing video {video_id}: {e}", "error")
            self.broadcast_sync(video_id, "error", {"error": str(e)})
        finally: 
            db.close()

    # --- POMOCNÉ METÓDY ---

    def _fetch_pixeldrain_info_api(self, pd_id):
        try:
            url = f"https://pixeldrain.com/api/file/{pd_id}/info"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200: return resp.json()
        except: pass
        return None

    def extract_xvideos_metadata(self, url):
        """
        Highest quality XVideos extractor using yt-dlp.
        Prioritizes HLS (m3u8) for maximum quality (1080p+), falls back to best MP4.
        """


        # Modern User-Agent to avoid blocks/low quality
        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'extract_flat': False,
            'format': 'bestvideo+bestaudio/best', 
            'cookiefile': 'xvideos.cookies.txt',
            'ignoreerrors': True,
            'no_warnings': True,
            'user_agent': user_agent,
            'http_headers': {
                'User-Agent': user_agent,
                'Referer': 'https://www.xvideos.com/'
            }
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    return None

                formats = info.get('formats', [])
                valid_formats = []
                
                for f in formats:
                    stream_url = f.get('url')
                    if not stream_url: 
                        continue
                    
                    height = f.get('height') or 0
                    
                    # Fix 0p: Extract from format_note or format_id if height is missing
                    if height == 0:
                        note = (f.get('format_note') or '') + (f.get('format_id') or '')
                        match = re.search(r'(\d{3,4})p', note)
                        if match:
                            height = int(match.group(1))
                    
                    # Fallback for HLS if height is still 0
                    is_hls = '.m3u8' in stream_url or 'hls' in f.get('protocol', '').lower()
                    if is_hls and height == 0:
                        height = 1080 # Default to high quality for HLS
                    
                    valid_formats.append({
                        'url': stream_url,
                        'height': height,
                        'width': f.get('width') or 0,
                        'ext': f.get('ext'),
                        'protocol': f.get('protocol'),
                        'is_hls': is_hls,
                        'type': 'hls' if is_hls else 'mp4'
                    })

                # Sort: HLS first, then by height DESC
                # We want highest quality HLS if possible
                valid_formats.sort(key=lambda x: (x['is_hls'], x['height']), reverse=True)
                
                # Fallback to XVideosExtractor (Playwright) if standard methods fail or return low quality
                # This is the "Nuclear Option" for quality
                current_best_height = valid_formats[0]['height'] if valid_formats else 0
                if current_best_height < 720:
                    try:
                        from extractors.xvideos import XVideosExtractor
                        logging.info(f"Using Playwright Extractor for {url} (Standard method yielded low quality: {current_best_height}p)")
                        xv = XVideosExtractor()
                        pw_res = asyncio.run(xv.extract_metadata(url))
                        
                        if pw_res and pw_res.get('found'):
                             # Map Playwright result to our structure
                             is_hls = 'hls' in (pw_res.get('quality_source') or '').lower() or '.m3u8' in pw_res['stream_url']
                             pw_height = 1080 if is_hls else 0 
                             
                             # ffprobe the Playwright URL to be sure
                             pw_meta = {'duration': 0, 'height': pw_height, 'width': 0}
                             pw_meta = self._ffprobe_fallback(pw_res['stream_url'], pw_meta)
                             
                             return {
                                "source": "xvideos",
                                "id": info.get('id') if info else 'unknown',
                                "title": pw_res['title'],
                                "duration": pw_meta.get('duration') or info.get('duration') or 0,
                                "thumbnail": pw_res.get('thumbnail_url') or info.get('thumbnail'),
                                "stream": {
                                    "type": "hls" if is_hls else "mp4",
                                    "url": pw_res['stream_url'],
                                    "height": pw_meta.get('height') or pw_height,
                                    "width": pw_meta.get('width') or 0
                                },
                                 "tags": list(set(info.get('tags', []) + info.get('categories', []))) if info else []
                             }
                    except Exception as e:
                        logging.error(f"Playwright fallback failed: {e}")

                if not valid_formats:
                    # Final fallback from info directly
                    fallback_url = info.get('url')
                    is_hls_fallback = '.m3u8' in (fallback_url or '')
                    return {
                        "source": "xvideos",
                        "id": info.get('id'),
                        "title": info.get('title'),
                        "duration": info.get('duration'),
                        "thumbnail": info.get('thumbnail'),
                        "stream": {
                            "type": "hls" if is_hls_fallback else "mp4",
                            "url": fallback_url,
                            "height": info.get('height') or (1080 if is_hls_fallback else 0),
                            "width": info.get('width') or 0
                        },
                        "tags": list(set(info.get('tags', []) + info.get('categories', [])))
                    }

                best = valid_formats[0]
                
                return {
                    "source": "xvideos",
                    "id": info.get('id'),
                    "title": info.get('title'),
                    "duration": info.get('duration'),
                    "thumbnail": info.get('thumbnail'),
                    "stream": {
                        "type": best['type'],
                        "url": best['url'],
                        "height": best['height'],
                        "width": best['width']
                    },
                    "tags": list(set(info.get('tags', []) + info.get('categories', [])))
                }
        except Exception as e:
            logging.error(f"XVideos extraction failed for {url}: {e}")
            return None


    def _fetch_xhamster_meta(self, url):
        """
        Robust xHamster extractor using yt-dlp to get the best playable stream,
        with fallback to Playwright (Nuclear Option) for 1080p/4K detection.
        """
        import yt_dlp
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'extract_flat': False,
            'format': 'best',
            'ignoreerrors': True,
            'no_warnings': True,
        }
        meta = {}
        stream_url = None
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if info:
                    meta = {
                        'title': info.get('title'),
                        'duration': info.get('duration'),
                        'thumbnail_url': info.get('thumbnail'),
                        'width': info.get('width'),
                        'height': info.get('height'),
                        'tags': ",".join(info.get('tags', [])),
                        'id': info.get('id')
                    }
                    stream_url = info.get('url')

        except Exception as e:
            logging.warning(f"xHamster yt-dlp extraction failed for {url}: {e}")

        # NUCLEAR OPTION: If yt-dlp failed OR quality is low (<720p), use Playwright
        if not stream_url or (meta.get('height') or 0) < 720:
             try:
                from app.extractors.xhamster import XHamsterExtractor
                logging.info(f"Using Playwright Extractor for xHamster {url}...")
                xh = XHamsterExtractor()
                pw_res = asyncio.run(xh.extract_playwright(url))
                
                if pw_res:
                    stream_url = pw_res['stream_url']
                    meta['title'] = pw_res['title'] or meta.get('title')
                    meta['thumbnail_url'] = pw_res['thumbnail'] or meta.get('thumbnail_url')
                    meta['duration'] = pw_res['duration'] or meta.get('duration')
                    meta['height'] = pw_res['height'] or meta.get('height')
                    
                    logging.info(f"xHamster Nuclear Success: {meta.get('height')}p")

             except Exception as e:
                 logging.error(f"xHamster Playwright fallback error: {e}")

        return meta, stream_url

    def _fetch_xvideos_meta(self, url):
        try:
            # Enhanced User-Agent to avoid mobile redirection or anti-bot blocks
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
            resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, 'html.parser')

            meta = {}
            stream_url = None

            # --- Title ---
            title_tag = soup.select_one('h2.page-title, .video-title h1 strong')
            if title_tag:
                meta['title'] = title_tag.text.strip()
            
            script_content = ""
            scripts = soup.find_all('script')
            for script in scripts:
                # Check script.string or script.get_text() if string is empty
                content = script.string or script.get_text()
                if content and 'html5player.setVideoTitle' in content:
                    script_content = content
                    break
            
            if script_content:
                # Title from script (Highly reliable for XVideos)
                title_match = re.search(r"html5player\.setVideoTitle\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                if title_match:
                    meta['title'] = title_match.group(1).strip()

                # HLS (Preferred for quality)
                match_hls = re.search(r"html5player\.setVideoHLS\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                if match_hls:
                    stream_url = match_hls.group(1)

                # High Quality Fallback
                if not stream_url:
                    match_high = re.search(r"html5player\.setVideoUrlHigh\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                    if match_high:
                        stream_url = match_high.group(1)
                
                # Low Quality Fallback
                if not stream_url:
                    match_low = re.search(r"html5player\.setVideoUrlLow\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                    if match_low:
                        stream_url = match_low.group(1)

                # Duration
                duration_match = re.search(r"html5player\.setVideoDuration\s*\(\s*([\d\.\s]+)\s*\);", script_content)
                if duration_match:
                    meta['duration'] = int(float(duration_match.group(1).strip()))

                # Fallback for HLS if not in standard call
                if not stream_url:
                    hls_raw = re.search(r"['\"](https?://[^'\"]+?\.m3u8[^'\"]*?)['\"]", script_content)
                    if hls_raw: stream_url = hls_raw.group(1)

                # Thumbnail
                # Try setThumbUrl169 first (often higher res)
                thumb_match = re.search(r"html5player\.setThumbUrl169\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                if thumb_match:
                     meta['thumbnail_url'] = thumb_match.group(1)
                else:
                    # Fallback to setThumbUrl
                    thumb_match = re.search(r"html5player\.setThumbUrl\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                    if thumb_match:
                         meta['thumbnail_url'] = thumb_match.group(1)

            # --- Actresses & Tags Extraction ---
            tags = []
            # Improved selectors for XVideos (Actresses, Models, Categories)
            selectors = [
                '.video-metadata a[href*="/tags/"]', 
                '.video-metadata a[href*="/models/"]',
                '.video-metadata a[href*="/pornstars/"]',
                '.video-tags a', 
                'a.label',
                'ul.video-tags li a'
            ]
            for selector in selectors:
                for t in soup.select(selector):
                    txt = t.get_text(strip=True).replace('#', '')
                    if txt and len(txt) > 1 and txt not in tags:
                        tags.append(txt)
            
            if tags:
                meta['tags'] = ",".join(tags)

            # Fallback for title
            if not meta.get('title'):
                title_og = soup.find('meta', property='og:title')
                if title_og: meta['title'] = title_og['content']

            # Final fallback for stream URL in entire page
            if not stream_url:
                hls_page = re.search(r"['\"](https?://[^'\"]+?\.m3u8[^'\"]*?)['\"]", resp.text)
                if hls_page: stream_url = hls_page.group(1)

            return meta, stream_url
        except Exception as e:
            logging.warning(f"Xvideos scraping failed for {url}: {e}")
            return {}, None

    async def _scrape_generic_video_page(self, url):
        meta = {}
        stream_url = None
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        
        try:
            async with httpx.AsyncClient(http2=True, timeout=20, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, 'html.parser')

                # --- Find Title ---
                og_title = soup.find('meta', property='og:title')
                if og_title and og_title.get('content'):
                    meta['title'] = og_title['content']
                else:
                    title_tag = soup.find('title')
                    if title_tag:
                        meta['title'] = title_tag.text.strip()

                # --- Find Video Stream ---
                # Look for <video> tag src
                video_tag = soup.find('video')
                if video_tag and video_tag.get('src'):
                    stream_url = urllib.parse.urljoin(url, video_tag['src'])
                
                # Look for HLS (.m3u8) links if no video tag found
                if not stream_url:
                    links = soup.find_all('a', href=True)
                    for link in links:
                        if '.m3u8' in link['href']:
                            stream_url = urllib.parse.urljoin(url, link['href'])
                            break
                
                # Fallback: Look for any MP4 links
                if not stream_url:
                    links = soup.find_all('a', href=True)
                    for link in links:
                        if '.mp4' in link['href']:
                            stream_url = urllib.parse.urljoin(url, link['href'])
                            break
                            
        except Exception as e:
            logging.error(f"Generic scraping failed for {url}: {e}")

        return meta, stream_url

    def _read_and_clean_vtt(self, yt_id):
        try:
            vtt_path = os.path.join(SUBTITLE_DIR, f"{yt_id}.en.vtt")
            if not os.path.exists(vtt_path): return ""
            with open(vtt_path, 'r', encoding='utf-8') as f: content = f.read()
            lines = content.splitlines()
            clean_lines = []
            for line in lines:
                if line.strip().startswith('WEBVTT') or '-->' in line or line.strip().startswith('Kind:') or line.strip().startswith('Language:'): continue
                line = re.sub(r'<[^>]+>', '', line)
                clean_lines.append(line.strip())
            return " ".join(clean_lines)
        except: return ""

    def _download_pixeldrain_thumbnail(self, video_id, pd_id):
        thumb_url = f"https://pixeldrain.com/api/file/{pd_id}/thumbnail"
        target_path = os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg")
        try:
            resp = requests.get(thumb_url, timeout=5)
            if resp.status_code == 200:
                with open(target_path, 'wb') as f: f.write(resp.content)
                preview_base = os.path.join(PREVIEW_DIR, f"{video_id}_")
                for i in range(4): shutil.copy(target_path, f"{preview_base}{i}.jpg")
                return True
        except: pass
        return False

    def _extract_title_from_url(self, url):
        try:
            parsed = urllib.parse.urlparse(url)
            path = parsed.path
            basename = os.path.basename(path)

            # Special logic for XVideos to extract title from slug (e.g. /video.xxx/slug_name)
            if "xvideos.com" in url or "xvideos-cdn.com" in url:
                parts = [p for p in path.split('/') if p]
                for i, p in enumerate(parts):
                    if p.startswith('video.') and i + 1 < len(parts):
                        slug = parts[i+1]
                        return slug.replace('_', ' ').replace('-', ' ').title()
                    # Fallback for CDN URLs that might have the slug in a different part
                    if len(p) > 20 and '_' in p:
                         return p.replace('_', ' ').replace('-', ' ').title()

            if "nsfw247.to" in url:
                # Princessjas4Ux Pov Doggystyle Anal Fuck 0Z3C8Wb0 -> Princessjas4Ux POV Doggystyle Anal Fuck
                slug = basename.replace('_', ' ').replace('-', ' ')
                # Remove random ID at the end (e.g. 0z3c8wb0)
                slug = re.sub(r'\s[a-z0-9]{8,12}$', '', slug)
                return slug.title()

            if "pixeldrain" in url:
                decoded = urllib.parse.unquote(basename)
                if len(decoded) > 3: return decoded
            
            title = os.path.splitext(basename)[0]
            if title.lower() in ["hls", "index", "m3u8", "video", "queued"]: return None
            
            return title.replace('_', ' ').replace('-', ' ').title()
        except: return None

    def _fetch_metadata(self, url, yt_id, quality_mode='mp4'):
        meta = {}
        stream_url = None
        try:
            subtitle_path_template = os.path.join(SUBTITLE_DIR, f'{yt_id}.%(ext)s') if yt_id else os.path.join(SUBTITLE_DIR, 'subtitle.%(ext)s')
            fmt = 'bestvideo+bestaudio/best'
            opts = {
                'quiet': True, 'skip_download': True, 'ignoreerrors': True, 'socket_timeout': 15,
                'ffmpeg_location': FFMPEG_CMD,
                'format': fmt,
                'writesubtitles': True, 'writeautomaticsub': True,
                'subtitleslangs': ['en'],
                'outtmpl': subtitle_path_template,
                'http_headers': {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': url
                }
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if info:
                    stream_url = info.get('url') 
                    meta.update({
                        'title': info.get('title'), 'description': info.get('description'),
                        'duration': info.get('duration'), 'width': info.get('width'),
                        'height': info.get('height'), 'tags': ",".join(info.get('tags', []))
                    })
        except Exception as e:
            logging.warning(f"Failed to fetch metadata with yt-dlp for {url}: {e}")
        return meta, stream_url

    def _bunkr_cdn_referer(self, url_hint: str) -> str:
        """Return the correct Referer for Bunkr CDN requests.
        scdn.st CDN 5XX-es when Referer is itself or missing — needs a bunkr.* domain root."""
        try:
            p = urllib.parse.urlparse(url_hint or "")
            h = p.netloc.lower()
            if h and "bunkr" in h and "scdn" not in h:
                return f"{p.scheme}://{p.netloc}/"
        except Exception:
            pass
        return "https://bunkr.cr/"

    def _ffprobe_fallback(self, url, meta, referer=None):
        try:
            if not shutil.which(FFPROBE_CMD): return meta
            
            headers_args = []
            ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            if referer and not self._is_webshare_host(referer):
                headers_args = ['-headers', f'Referer: {referer}\r\nUser-Agent: {ua}\r\n']
            elif self._is_webshare_host(url):
                headers_args = ['-headers', f'User-Agent: {ua}\r\n']

            cmd = [FFPROBE_CMD] + headers_args + FFMPEG_NETWORK_ARGS + [
                '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height,duration',
                '-of', 'json', '-analyzeduration', '15000000', '-probesize', '15000000', url
            ]
            
            async def _run_ffprobe():
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                try:
                    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=20)
                    return stdout.decode('utf-8')
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.communicate()
                    raise Exception("ffprobe timeout")
            
            stdout_data = asyncio.run(_run_ffprobe())
            data = json.loads(stdout_data)
            if 'streams' in data and len(data['streams']) > 0:
                # Pick the highest quality stream if multiple (e.g. in master HLS)
                streams = sorted(data['streams'], key=lambda s: int(s.get('height', 0)), reverse=True)
                stream = streams[0]
                meta['width'] = int(stream.get('width', 0))
                meta['height'] = int(stream.get('height', 0))
                
                # Robust duration: try all streams if available
                durations = [float(s.get('duration')) for s in data['streams'] if s.get('duration')]
                if durations:
                    meta['duration'] = max(durations)
                elif not meta.get('duration'):
                    # Final attempt: check format duration
                    format_dur = data.get('format', {}).get('duration')
                    if format_dur: meta['duration'] = float(format_dur)
                    
        except Exception as e: logging.error(f"ffprobe failed: {e}")
        return meta
    
    def _is_webshare_host(self, value):
        if not value:
            return False
        lowered = str(value).lower()
        return "webshare" in lowered or "wsfiles" in lowered or "vip-stream" in lowered

    def _fetch_webshare_thumbnail(self, ident: str, original: Optional[str] = None) -> Optional[str]:
        """Best-effort scrape of Webshare file page to retrieve the og:image thumbnail."""
        if not ident:
            return None

        candidates = []
        if original and original.startswith('http') and 'webshare.cz' in original:
            # Handle client-side routing hash URLs: #/file/ident -> /file/ident
            if "/#/file/" in original:
                fixed_url = original.replace("/#/file/", "/file/")
                candidates.append(fixed_url)
            candidates.append(original)
        
        if original and original.startswith('webshare:'):
            parts = original.split(':', 2)
            slug = parts[2] if len(parts) > 2 else ''
            if slug:
                safe_slug = urllib.parse.quote(slug)
                candidates.append(f"https://webshare.cz/file/{ident}/{safe_slug}")
        
        candidates.append(f"https://webshare.cz/file/{ident}")

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }

        seen = set()
        for page_url in candidates:
            if not page_url or page_url in seen:
                continue
            seen.add(page_url)
            try:
                resp = requests.get(page_url, headers=headers, timeout=12)
                if resp.status_code != 200 or not resp.text:
                    continue
                soup = BeautifulSoup(resp.text, 'html.parser')
                meta_tag = soup.find('meta', attrs={'property': 'og:image'}) or soup.find('meta', attrs={'name': 'og:image'})
                if meta_tag and meta_tag.get('content'):
                    candidate = meta_tag['content'].strip()
                    if candidate:
                        return urllib.parse.urljoin(page_url, candidate)
            except Exception as e:
                logging.debug(f"Webshare thumbnail scrape failed for {page_url}: {e}")
                continue
        return None

    def _generate_visuals(self, url, vid_id, duration, referer=None):
        if not shutil.which(FFMPEG_CMD): return
        thumb_out = os.path.join(THUMB_DIR, f"thumb_{vid_id}.jpg")
        
        # CLEANUP: Remove old thumbnail if exists
        if os.path.exists(thumb_out):
            try: os.remove(thumb_out)
            except: pass

        is_http = url.startswith('http')
        sw_args = [FFMPEG_CMD, '-y', '-threads', '4', '-hide_banner', '-loglevel', 'error']

        if is_http:
            sw_args += FFMPEG_NETWORK_ARGS

        headers_str = ""
        if referer and is_http:
            headers_str += f"Referer: {referer}\r\n"
        
        if is_http and "User-Agent" not in headers_str:
             headers_str += "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n"

        async def _run_cmd_async(cmd_template, label, timeout_s):
            try:
                idx = cmd_template.index('-i')
                if headers_str and is_http:
                    full_cmd = cmd_template[:idx] + ['-headers', headers_str] + cmd_template[idx:]
                else:
                    full_cmd = cmd_template
            except ValueError:
                full_cmd = cmd_template

            try:
                proc = await asyncio.create_subprocess_exec(
                    *full_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                try:
                    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
                    return proc.returncode == 0
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.communicate()
            except: pass
            return False

        async def _generate_all():
            if duration > 10:
                cmd = sw_args + ['-ss', str(duration * 0.1), '-i', url, '-vf', "scale=640:-1", '-vframes', '1', '-q:v', '5', thumb_out]
                if await _run_cmd_async(cmd, "sw_seek", 60):
                    return

            if not os.path.exists(thumb_out):
                cmd = sw_args + ['-i', url, '-vf', "thumbnail,scale=640:-1", '-frames:v', '1', thumb_out]
                await _run_cmd_async(cmd, "sw_deep_scan", 120)

        asyncio.run(_generate_all())

    def _generate_smart_tags(self, title):
        if not title: return ""
        tags = []
        for k in ['4k', 'hd', 'vlog', 'gameplay', 'pov', 'asmr']:
            if k in title.lower(): tags.append(k)
        return ",".join(tags)

    def _generate_ai_tags(self, title, description):
        if not NLP or not title: return ""
        try:
            doc = NLP(title[:200])
            tags = {token.lemma_.lower() for token in doc if token.pos_ == 'NOUN' and not token.is_stop}
            return ",".join(list(tags)[:10])
        except: return ""

    def fetch_and_update_video_size(self, video_id, db=None):
        """Fetches file size for a video (remote or local) and updates download_stats."""
        close_db = False
        if db is None:
            db = SessionLocal()
            close_db = True
            
        try:
            video = db.query(Video).get(video_id)
            if not video: return False
            
            stats = video.download_stats or {}
            # If we already have size_mb, we're done
            if stats.get('size_mb'): return True
            
            size_mb = 0
            # 1. Local file check
            is_local = video.storage_type == "local" or (video.url and video.url.startswith('/static/'))
            if is_local:
                path_part = video.url.replace('/static/', '', 1).lstrip('/')
                local_path = os.path.join("app", "static", path_part)
                if os.path.exists(local_path):
                    size_mb = round(os.path.getsize(local_path) / (1024 * 1024), 2)
                    video.storage_type = "local"
            # 2. Remote file check
            elif video.url and video.url.startswith('http'):
                import requests
                try:
                    headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': '*/*'
                    }
                    
                    is_bunkr = "bunkr" in video.url or (video.source_url and "bunkr" in video.source_url) or "scdn.st" in video.url
                    if is_bunkr:
                        headers['Referer'] = self._bunkr_cdn_referer(video.source_url or video.url)
                    elif video.source_url:
                        headers['Referer'] = video.source_url
                    
                    # Try HEAD first
                    resp = requests.head(video.url, headers=headers, timeout=8, allow_redirects=True)
                    content_length = int(resp.headers.get('Content-Length', 0))
                    
                    # If HEAD fails or returns 0, try small GET with Range
                    if content_length <= 0:
                        headers['Range'] = 'bytes=0-0'
                        resp = requests.get(video.url, headers=headers, timeout=8, allow_redirects=True, stream=True)
                        
                        # Check Content-Range first: "bytes 0-0/12345"
                        content_range = resp.headers.get('Content-Range', '')
                        m = re.search(r'/(\d+)$', content_range)
                        if m:
                            content_length = int(m.group(1))
                        else:
                            content_length = int(resp.headers.get('Content-Length', 0))
                    
                    if content_length > 0:
                        size_mb = round(content_length / (1024 * 1024), 2)
                except Exception as e:
                    logging.debug(f"Failed to fetch remote size for {video_id}: {e}")
            
            if size_mb > 0:
                stats['size_mb'] = size_mb
                video.download_stats = stats
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(video, "download_stats")
                db.commit()
                return True
        except Exception as e:
            logging.error(f"Error in fetch_and_update_video_size for {video_id}: {e}")
        finally:
            if close_db: db.close()
        return False


def search_videos_by_subtitle(query: str, db: Session):
    return db.query(Video).filter(Video.subtitle.contains(query)).all()

def get_batch_stats(db: Session):
    from sqlalchemy import func
    videos = db.query(Video.batch_name, Video.download_stats).all()
    stats = {}
    for batch, d_stats in videos:
        batch_name = batch or "Uncategorized"
        if batch_name not in stats:
            stats[batch_name] = {"count": 0, "total_size_mb": 0}
        stats[batch_name]["count"] += 1
        if d_stats and isinstance(d_stats, dict) and d_stats.get("size_mb"):
            stats[batch_name]["total_size_mb"] += d_stats["size_mb"]
    
    return [
        {
            "label": b, 
            "value": s["count"], 
            "total_size_mb": round(s["total_size_mb"], 2),
            "size_text": f"{s['total_size_mb'] / 1024:.1f} GB" if s["total_size_mb"] > 1024 else f"{int(s['total_size_mb'])} MB"
        } 
        for b, s in stats.items()
    ]

def get_tags_stats(db: Session):
    all_tags = []
    videos = db.query(Video.tags, Video.ai_tags).all()
    for v_tags, v_ai_tags in videos:
        if v_tags: all_tags.extend(t.strip() for t in v_tags.split(','))
        if v_ai_tags: all_tags.extend(t.strip() for t in v_ai_tags.split(','))
    tag_counts = Counter(all_tags)
    return [{"label": t[0], "value": t[1]} for t in tag_counts.most_common(20)]

def get_quality_stats(db: Session):
    stats = { "4K": 0, "FHD": 0, "HD": 0, "SD": 0, "Unknown": 0 }
    videos = db.query(Video.height).all()
    for v in videos:
        h = v[0]
        if h >= 1080: stats["FHD"] += 1
        elif h >= 720: stats["HD"] += 1
        elif h > 0: stats["SD"] += 1
        else: stats["Unknown"] += 1
    return [{"label": k, "value": v} for k, v in stats.items()]

def extract_playlist_urls(url: str, parser: str = "yt-dlp"):
    import os  # Import at function level for use throughout
    found_urls = []
    
    # Camwhores watch pages must keep slug path; yt-dlp flattening can degrade them to /videos/<id>/.
    if "camwhores.tv" in (url or "").lower() and "/videos/" in (url or "").lower():
        return [url]
    
    # 0. Skip direct files immediately to prevent IncompleteRead errors
    # Erome CDN v40.erome.com and direct .mp4 links should not be scraped as HTML
    is_direct = any(url.lower().split('?')[0].endswith(ext) for ext in ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8'])
    is_cdn = any(domain in url for domain in ['v.erome.com', 'v40.erome.com', 'v1.erome.com', 'cdn.bunkr.is', 'wsfiles.cz'])
    
    if is_direct or is_cdn:
        return [url]
    
    # 1. XenForo Thread Extraction (SimpCity, SMG)
    if "simpcity.su" in url or "socialmediagirls.com" in url:
        try:
            from extractors.xenforo import XenForoExtractor
            base = "https://simpcity.su" if "simpcity" in url else "https://socialmediagirls.com"
            scout = XenForoExtractor(base)
            links = scout.extract_links_from_thread(url)
            for l in links:
                found_urls.append(l['url'])
            if found_urls: return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"XenForo extraction failed for {url}: {e}")

    # 1.5 VK Playlist Extraction
    if any(pattern in url for pattern in ['/playlist/', '/videos-', '/album-']):
        if any(domain in url for domain in ['vk.com', 'vkvideo.ru', 'vk.video']):
            try:
                import yt_dlp
                
                logging.info(f"Detected VK playlist: {url}")
                
                user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                ydl_opts = {
                    'quiet': True,
                    'extract_flat': True,  # Don't download, just get URLs
                    'skip_download': True,
                    'ignoreerrors': True,
                    'no_warnings': True,
                    'user_agent': user_agent,
                    'http_headers': {
                        'User-Agent': user_agent,
                        'Referer': 'https://vk.com/'
                    }
                }
                
                # Add cookies if available
                if os.path.exists("vk.netscape.txt"):
                    ydl_opts['cookiefile'] = "vk.netscape.txt"
                elif os.path.exists("cookies.netscape.txt"):
                    ydl_opts['cookiefile'] = "cookies.netscape.txt"
                
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    
                    if info:
                        # Extract video URLs from playlist entries
                        entries = info.get('entries', [])
                        
                        for entry in entries:
                            if entry:
                                # Try to get the video URL
                                video_url = None
                                
                                # Method 1: webpage_url (most reliable)
                                if entry.get('webpage_url'):
                                    video_url = entry['webpage_url']
                                # Method 2: Construct from ID
                                elif entry.get('id'):
                                    video_url = f"https://vk.com/video{entry['id']}"
                                # Method 3: url field
                                elif entry.get('url') and 'vk.com' in entry['url']:
                                    video_url = entry['url']
                                
                                if video_url:
                                    found_urls.append(video_url)
                        
                        if found_urls:
                            logging.info(f"Extracted {len(found_urls)} videos from VK playlist")
                            return list(dict.fromkeys(found_urls))
                        else:
                            logging.warning(f"No videos found in VK playlist: {url}")
            except Exception as e:
                logging.error(f"VK playlist extraction failed for {url}: {e}")
                import traceback
                logging.error(traceback.format_exc())

    # 2. Specialized Bunkr Scraper
    if "bunkr" in url and ("/a/" in url or "/album/" in url or "/f/" in url):
        try:
             from extractors.bunkr import BunkrExtractor
             be = BunkrExtractor()
             # We use a brief loop for async call in sync method
             files = asyncio.run(be.extract_album(url))
             for f in files:
                 # Construct direct link: cdn/name
                 direct = f"{f['cdn']}/{f['name']}"
                 found_urls.append(direct)
             if found_urls: return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"Bunkr album extraction failed for {url}: {e}")

    # 2.5 Specialized Turbo.cr Album
    if "turbo.cr" in url and ("/a/" in url or "/album/" in url):
        try:
             from app.extractors.turbo import TurboExtractor
             te = TurboExtractor()
             all_videos = asyncio.run(te.extract_album(url))
             if all_videos:
                 logging.info(f"Turbo.cr album expanded: found {len(all_videos)} videos")
                 return all_videos
        except Exception as e:
            logging.warning(f"Turbo.cr album extraction failed for {url}: {e}")

    # 2.5 Specialized Erome Scraper
    if "erome.com" in url:
        try:

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.erome.com/'
            }
            # Use stream=True to check headers before downloading the body
            resp = requests.get(url, headers=headers, timeout=10, stream=True)
            if resp.status_code == 200:
                # If it's a direct video (not HTML), just return it
                ctype = resp.headers.get('Content-Type', '').lower()
                if 'text/html' not in ctype:
                    return [url]
                
                soup = BeautifulSoup(resp.text, 'html.parser')
                # Erome videos are in <video> or <source> tags
                sources = soup.select('video > source[src]')
                for s in sources:
                    src = s['src']
                    if src.startswith('//'): src = 'https:' + src
                    found_urls.append(src)
                
                # Check for direct video tags too
                videos = soup.select('video[src]')
                for v in videos:
                    src = v['src']
                    if src.startswith('//'): src = 'https:' + src
                    found_urls.append(src)
                
                if found_urls: return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"Erome extraction failed for {url}: {e}")

    # 2.6 Specialized Eporner Playlist
    if "eporner.com" in url and "/playlist/" in url:
        try:

            
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
            resp = requests.get(url, headers=headers, timeout=20)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, 'html.parser')
                found_videos = []
                
                # Strategy: Find 'streamevents' container which usually holds the grid
                # We specifically look for the one relevant to the playlist if possible
                container = soup.find('div', class_='streamevents')
                
                # Refinement: Try to find header to ensure we get the playlist container
                header = soup.find(lambda t: t.name in ['h1', 'h2'] and "Playlist:" in (t.string or ""))
                if header:
                     parent = header.find_parent('div')
                     if parent:
                         # Look for next sibling that is 'streamevents'
                         candidate = parent.find_next_sibling('div', class_='streamevents')
                         if candidate: container = candidate

                if container:
                    links = container.find_all('a', href=re.compile(r'/video-'))
                    for l in links:
                        href = l['href']
                        if not href.startswith('http'): href = "https://www.eporner.com" + href
                        found_videos.append(href)
                
                # Fallback: If strict container parsing failed, grab all video- links
                if not found_videos:
                     links = soup.find_all('a', href=re.compile(r'/video-'))
                     for l in links:
                         href = l['href']
                         if not href.startswith('http'): href = "https://www.eporner.com" + href
                         found_videos.append(href)

                if found_videos:
                     found_urls.extend(found_videos)
                     return list(dict.fromkeys(found_urls))

        except Exception as e:
            logging.warning(f"Eporner playlist extraction failed for {url}: {e}")


    # 2.7 Specialized XVideos Profile/Model/List
    if "xvideos.com" in url:
        # Check if it's a playlist/favorite/profile/channel but NOT a single video
        is_playlist = "/favorite/" in url or "/profiles/" in url or "/channels/" in url or "/tags/" in url or not "/video." in url
        if is_playlist:
            try:
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.xvideos.com/'
                }
                
                # Robust cookie handling: only use if it looks like a simple key=value string
                if os.path.exists("xvideos.cookies.txt"):
                     with open("xvideos.cookies.txt", "r") as f:
                          cookie_data = f.read().strip()
                          if cookie_data and not cookie_data.startswith("# Netscape"):
                              headers['Cookie'] = cookie_data

                resp = requests.get(url, headers=headers, timeout=20)
                if resp.status_code != 200:
                    logging.error(f"[XVIDEOS_PLAYLIST_FAIL] Status code {resp.status_code} for {url}")
                else:
                    soup = BeautifulSoup(resp.text, 'html.parser')
                    
                    found_videos = []
                    # Try to find video blocks first for accurate limit counting
                    blocks = soup.select('.thumb-block')
                    for block in blocks:
                        # Prioritize the main title link
                        a = block.select_one('p.title a') or block.select_one('.thumb a')
                        if a and a.get('href'):
                            href = a['href']
                            if not href.startswith('http'): 
                                href = "https://www.xvideos.com" + href
                            clean_url = href.split('#')[0].split('?')[0]
                            if "/video." in clean_url and clean_url not in found_videos:
                                found_videos.append(clean_url)
                                if len(found_videos) >= 500:
                                    break
                    
                    # Fallback to any video links if blocks failed
                    if not found_videos:
                        links = soup.select('a[href*="/video."]')
                        for l in links:
                            href = l['href']
                            if not href.startswith('http'): 
                                href = "https://www.xvideos.com" + href
                            clean_url = href.split('#')[0].split('?')[0]
                            if clean_url not in found_videos:
                                found_videos.append(clean_url)
                                if len(found_videos) >= 500:
                                    break

                    if found_videos:
                        logging.info(f"[XVIDEOS_PLAYLIST_OK] {len(found_videos)} videos processed from playlist {url}")
                        if len(found_videos) < 20:
                            logging.warning(f"[XVIDEOS_PLAYLIST_PARTIAL] Only {len(found_videos)} found")
                        return found_videos
                    else:
                        logging.warning(f"[XVIDEOS_PLAYLIST_FAIL] No videos found in {url}")
            except Exception as e:
                logging.warning(f"XVideos profile extraction failed for {url}: {e}")


    # 2.8 Specialized SpankBang Playlist
    if "spankbang.com" in url and "/playlist/" in url:
        try:
            from extractors.spankbang import SpankBangExtractor
            logging.info(f"Using Playwright for SpankBang playlist expansion: {url}")
            sb = SpankBangExtractor()
            all_videos = asyncio.run(sb.extract_playlist(url))
            
            if all_videos:
                logging.info(f"SpankBang playlist expanded: found {len(all_videos)} unique videos")
                return all_videos
        except Exception as e:
            logging.warning(f"SpankBang playlist expansion failed: {e}")

    # 3. yt-dlp Fallback
    opts = {'extract_flat': True, 'quiet': True, 'ignoreerrors': True, 'socket_timeout': 15}
    if "xvideos.com" in url and os.path.exists("xvideos.netscape.txt"):
        opts['cookiefile'] = "xvideos.netscape.txt"
    elif "eporner.com" in url and os.path.exists("eporner.netscape.txt"):
        opts['cookiefile'] = "eporner.netscape.txt"
    elif os.path.exists("bridge.cookies.txt"): # Generic fallback
        # We'd need to convert bridge.cookies.txt to netscape too if we want to use it here
        pass

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info and 'entries' in info:
                for entry in info['entries']:
                    if entry: found_urls.append(entry.get('url') or entry.get('webpage_url'))
            elif info: found_urls.append(url)
    except: pass
    
    if found_urls:
        return [u for u in found_urls if u]
    
    # If no videos found, and it's a known non-video page, return empty instead of [url]
    is_profile = (
        "xvideos.com" in url and not "/video." in url
    ) or (
        "eporner.com" in url and "/playlist/" in url
    ) or (
        "bunkr" in url and ("/a/" in url or "/album/" in url)
    )
    
    if is_profile:
        return []

    return [url]

