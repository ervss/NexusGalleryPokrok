"""
Central catalog: external search source keys, UI metadata, and URL classification for library health.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

# Keys handled by ExternalSearchEngine per-source / multi-source discovery
DISCOVERY_SEARCH_SOURCE_KEYS = frozenset({
    "erome",
    "kemono",
    "xvideos",
    "pornhub",
    "eporner",
    "whoreshub",
    "porntrex",
    "bunkr",
    "gofile",
    "spankbang",
    "xhamster",
    "ixxx",
    "noodlemagazine",
})

SOURCE_KEY_ALIASES: Dict[str, str] = {
    "ph": "pornhub",
    "pornhub.com": "pornhub",
    "xb": "xvideos",
    "xvideos.com": "xvideos",
    "xvideos.red": "xvideos",
    "sb": "spankbang",
    "spankbang.com": "spankbang",
    "pt": "porntrex",
    "porntrex.com": "porntrex",
    "wh": "whoreshub",
    "whoreshub.com": "whoreshub",
    "ep": "eporner",
    "eporner.com": "eporner",
    "erome.com": "erome",
    "coomer": "kemono",
    "kemono.party": "kemono",
    "kemono.su": "kemono",
    "gofile.io": "gofile",
    "xh": "xhamster",
    "xhamster.com": "xhamster",
    "xhamster4.com": "xhamster",
    "ixxx.com": "ixxx",
    "www.ixxx.com": "ixxx",
    "noodlemagazine.com": "noodlemagazine",
    "nm": "noodlemagazine",
}

# API + discovery UI (id must be a canonical DISCOVERY_SEARCH_SOURCE_KEYS member)
DISCOVERY_SOURCE_OPTIONS: List[Dict[str, Any]] = [
    {"id": "erome", "label": "Erome", "has_search": True},
    {"id": "kemono", "label": "Kemono / Coomer", "has_search": True},
    {"id": "xvideos", "label": "XVideos", "has_search": True},
    {"id": "pornhub", "label": "Pornhub", "has_search": True},
    {"id": "eporner", "label": "Eporner", "has_search": True},
    {"id": "whoreshub", "label": "WhoresHub", "has_search": True},
    {"id": "porntrex", "label": "PornTrex", "has_search": True},
    {"id": "bunkr", "label": "Bunkr (mirrors)", "has_search": True},
    {"id": "gofile", "label": "GoFile", "has_search": True},
    {"id": "spankbang", "label": "SpankBang", "has_search": True},
    {"id": "xhamster", "label": "xHamster", "has_search": True},
    {"id": "ixxx", "label": "iXXX", "has_search": True},
]

# Extractors / playback without a dedicated row in DISCOVERY_SOURCE_OPTIONS (search-only elsewhere)
EXTRACT_ONLY_SOURCE_NOTES: List[Dict[str, str]] = [
    {"id": "vk", "label": "VK", "note": "Import URL only"},
    {"id": "nsfw247", "label": "NSFW247", "note": "Import URL only"},
    {"id": "turbo", "label": "Turbo", "note": "Import URL only"},
    {"id": "tnaflix", "label": "Tnaflix", "note": "Import URL only"},
    {"id": "pornone", "label": "PornOne", "note": "Import URL only"},
    {"id": "redgifs", "label": "RedGIFs", "note": "Import URL only"},
    {"id": "hqporner", "label": "HQPorner", "note": "Import URL only"},
    {"id": "beeg", "label": "Beeg", "note": "Import URL only"},
    {"id": "pixeldrain", "label": "Pixeldrain", "note": "Import URL only"},
    {"id": "noodlemagazine", "label": "NoodleMagazine", "note": "Import URL only"},
]

# Ordered: first substring match wins (specific before generic)
_LIBRARY_URL_SOURCE_RULES: Tuple[Tuple[str, str], ...] = (
    ("eporner.com", "Eporner"),
    ("xvideos.com", "XVideos"),
    ("xvideos.red", "XVideos"),
    ("spankbang.com", "SpankBang"),
    ("pornhub.com", "Pornhub"),
    ("porntrex.com", "PornTrex"),
    ("whoreshub.com", "WhoresHub"),
    ("xhamster.com", "xHamster"),
    ("xhamster4.com", "xHamster"),
    ("ixxx.com", "iXXX"),
    ("noodlemagazine.com", "NoodleMagazine"),
    ("erome.com", "Erome"),
    ("kemono.", "Kemono"),
    ("coomer.", "Kemono"),
    ("simpcity.", "SimpCity"),
    ("gofile.io", "Gofile"),
    ("pixeldrain.com", "Pixeldrain"),
    ("webshare.cz", "Webshare"),
    ("webshare.", "Webshare"),
    ("wsfiles.cz", "Webshare"),
    ("bunkr.", "Bunkr"),
    ("bunkrr.", "Bunkr"),
    ("turbo.cr", "Turbo"),
    ("vk.com", "VK"),
    ("vk.video", "VK"),
    ("vkvideo.", "VK"),
    ("okcdn.ru", "VK"),
    ("nsfw247.", "NSFW247"),
    ("redgifs.com", "RedGIFs"),
    ("hqporner.com", "HQPorner"),
    ("beeg.com", "Beeg"),
    ("tnaflix.com", "Tnaflix"),
    ("pornone.com", "PornOne"),
)


def normalize_search_source_key(raw: Optional[str]) -> Optional[str]:
    """Return canonical discovery search key, or None if 'all' / unknown."""
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s or s in ("all", "*", "any"):
        return None
    s = SOURCE_KEY_ALIASES.get(s, s)
    for suf in (".com", ".net", ".su", ".io", ".cz", ".to", ".cr", ".la", ".party", ".red", ".black"):
        if s.endswith(suf):
            base = s[: -len(suf)]
            if base in DISCOVERY_SEARCH_SOURCE_KEYS:
                return base
            s = base
            break
    return s if s in DISCOVERY_SEARCH_SOURCE_KEYS else None


def filter_valid_discovery_sources(raw_list: Optional[List[Any]]) -> List[str]:
    """Deduplicated list of canonical search keys."""
    if not raw_list:
        return []
    out: List[str] = []
    for item in raw_list:
        if item is None:
            continue
        k = normalize_search_source_key(str(item).strip())
        if k and k not in out:
            out.append(k)
    return out


def classify_library_source_name(url: Optional[str], source_url: Optional[str] = None) -> str:
    """Bucket name for /api/health/sources (aligned with previous dashboard labels)."""
    for candidate in (source_url, url):
        if not candidate:
            continue
        low = candidate.lower()
        for needle, label in _LIBRARY_URL_SOURCE_RULES:
            if needle in low:
                return label
    return "Unknown"


def unknown_domain_from_urls(url: Optional[str], source_url: Optional[str] = None) -> Optional[str]:
    """If classification is Unknown, return registrable hostname for backlog stats."""
    if classify_library_source_name(url, source_url) != "Unknown":
        return None
    for candidate in (source_url, url):
        if not candidate or not candidate.startswith(("http://", "https://")):
            continue
        try:
            netloc = urlparse(candidate).netloc.lower()
            if netloc.startswith("www."):
                netloc = netloc[4:]
            if netloc:
                return netloc
        except Exception:
            continue
    return None
