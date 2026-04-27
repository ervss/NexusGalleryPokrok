import re
import logging
import httpx
import urllib.parse
from bs4 import BeautifulSoup
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class LuluStreamExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "LuluStream"

    def can_handle(self, url: str) -> bool:
        domains = ["lulustream.com", "luluvid.com", "luluvdo.com", "lulu.stream", "luluvid.net"]
        return any(domain in url.lower() for domain in domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': url
        }
        
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    logger.warning(f"LuluStream: Failed to fetch {url}, status: {resp.status_code}")
                    return None
                
                html = resp.text
                soup = BeautifulSoup(html, 'html.parser')
                
                # 1. Try to find the Packer-obfuscated script
                stream_url = None
                packer_match = re.search(r'eval\(function\(p,a,c,k,e,d\).*?\.split\(\'\|\'\)\)\)', html)
                if packer_match:
                    packed_js = packer_match.group(0)
                    unpacked = self._unpack_packer(packed_js)
                    if unpacked:
                        # Search for master.m3u8 or similar in unpacked JS
                        m3u8_match = re.search(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                        if m3u8_match:
                            stream_url = m3u8_match.group(1)
                            logger.info(f"LuluStream: Extracted stream from unpacked JS: {stream_url}")

                # 2. Fallback: Check for sources in setup scripts
                if not stream_url:
                    match = re.search(r'sources\s*:\s*\[\s*{\s*file\s*:\s*["\']([^"\']+)["\']', html)
                    if match:
                        stream_url = match.group(1)
                        logger.info(f"LuluStream: Found stream in setup script: {stream_url}")

                if not stream_url:
                    logger.warning(f"LuluStream: Could not find stream URL in {url}")
                    return None

                # Extract Metadata
                title = ""
                og_title = soup.find('meta', property='og:title')
                if og_title:
                    title = og_title.get('content', '').strip()
                if not title:
                    title_tag = soup.find('title')
                    if title_tag:
                        title = title_tag.text.strip()
                        # Often "Title - LuluStream"
                        title = re.sub(r'\s*-\s*LuluStream.*$', '', title, flags=re.IGNORECASE).strip()
                
                thumbnail = ""
                og_image = soup.find('meta', property='og:image')
                if og_image:
                    thumbnail = og_image.get('content', '').strip()

                return {
                    "id": url.split('/')[-1].split('?')[0],
                    "title": title or "LuluStream Video",
                    "description": "",
                    "thumbnail": thumbnail,
                    "duration": 0,
                    "stream_url": stream_url,
                    "is_hls": ".m3u8" in stream_url.lower(),
                    "extractor": self.name
                }
                
        except Exception as e:
            logger.error(f"LuluStream extraction failed for {url}: {e}")
            return None

    def _unpack_packer(self, packed_js: str) -> Optional[str]:
        """Simple LuluStream-specific Packer unpacker logic."""
        try:
            # Extract p, a, c, k, e, d
            match = re.search(r"}\s*\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*)'\.split\('\|'\)", packed_js)
            if not match:
                return None
            
            p, a, c, k = match.groups()
            a = int(a)
            c = int(c)
            k = k.split('|')
            
            def baseN(num, b):
                if num == 0: return '0'
                digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                res = ""
                while num:
                    res = digits[num % b] + res
                    num //= b
                return res

            # Replacement logic
            for i in range(c - 1, -1, -1):
                if k[i]:
                    p = re.sub(r'\b' + baseN(i, a) + r'\b', k[i], p)
            
            return p
        except Exception as e:
            logger.error(f"LuluStream: Packer unpacking failed: {e}")
            return None
