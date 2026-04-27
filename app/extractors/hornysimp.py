import re
from typing import Any, Dict, Optional

from .leakporner import LeakPornerExtractor


class HornySimpExtractor(LeakPornerExtractor):
    @property
    def name(self) -> str:
        return "HornySimp"

    def can_handle(self, url: str) -> bool:
        low = (url or "").lower()
        return "hornysimp" in low

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        result = await super().extract(url)
        if not result:
            return None

        # Normalize site identity and title suffixes when reusing LeakPorner logic.
        result["uploader"] = "HornySimp"
        title = str(result.get("title") or "")
        title = re.sub(r"\s*-\s*(?:leakporner|hornysimp)\s*$", "", title, flags=re.I).strip()
        result["title"] = title or "HornySimp Video"
        if not result.get("description"):
            result["description"] = result["title"]

        return result
