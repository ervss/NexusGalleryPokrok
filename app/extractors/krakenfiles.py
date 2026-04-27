import httpx
import re
import logging
import urllib.parse
from typing import Optional, Dict, Any
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

class KrakenFilesExtractor:
    def __init__(self):
        self.name = "KrakenFiles"

    def can_handle(self, url: str) -> bool:
        return "krakenfiles.com" in url.lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': url,
        }
        
        try:
            # 1. Get the view page or embed page
            # If it's a view page, we might want to use the embed page instead as it's cleaner
            if "/view/" in url:
                file_id = url.split("/view/")[1].split("/")[0]
                url = f"https://krakenfiles.com/embed-video/{file_id}"
            elif "/embed-video/" in url:
                file_id = url.split("/embed-video/")[1].split("/")[0]
            else:
                logger.warning(f"KrakenFiles: Could not determine file ID from {url}")
                return None

            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    logger.warning(f"KrakenFiles: Failed to fetch page {url}, status: {resp.status_code}")
                    return None
                
                html = resp.text
                soup = BeautifulSoup(html, 'html.parser')
                
                # 2. Extract the hash for the POST request
                # Look for form action like /ping/video/HASH
                hash_match = re.search(r'action="(/ping/video/[^"]+)"', html)
                if not hash_match:
                    logger.warning(f"KrakenFiles: Could not find ping hash in {url}")
                    return None
                
                ping_path = hash_match.group(1)
                ping_url = f"https://krakenfiles.com{ping_path}"
                
                # 3. POST to the ping URL to get the stream link
                # KrakenFiles usually needs AJAX header
                ajax_headers = headers.copy()
                ajax_headers['X-Requested-With'] = 'XMLHttpRequest'
                
                post_resp = await client.post(ping_url, headers=ajax_headers)
                if post_resp.status_code != 200:
                    logger.warning(f"KrakenFiles: POST to {ping_url} failed, status: {post_resp.status_code}")
                    return None
                
                try:
                    data = post_resp.json()
                    stream_url = data.get('url')
                    if not stream_url:
                        logger.warning(f"KrakenFiles: JSON response missing 'url': {data}")
                        return None
                    
                    # Ensure stream_url is absolute
                    if stream_url.startswith('//'):
                        stream_url = 'https:' + stream_url
                    elif stream_url.startswith('/'):
                        stream_url = 'https://krakenfiles.com' + stream_url
                        
                except Exception as e:
                    logger.error(f"KrakenFiles: Failed to parse JSON response: {e}")
                    logger.debug(f"KrakenFiles: Response text: {post_resp.text[:500]}")
                    return None

                # 4. Extract metadata
                title = ""
                og_title = soup.find('meta', property='og:title')
                if og_title:
                    title = og_title.get('content', '').strip()
                if not title:
                    title_tag = soup.find('title')
                    if title_tag:
                        title = title_tag.text.replace('Embed ', '').replace(' - Krakenfiles.com', '').strip()

                thumbnail = ""
                og_image = soup.find('meta', property='og:image')
                if og_image:
                    thumbnail = og_image.get('content', '').strip()
                if not thumbnail:
                    # Check video poster
                    video_tag = soup.find('video')
                    if video_tag:
                        thumbnail = video_tag.get('poster', '')

                return {
                    "id": file_id,
                    "title": title or "KrakenFiles Video",
                    "description": "",
                    "thumbnail": thumbnail,
                    "duration": 0,
                    "stream_url": stream_url,
                    "is_hls": ".m3u8" in stream_url.lower(),
                    "extractor": self.name
                }
                
        except Exception as e:
            logger.error(f"KrakenFiles extraction error: {e}")
            return None
