import httpx
import re
import logging
from typing import Optional, Dict, Any
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

class SxyPrnExtractor:
    def __init__(self):
        self.name = "SxyPrn"

    def can_handle(self, url: str) -> bool:
        return "sxyprn.com" in url.lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://sxyprn.com/',
        }
        
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    logger.warning(f"SxyPrn: Failed to fetch page {url}, status: {resp.status_code}")
                    return None
                
                html = resp.text
                soup = BeautifulSoup(html, 'html.parser')
                
                # Extract Title
                title = ""
                og_title = soup.find('meta', property='og:title')
                if og_title:
                    title = og_title.get('content', '').strip()
                if not title:
                    title_tag = soup.find('title')
                    if title_tag:
                        # Clean common suffixes but don't split by dash blindly
                        title = title_tag.text.strip()
                        title = re.sub(r'\s*-\s*SxyPrn.*$', '', title, flags=re.IGNORECASE)

                # Extract Thumbnail
                thumbnail = ""
                og_image = soup.find('meta', property='og:image')
                if og_image:
                    thumbnail = og_image.get('content', '').strip()
                if not thumbnail:
                    # Look for poster or data-poster in video tags
                    video_tag = soup.find('video')
                    if video_tag:
                        thumbnail = video_tag.get('poster', '') or video_tag.get('data-poster', '')

                # Extract Stream URL
                stream_url = ""
                # Look for <video> tag with src
                video_tag = soup.find('video')
                if video_tag and video_tag.get('src'):
                    stream_url = video_tag.get('src')
                
                # SxyPrn often uses relative URLs starting with /cdn
                if stream_url and stream_url.startswith('/'):
                    stream_url = f"https://sxyprn.com{stream_url}"
                
                # If not found in video tag, look in scripts
                if not stream_url:
                    # SxyPrn sometimes puts it in a script variable
                    match = re.search(r'src["\']:\s*["\']([^"\']+\.vid[^"\']*)["\']', html)
                    if match:
                        stream_url = match.group(1)
                        if stream_url.startswith('/'):
                            stream_url = f"https://sxyprn.com{stream_url}"

                if not stream_url:
                    logger.warning(f"SxyPrn: Could not find stream URL for {url}")
                    # Even if we don't have stream, we can return metadata if we have a title
                    if not title: return None

                return {
                    "id": url.split('/')[-1].replace('.html', ''),
                    "title": title or "SxyPrn Video",
                    "description": "",
                    "thumbnail": thumbnail,
                    "duration": 0,
                    "stream_url": stream_url,
                    "is_hls": ".m3u8" in stream_url.lower(),
                    "extractor": self.name
                }
                
        except Exception as e:
            logger.error(f"SxyPrn extraction error: {e}")
            return None
