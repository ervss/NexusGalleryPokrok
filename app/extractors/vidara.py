import re
import logging
import httpx
import urllib.parse
from bs4 import BeautifulSoup
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class VidaraExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Vidara"

    def can_handle(self, url: str) -> bool:
        return any(d in url.lower() for d in ["vidara.so", "vidsonic.net", "vidfast.co"])

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': url,
            'X-Requested-With': 'XMLHttpRequest'
        }
        
        try:
            # Extract filecode from URL (e.g., https://vidara.so/e/nzo6gklY1SSZe -> nzo6gklY1SSZe)
            filecode = url.split('/')[-1].split('?')[0]
            parsed_url = urllib.parse.urlparse(url)
            domain = parsed_url.netloc
            
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                # 1. Try to get stream via API
                api_url = f"https://{domain}/api/stream"
                # Some sites need specific 'device' parameter
                payload = {"filecode": filecode, "device": "web"}
                
                api_resp = await client.post(api_url, json=payload, headers=headers)
                stream_url = None
                title = ""
                thumbnail = ""
                
                if api_resp.status_code == 200:
                    data = api_resp.json()
                    stream_url = data.get('streaming_url')
                    title = data.get('title', '').strip()
                    thumbnail = data.get('thumbnail', '').strip()
                    if stream_url:
                        logger.info(f"Vidara: Successfully extracted stream via API: {stream_url}")
                
                # 2. Page scraping for fallback stream OR missing metadata
                if not stream_url or not title or not thumbnail:
                    resp = await client.get(url, headers=headers)
                    if resp.status_code == 200:
                        html = resp.text
                        soup = BeautifulSoup(html, 'html.parser')
                        
                        if not stream_url:
                            # Look for hex-encoded _videoUrl (vidsonic/vidfast pattern)
                            hex_match = re.search(r"const _0x1 = '([0-9a-f|]+)';", html)
                            if hex_match:
                                try:
                                    hex_str = hex_match.group(1).replace('|', '')
                                    decoded = "".join([chr(int(hex_str[i:i+2], 16)) for i in range(0, len(hex_str), 2)])
                                    stream_url = decoded[::-1]
                                    logger.info(f"Vidara: Decoded hex-encoded MP4: {stream_url}")
                                except Exception as hex_err:
                                    logger.warning(f"Vidara: Failed to decode hex-encoded URL: {hex_err}")

                        if not stream_url:
                            # Look for 'mu=' in HTML
                            match = re.search(r'mu=(https%3A%2F%2F[^"\'\s&]+)', html)
                            if match:
                                stream_url = urllib.parse.unquote(match.group(1))
                                logger.info(f"Vidara: Extracted stream from mu parameter in HTML: {stream_url}")
                            
                            # Look for ping URL directly
                            if not stream_url:
                                match = re.search(r'(https?://[^"\'\s]+\/ping\.gif\?mu=[^"\'\s&]+)', html)
                                if match:
                                    ping_url = match.group(1)
                                    query = urllib.parse.urlparse(ping_url).query
                                    params = urllib.parse.parse_qs(query)
                                    if 'mu' in params:
                                        stream_url = params['mu'][0]
                                        logger.info(f"Vidara: Extracted stream from ping URL in HTML: {stream_url}")
                        
                        if not title:
                            og_title = soup.find('meta', property='og:title')
                            if og_title:
                                title = og_title.get('content', '').strip()
                            if not title:
                                title_tag = soup.find('title')
                                if title_tag:
                                    title = title_tag.text.strip()
                                    # Clean up "Watch " prefix and common suffixes
                                    title = re.sub(r'^Watch\s+', '', title, flags=re.IGNORECASE)
                                    title = re.sub(r'\s*-\s*(Vidara|VidSonic|VidFast).*$', '', title, flags=re.IGNORECASE)

                        if not thumbnail:
                            og_image = soup.find('meta', property='og:image')
                            thumbnail = og_image.get('content', '').strip() if og_image else ""

                if not stream_url:
                    logger.warning(f"Vidara: Could not find stream URL for {url}")
                    return None

                return {
                    "id": filecode,
                    "title": title or "Video",
                    "description": "",
                    "thumbnail": thumbnail,
                    "duration": 0,
                    "stream_url": stream_url,
                    "is_hls": ".m3u8" in stream_url.lower(),
                    "extractor": self.name
                }
                
        except Exception as e:
            logger.error(f"Vidara extraction failed for {url}: {e}")
            return None
