from fastapi import FastAPI, Depends, UploadFile, File, BackgroundTasks, HTTPException, Request, Response, Body, WebSocket, WebSocketDisconnect, APIRouter, Header
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse, RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import distinct, desc, asc, or_
import re
import time
from typing import Any, List, Optional
from pydantic import BaseModel
import datetime
import os
from dotenv import load_dotenv

load_dotenv()
from .config import config
from .logging_setup import configure_logging

configure_logging(config.LOG_LEVEL, config.LOG_JSON)

import aiohttp
import httpx
import json
import base64
import urllib.parse
import requests
import shutil
import subprocess
import yt_dlp
import asyncio
import logging

from .database import get_db, init_db, Video, SmartPlaylist, SessionLocal, SearchHistory, DiscoveryProfile, DiscoveryNotification, DiscoveredVideo
# FIX: Odstránené nefunkčné importy (PornOne, JD)
from contextlib import asynccontextmanager
from .services import VIPVideoProcessor, search_videos_by_subtitle, get_batch_stats, get_tags_stats, get_quality_stats, extract_playlist_urls, fetch_eporner_videos, scrape_eporner_discovery
from .porntrex_discovery import scrape_porntrex_discovery
from .whoreshub_discovery import scrape_whoreshub_discovery
from .leakporner_discovery import scrape_leakporner_discovery
from .search_engine import ExternalSearchEngine
from .websockets import manager
import collections
from .telegram_auth import manager as tg_auth_manager
from pydantic import BaseModel
import collections
from scripts.archivist import Archivist
from .scheduler import init_scheduler, get_scheduler, shutdown_scheduler
from .auto_discovery import run_discovery_profile, get_worker

# Initialize Archivist
archivist = Archivist(download_dir="app/static/local_videos")


# --- WINDOWS ASYNCIO FIX ---
# Suppress known asyncio error in _ProactorBaseWritePipeTransport._loop_writing
# "AssertionError: assert f is self._write_fut"
import sys
if sys.platform == 'win32':
    try:
        from asyncio.proactor_events import _ProactorBaseWritePipeTransport
        _original_loop_writing = _ProactorBaseWritePipeTransport._loop_writing
        def _safe_loop_writing(self, *args, **kwargs):
            try:
                return _original_loop_writing(self, *args, **kwargs)
            except AssertionError:
                return None
        _ProactorBaseWritePipeTransport._loop_writing = _safe_loop_writing
    except (ImportError, AttributeError):
        pass
# ---------------------------




http_session = None
# Env reload trigger 3

_PLACEHOLDER_JPG_PATH = os.path.join("app", "static", "placeholder.jpg")
_PLACEHOLDER_JPG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUWFhUV"
    "FRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0lICYtLS0tLS0tLS0t"
    "LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/"
    "xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFhEBAQEAAAAAAAAAAAAAAAAAAQAC/9oADAMBAAIQ"
    "AxAAAAHhAqf/xAAbEAADAQEBAQEAAAAAAAAAAAABAhEDEiExQf/aAAgBAQABBQJrM8qS2g1K8VxP"
    "x//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8BP//EABQRAQAAAAAAAAAAAAAAAAAAABD/"
    "2gAIAQIBAT8BP//EABwQAAICAgMBAAAAAAAAAAAAAAECEQMhMUFREv/aAAgBAQAGPwLQ0bA0XJY7"
    "vT//xAAaEAACAwEBAAAAAAAAAAAAAAABEQAhMUFh/9oACAEBAAE/ITqFpnHzV0p2N1cXv//aAAwD"
    "AQACAAMAAAAQ8//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QP//EABQRAQAAAAAAAAAA"
    "AAAAAAAAABD/2gAIAQIBAT8QP//EABwQAQACAgMBAAAAAAAAAAAAAAERIQAxQVFhcf/aAAgBAQAB"
    "PxBklx6wvLhTjD3l0C4i6msYu//Z"
)


def _ensure_static_placeholder_assets() -> None:
    try:
        placeholder_dir = os.path.dirname(_PLACEHOLDER_JPG_PATH)
        os.makedirs(placeholder_dir, exist_ok=True)
        if not os.path.exists(_PLACEHOLDER_JPG_PATH) or os.path.getsize(_PLACEHOLDER_JPG_PATH) == 0:
            with open(_PLACEHOLDER_JPG_PATH, "wb") as handle:
                handle.write(base64.b64decode(_PLACEHOLDER_JPG_B64))
            logging.info("Created missing static placeholder asset at %s", _PLACEHOLDER_JPG_PATH)
    except Exception as exc:
        logging.warning("Failed to ensure static placeholder asset: %s", exc)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_session
    _ensure_static_placeholder_assets()
    # Increase limits for many concurrent video streams
    # Use a robust resolver to handle domains with DNS issues (like nsfwclips.co)
    # Falls back to default resolver if aiodns/pycares DLL is blocked by OS policy
    try:
        resolver = aiohttp.AsyncResolver(nameservers=["8.8.8.8", "8.8.4.4", "1.1.1.1"])
        connector = aiohttp.TCPConnector(limit=200, limit_per_host=50, keepalive_timeout=60, resolver=resolver)
    except RuntimeError:
        print("WARNING: aiodns unavailable, using default resolver (DNS may be slower)")
        connector = aiohttp.TCPConnector(limit=200, limit_per_host=50, keepalive_timeout=60)
    timeout = aiohttp.ClientTimeout(total=None, connect=60, sock_read=600)
    http_session = aiohttp.ClientSession(connector=connector, timeout=timeout)
    print("AIOHTTP ClientSession created with increased limits.")
    
    # --- CLEANUP STUCK TASKS ON STARTUP ---
    try:
        db = SessionLocal()
        stuck_videos = db.query(Video).filter(or_(Video.status == 'processing', Video.status == 'downloading')).all()
        if stuck_videos:
            print(f"Startup: Resetting {len(stuck_videos)} stuck videos to 'error' state.")
            for v in stuck_videos:
                v.status = 'error' # Or 'ready' if we want to be optimistic, but 'error' prompts retry
            db.commit()
        db.close()
    except Exception as e:
        print(f"Startup cleanup error: {e}")
        
    # --- STARTUP LINK REFRESH (Always Live) ---
    async def refresh_video_link(video_id: int):
        """Refreshes the URL for a single video."""
        db = SessionLocal()
        try:
            v = db.query(Video).filter(Video.id == video_id).first()
            if not v or not v.source_url or v.storage_type != 'remote':
                return

            # Basic check if link is responsive
            try:
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
                async with http_session.head(v.url, timeout=5, headers=headers, ssl=False) as r:
                    if r.status < 400:
                        v.last_checked = datetime.datetime.now()
                        db.commit()
                        return # Link is still good
            except Exception:
                pass # Link is not responsive, proceed to refresh

            print(f"Refreshing: {v.title} (ID: {v.id})")
            
            # --- ATTEMPT HEALING VIA CUSTOM EXTRACTORS ---
            try:
                from .extractors.registry import ExtractorRegistry
                # Ensure extractors are registered (they might not be if this is a fresh worker)
                from .extractors.bunkr import BunkrExtractor as NewBunkrExtractor
                if not ExtractorRegistry.find_extractor("https://bunkr.si/v/test"):
                    ExtractorRegistry.register(NewBunkrExtractor())
                
                # ... register others if needed ...

                plugin = ExtractorRegistry.find_extractor(v.source_url or v.url)
                if plugin:
                    print(f"Using plugin {plugin.name} to heal {v.id}")
                    res = await plugin.extract(v.source_url or v.url)
                    if res and res.get('stream_url'):
                        v.url = res['stream_url']
                        v.last_checked = datetime.datetime.now()
                        db.commit()
                        print(f"Successfully healed via plugin {plugin.name}: {v.title}")
                        return
            except Exception as pe:
                print(f"Plugin healing failed for {v.id}: {pe}")

            # --- FALLBACK TO YT-DLP ---
            try:
                user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                opts = {
                    'quiet': True, 'skip_download': True, 'format': 'best', 
                    'user_agent': user_agent,
                    'ignoreerrors': True,
                    'no_warnings': True,
                    'http_headers': {
                        'User-Agent': user_agent,
                        'Referer': v.source_url or "https://www.google.com/"
                    }
                }
                
                # Apply domain-specific cookies
                src_url = (v.source_url or "").lower()
                if "xvideos.com" in src_url and os.path.exists("xvideos.cookies.txt"):
                    opts['cookiefile'] = 'xvideos.cookies.txt'
                elif "eporner.com" in src_url and os.path.exists("eporner.cookies.txt"):
                    opts['cookiefile'] = 'eporner.cookies.txt'
                
                def get_info():
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        return ydl.extract_info(v.source_url or v.url, download=False)
                info = await asyncio.to_thread(get_info)
                if info and info.get('url'):
                    v.url = info['url']
                    v.last_checked = datetime.datetime.now()
                    db.commit()
                    print(f"Successfully refreshed via yt-dlp: {v.title}")
                else:
                    print(f"Could not get new URL for {v.title}")
            except Exception as e:
                db.rollback()
                print(f"Error refreshing {v.title}: {e}")
        except Exception as e:
            if "has been deleted" not in str(e):
                print(f"Error in refresh_video_link for video {video_id}: {e}")
        finally:
            db.close()

    async def refresh_links_task():
        """A background task that refreshes older links on startup to ensure they work."""
        await asyncio.sleep(5)  # Wait for full startup
        print("Startup: Link refresher started.")
        try:
            db_query = SessionLocal()
            # Get IDs of 100 oldest videos
            video_ids = [v[0] for v in db_query.query(Video.id).order_by(Video.last_checked.asc().nullsfirst()).limit(100).all()]
            db_query.close()
            
            if not video_ids:
                return

            print(f"Startup: Refreshing {len(video_ids)} oldest links...")
            for vid in video_ids:
                try:
                    await refresh_video_link(vid)
                    await asyncio.sleep(0.5) # Slight throttle
                except Exception as e:
                    if "has been deleted" not in str(e):
                        print(f"Error refreshing video {vid}: {e}")
            
            print("Startup: Link refresher finished.")
        except Exception as e:
            print(f"Link refresher loop error: {e}")

    # Disabled to speed up startup - can be manually triggered if needed
    # asyncio.create_task(refresh_links_task())
        
    # --- START WEBSOCKET PULSE ---
    async def pulse_task():
        while True:
            await asyncio.sleep(30)
            await manager.pulse()
    
    asyncio.create_task(pulse_task())

    # --- CONFIGURE GOFILE TOKEN ---
    gofile_token = config.GOFILE_TOKEN
    if gofile_token:
        try:
            from app.extractors.gofile import GoFileExtractor
            GoFileExtractor.set_user_token(gofile_token)
            print(f"GoFile user token configured (length: {len(gofile_token)})")
        except Exception as e:
            print(f"Failed to configure GoFile token: {e}")

    # --- INITIALIZE TASK SCHEDULER ---
    try:
        from .extractors import register_extended_extractors
        register_extended_extractors()
        scheduler = init_scheduler()
        print("Task scheduler and all extractors initialized")

        # Load and schedule all enabled discovery profiles
        db = SessionLocal()
        try:
            enabled_profiles = db.query(DiscoveryProfile).filter(DiscoveryProfile.enabled == True).all()
            for profile in enabled_profiles:
                try:
                    if profile.schedule_type == "interval":
                        interval_seconds = int(profile.schedule_value)
                        scheduler.add_interval_job(
                            run_discovery_profile,
                            job_id=f"profile_{profile.id}",
                            seconds=interval_seconds,
                            description=f"Discovery: {profile.name}",
                            args=(profile.id,)
                        )
                        print(f"Scheduled profile '{profile.name}' (every {interval_seconds}s)")
                    elif profile.schedule_type == "cron":
                        scheduler.add_cron_job(
                            run_discovery_profile,
                            job_id=f"profile_{profile.id}",
                            cron_expression=profile.schedule_value,
                            description=f"Discovery: {profile.name}",
                            args=(profile.id,)
                        )
                        print(f"Scheduled profile '{profile.name}' (cron: {profile.schedule_value})")
                except Exception as e:
                    print(f"Failed to schedule profile '{profile.name}': {e}")
        finally:
            db.close()
    except Exception as e:
        print(f"Scheduler initialization error: {e}")

    yield

    # --- SHUTDOWN ---
    try:
        shutdown_scheduler(wait=True)
        print("Task scheduler shutdown")
    except Exception as e:
        print(f"Scheduler shutdown error: {e}")

    if http_session:
        await http_session.close()
        print("AIOHTTP ClientSession closed.")

app = FastAPI(title="Quantum VIP Dashboard", lifespan=lifespan)
init_db()

# --- API ROUTING MODULARIZATION ---
api_v1_router = APIRouter(prefix="/api/v1")
api_legacy_router = APIRouter(prefix="/api")

from .routers import duplicates as _routes_duplicates
from .routers import library_health as _routes_library_health
from .routers import maintenance_endpoints as _routes_maintenance
from .routers import smart_playlists as _routes_smart_playlists

for _r in (
    _routes_duplicates.router,
    _routes_maintenance.router,
    _routes_library_health.router,
    _routes_smart_playlists.router,
):
    api_v1_router.include_router(_r)
    api_legacy_router.include_router(_r)

# --- Webshare Search Model ---
class WebshareSearchRequest(BaseModel):
    query: str
    limit: int = 20
    sort: str = "recent"
    min_size: Optional[int] = None
    max_size: Optional[int] = None
    offset: int = 0

@api_v1_router.post("/webshare/search")
@api_legacy_router.post("/webshare/search")
async def search_webshare(req: WebshareSearchRequest):
    """
    Search Webshare for files and return results sorted by quality (size).
    """
    try:
        from extractors.webshare import WebshareAPI
        # We can eventually load token from .env or DB settings if we want protected files
        ws = WebshareAPI(token=None) 
        
        # Run synchronous request in thread pool
        # Pass sort parameter to search_files
        search_resp = await asyncio.to_thread(ws.search_files, req.query, req.limit, req.sort, req.offset)
        
        results = search_resp.get('results', [])
        total_count = search_resp.get('total', 0)
        
        # Filter results by size if requested
        if req.min_size or req.max_size:
            filtered = []
            for r in results:
                size = r.get('size_bytes', 0)
                if req.min_size and size < req.min_size: continue
                if req.max_size and size > req.max_size: continue
                filtered.append(r)
            results = filtered
            
        return {"status": "success", "results": results, "total": total_count}
    except Exception as e:
        print(f"Webshare API endpoint error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/webshare/import")
@api_legacy_router.post("/webshare/import")
async def import_webshare(url: str = Body(..., embed=True), batch_name: str = Body(None), db: Session = Depends(get_db)):
    """
    Import a video directly from a Webshare link string, create Video entry, trigger processing, and return status.
    """
    try:
        # 1. Create Video entry
        from .database import Video
        video = Video(
            url=url,
            source_url=url,
            title="Webshare import",
            status="queued",
            batch_name=batch_name or "Webshare Import",
            storage_type="remote"
        )
        db.add(video)
        db.commit()
        db.refresh(video)

        # 2. Trigger processing (VIP link, thumbnail, etc.)
        from .services import VIPVideoProcessor
        processor = VIPVideoProcessor()
        import threading
        threading.Thread(target=processor.process_single_video, args=(video.id,)).start()

        return {"status": "success", "video_id": video.id}
    except Exception as e:
        db.rollback()
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


# --- Password & Session ---
DASHBOARD_PASSWORD = config.DASHBOARD_PASSWORD
SECRET_KEY = config.SECRET_KEY

from fastapi.middleware.cors import CORSMiddleware
from .middleware_request_id import RequestIdMiddleware

# Starlette: last add_middleware = outermost = runs first on incoming request.
# RequestId must be added last so request_id is set before Session/CORS run.
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)
_cors_kw = {
    "allow_origins": config.CORS_ORIGINS,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}
_cors_kw["allow_credentials"] = False if config.CORS_ORIGINS == ["*"] else True
app.add_middleware(CORSMiddleware, **_cors_kw)
app.add_middleware(RequestIdMiddleware)


app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

# --- Models ---
class VideoExport(BaseModel):
    id: int
    title: str
    url: str
    duration: float
    width: int
    height: int
    tags: str
    ai_tags: str
    created_at: datetime.datetime
    views: Optional[int] = 0
    upload_date: Optional[str] = None
    download_stats: Optional[dict] = None
    storage_type: Optional[str] = "remote"
    status: Optional[str] = "pending"
    batch_name: Optional[str] = None
    class Config:
        from_attributes = True

class ImportRequest(BaseModel):
    urls: List[str]
    items: Optional[List[dict]] = None
    batch_name: Optional[str] = None
    parser: Optional[str] = None
    min_quality: Optional[int] = None
    min_duration: Optional[int] = None
    auto_heal: Optional[bool] = True

class XVideosImportRequest(BaseModel):
    url: str

class SpankBangImportRequest(BaseModel):
    url: str

class BatchActionRequest(BaseModel):
    video_ids: List[int]
    action: str

class BatchRefreshRequest(BaseModel):
    batch_name: str

class BatchDeleteRequest(BaseModel):
    batch_name: str

class VideoUpdate(BaseModel):
    is_favorite: Optional[bool] = None
    is_watched: Optional[bool] = None
    resume_time: Optional[float] = None
    tags: Optional[str] = None
    url: Optional[str] = None          # allow extension to push fresh stream URL

class EpornerSearchRequest(BaseModel):
    query: str
    count: int = 50
    min_quality: int = 1080
    batch_name: Optional[str] = None

class EpornerDiscoveryRequest(BaseModel):
    keyword: str
    min_quality: int = 1080
    pages: int = 2
    auto_skip_low_quality: bool = True
    batch_name: Optional[str] = None


class PorntrexDiscoveryRequest(BaseModel):
    keyword: str = ""
    min_quality: int = 1080
    pages: int = 1
    category: str = ""
    upload_type: str = "all"
    auto_skip_low_quality: bool = True
    batch_name: Optional[str] = None


class WhoresHubDiscoveryRequest(BaseModel):
    keyword: str = ""
    tag: str = ""
    min_quality: int = 720
    min_duration: int = 300  # 5 minutes
    pages: int = 1
    upload_type: str = "all"
    auto_skip_low_quality: bool = True
    batch_name: Optional[str] = None


class LeakPornerDiscoveryRequest(BaseModel):
    keyword: str = ""
    pages: int = 1
    min_duration: int = 0
    sort: str = "latest"
    batch_name: Optional[str] = None


class TelegramLoginRequest(BaseModel):
    api_id: str
    api_hash: str
    phone: str

class TelegramVerifyRequest(BaseModel):
    code: str
    password: str = None

class RedGifsImportRequest(BaseModel):
    keywords: str
    count: int = 20
    hd_only: bool = False
    min_duration: int = 30
    min_resolution: int = 1080
    only_vertical: bool = False
    disable_rejection: bool = False
    batch_name: Optional[str] = None

class RedditImportRequest(BaseModel):
    subreddits: str  # Comma separated
    count: int = 20
    hd_only: bool = False
    min_duration: int = 30
    min_resolution: int = 1080
    only_vertical: bool = False
    disable_rejection: bool = False
    batch_name: Optional[str] = None

class PornOneImportRequest(BaseModel):
    keywords: str
    count: int = 20
    min_duration: int = 30
    min_resolution: int = 1080
    only_vertical: bool = False
    batch_name: Optional[str] = None
    debug: bool = False

class XVideosPlaylistImportRequest(BaseModel):
    url: str
    batch_name: Optional[str] = None

class HQPornerImportRequest(BaseModel):
    keywords: str = ""
    category: Optional[str] = None
    min_quality: str = "1080p"
    added_within: str = "any"
    count: int = 20
    batch_name: Optional[str] = None

class TnaflixImportRequest(BaseModel):
    url: Optional[str] = None
    query: Optional[str] = None
    count: int = 20
    min_duration: int = 0
    min_quality: int = 0
    batch_name: Optional[str] = None

class BeegImportRequest(BaseModel):
    query: str
    count: int = 10
    batch_name: Optional[str] = None

# --- Routes ---

@app.get("/login", response_class=HTMLResponse)
async def login_form(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})

class LoginRequest(BaseModel):
    password: str

@app.post("/login")
async def login_submit(request: Request, login_request: LoginRequest):
    if login_request.password == DASHBOARD_PASSWORD:
        request.session["authenticated"] = True
        return Response(status_code=200)
    raise HTTPException(status_code=401, detail="Invalid password")

@app.get("/logout")
async def logout(request: Request):
    request.session.pop("authenticated", None)
    return RedirectResponse(url="/login")

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/discovery", response_class=HTMLResponse)
async def discovery_page(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("discovery.html", {"request": request})

@app.get("/discovery/review/{profile_id}", response_class=HTMLResponse)
async def discovery_review_page(request: Request, profile_id: int):
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("discovery_review.html", {"request": request, "profile_id": profile_id})

@app.get("/v2", response_class=HTMLResponse)
async def read_v2(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/login", status_code=303)
# This route can be used to directly preview the V2 UI
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/stats", response_class=HTMLResponse)
async def get_stats_page(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("stats.html", {"request": request})

@app.get("/favicon.ico")
def favicon(): return Response(status_code=204)

@app.post("/api/v1/pornhoarder/update_stream")
@app.post("/api/v1/videos/update_stream")
async def pornhoarder_update_stream(payload: dict, db: Session = Depends(get_db)):
    """Receives direct stream URL from PornHoarder browser interceptor content script."""
    source_url = (payload.get("source_url") or "").strip()
    stream_url = (payload.get("stream_url") or "").strip()
    source = (payload.get("source") or "pornhoarder").strip().lower()
    title = (payload.get("title") or "").strip()

    def _title_from_source(url: str) -> str:
        try:
            from urllib.parse import urlparse, unquote
            path = urlparse(url or "").path
            # /watch/<slug>/<token>
            parts = [p for p in path.split("/") if p]
            if "watch" in parts:
                i = parts.index("watch")
                if i + 1 < len(parts):
                    return unquote(parts[i + 1]).replace("-", " ").strip().title()
            if parts:
                return unquote(parts[-1]).replace("-", " ").strip().title()
        except Exception:
            pass
        return ""

    if not source_url:
        return {"status": "error", "message": "missing fields"}
    if not stream_url:
        stream_url = source_url

    def _looks_like_stream(url: str) -> bool:
        u = (url or "").strip().lower()
        if not u.startswith(("http://", "https://")):
            return False
        return (
            bool(re.search(r"\.(mp4|m3u8|mpd)(\?|$)", u))
            or "/api/v1/proxy/hls?url=" in u
            or "/hls_proxy?url=" in u
        )

    resolved_stream = stream_url
    resolved_title = title
    resolved_thumbnail = ""
    resolved_duration = 0
    resolved_player_url = ""

    # For browser-captured providers, try extractor once:
    # - resolves non-playable captures/player URLs to direct streams
    # - fills metadata for clean dashboard cards.
    is_known_source = source in ("pornhoarder", "recurbate", "leakporner", "djav", "vidara", "vidsonic", "vidfast", "lulustream", "luluvid", "luluvdo", "lulu.stream", "sxyprn", "krakenfiles")
    is_vidara_stream = any(d in stream_url.lower() for d in ("vidara.so", "vidsonic.net", "vidfast.co"))
    is_lulu_stream = any(d in stream_url.lower() for d in ("lulustream", "luluvid", "luluvdo", "lulu.stream"))

    if is_known_source or is_vidara_stream or is_lulu_stream:
        try:
            extractor = None
            if source == "pornhoarder":
                from .extractors.pornhoarder import PornHoarderExtractor
                extractor = PornHoarderExtractor()
            elif source in ("leakporner", "djav"):
                from .extractors.leakporner import LeakPornerExtractor
                extractor = LeakPornerExtractor()
            elif source in ("vidara", "vidsonic", "vidfast") or is_vidara_stream:
                from .extractors.vidara import VidaraExtractor
                extractor = VidaraExtractor()
            elif source in ("lulustream", "luluvid", "luluvdo", "lulu.stream") or is_lulu_stream:
                from .extractors.lulustream import LuluStreamExtractor
                extractor = LuluStreamExtractor()
            elif source == "krakenfiles" or "krakenfiles.com" in stream_url.lower():
                from .extractors.krakenfiles import KrakenFilesExtractor
                extractor = KrakenFilesExtractor()
            elif source == "sxyprn" or "sxyprn.com" in stream_url.lower():
                from .extractors.sxyprn import SxyPrnExtractor
                extractor = SxyPrnExtractor()
            elif source == "recurbate":
                from .extractors.recurbate import RecurbateExtractor
                extractor = RecurbateExtractor()
            
            if extractor:
                # If title is generic or missing, we MUST extract to get real metadata
                is_generic_title = not resolved_title or any(x in resolved_title.lower() for x in (">external link!<", "krakenfiles.com", "vidara.so", "vidsonic", "vidfast"))
                
                # Use source_url for extraction if available, otherwise stream_url
                extraction_url = source_url or stream_url
                
                # Use source_url if it's from the same domain, otherwise use stream_url
                target_url = source_url if (source in extractor.name.lower() or extractor.can_handle(source_url)) else stream_url
                
                # Special case for Vidara/Lulu embedded on other sites
                if not extractor.can_handle(target_url) and is_vidara_stream:
                    target_url = stream_url
                
                extracted = await extractor.extract(target_url)
                if extracted:
                    candidate = (extracted.get("stream_url") or "").strip()
                    if (
                        candidate and
                        _looks_like_stream(candidate) and
                        "player.php" not in candidate.lower() and
                        (not _looks_like_stream(stream_url) or "player.php" in stream_url.lower())
                    ):
                        resolved_stream = candidate
                    if (is_generic_title or not resolved_title):
                        ext_title = (extracted.get("title") or "").strip()
                        if ext_title: resolved_title = ext_title
                    resolved_thumbnail = (extracted.get("thumbnail") or "").strip()
                    resolved_duration = int(extracted.get("duration") or 0)
                    resolved_player_url = (extracted.get("player_url") or "").strip()
                    
                    # Detect quality
                    if any(x in (resolved_title + stream_url).lower() for x in ("1080", "fhd", "ultra")):
                        quality = "FHD"
                    elif any(x in (resolved_title + stream_url).lower() for x in ("720", "hd")):
                        quality = "HD"
                    elif extracted.get("quality"):
                        quality = extracted.get("quality")
        except Exception as exc:
            logging.warning(f"[StreamCapture] stream resolve failed for {source_url}: {exc}")

    # Server-side smart filter: Reject previews/thumbs
    if any(x in resolved_stream.lower() for x in ("vidthumb", "preview", "small.mp4", "get_preview")):
        logging.info(f"[StreamCapture] Rejected preview stream: {resolved_stream}")
        return {"status": "ignored", "message": "preview_detected"}

    # Final title cleanup
    if resolved_title:
        # Remove common artifacts
        for artifact in (">External Link!<", "krakenfiles.com", "vidara.so", "vidsonic.net", "vidfast.co", "sxyprn.com", "vidfast.co", "vidsonic.net"):
            resolved_title = re.sub(re.escape(artifact), "", resolved_title, flags=re.IGNORECASE)
        resolved_title = resolved_title.strip(" -|")
        if not resolved_title:
            resolved_title = _title_from_source(source_url) or f"{source.capitalize()} Video"

    # Detect quality and try to get file size
    resolved_quality = "SD"
    if any(x in (resolved_title + resolved_stream).lower() for x in ("1080", "fhd", "ultra", "1440", "4k")):
        resolved_quality = "FHD"
    elif any(x in (resolved_title + resolved_stream).lower() for x in ("720", "hd")):
        resolved_quality = "HD"

    file_size_mb = 0
    try:
        import httpx
        with httpx.Client(timeout=3) as client:
            h_resp = client.head(resolved_stream, follow_redirects=True)
            if h_resp.status_code < 400:
                content_length = int(h_resp.headers.get("Content-Length", 0))
                if content_length > 0:
                    file_size_mb = round(content_length / (1024 * 1024), 1)
                    logging.info(f"[StreamCapture] Detected file size: {file_size_mb} MB")
    except Exception:
        pass

    if not _looks_like_stream(resolved_stream):
        logging.warning(f"[PH-Interceptor] Rejected non-playable stream URL: {resolved_stream[:120]}")
        return {"status": "error", "message": "non_playable_stream", "stream_url": resolved_stream[:200]}

    def _queue_thumbnail_processing(video_id: int) -> None:
        try:
            processor = VIPVideoProcessor()
            import threading
            threading.Thread(
                target=processor.process_single_video,
                args=(video_id,),
                daemon=True,
            ).start()
        except Exception as exc:
            logging.warning(f"[PH-Interceptor] Failed to queue thumbnail processing for {video_id}: {exc}")

    video = db.query(Video).filter(Video.source_url == source_url).order_by(Video.id.desc()).first()
    if not video:
        video = db.query(Video).filter(Video.url == source_url).order_by(Video.id.desc()).first()
    if video:
        logging.info(f"[PH-Interceptor] Updating stream for video {video.id}: {resolved_stream[:80]}")
        video.url = resolved_stream
        video.status = "ready_to_stream"
        if resolved_quality:
            video.quality = resolved_quality
        if file_size_mb > 0:
            video.file_size_mb = file_size_mb
        if resolved_title and (not video.title or any(x in str(video.title).lower() for x in ("untitled", "queued", ">external link!<"))):
            video.title = resolved_title
        if resolved_duration > 0 and not (video.duration or 0):
            video.duration = float(resolved_duration)
        if resolved_thumbnail and not video.thumbnail_path:
            video.thumbnail_path = resolved_thumbnail
        if resolved_player_url:
            stats = video.download_stats or {}
            stats["player_url"] = resolved_player_url
            video.download_stats = stats
            try:
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(video, "download_stats")
            except Exception:
                pass
        db.commit()
        # Ensure preview thumbnail is generated for interceptor-only entries.
        if not video.thumbnail_path:
            _queue_thumbnail_processing(video.id)
        return {"status": "ok", "video_id": video.id, "stream_url": resolved_stream}
    logging.info(f"[PH-Interceptor] No video found for source_url, creating new one: {source_url}")
    new_video = Video(
        title=resolved_title or _title_from_source(source_url) or f"{source.capitalize()} Video",
        url=resolved_stream,
        source_url=source_url,
        thumbnail_path=resolved_thumbnail or None,
        duration=float(resolved_duration or 0),
        height=0,
        width=0,
        batch_name=f"{source.capitalize()} Interceptor",
        tags=source,
        storage_type="remote",
        status="ready_to_stream",
        quality=resolved_quality,
        file_size_mb=file_size_mb,
        download_stats=({"player_url": resolved_player_url} if resolved_player_url else None),
    )
    db.add(new_video)
    db.commit()
    db.refresh(new_video)
    _queue_thumbnail_processing(new_video.id)
    return {"status": "created", "video_id": new_video.id, "stream_url": resolved_stream}


@app.get("/health")
def health_check():
    """Basic health check endpoint."""
    return {"status": "healthy", "service": "Quantum VIP Dashboard", "timestamp": datetime.datetime.utcnow().isoformat()}

@app.get("/health/db")
def health_check_db():
    """Database health check with detailed statistics."""
    from .database import get_db_health, get_migration_version
    
    db_health = get_db_health()
    migration_info = get_migration_version()
    
    return {
        "database": db_health,
        "migrations": migration_info,
        "timestamp": datetime.datetime.utcnow().isoformat()
    }

@app.get("/health/pool")
def health_check_pool():
    """Connection pool statistics."""
    from .database import engine
    
    pool = engine.pool
    return {
        "pool_size": pool.size(),
        "checked_in_connections": pool.checkedin(),
        "checked_out_connections": pool.checkedout(),
        "overflow_connections": pool.overflow(),
        "max_overflow": pool._max_overflow if hasattr(pool, '_max_overflow') else 0,
        "timestamp": datetime.datetime.utcnow().isoformat()
    }


@api_v1_router.get("/videos")
@api_legacy_router.get("/videos")
def get_videos(page: int = 1, limit: int = 10, search: str = "", batch: str = "All", favorites_only: bool = False, quality: str = "All", duration_min: int = 0, duration_max: int = 99999, sort: str = "date_desc", dateMin: Optional[str] = None, dateMax: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(Video)
    # Filter out videos without titles to prevent frontend errors
    query = query.filter(Video.title != None, Video.title != "")
    if search: query = query.filter(or_(Video.title.contains(search), Video.tags.contains(search), Video.ai_tags.contains(search), Video.batch_name.contains(search)))
    if batch and batch != "All": query = query.filter(Video.batch_name == batch)
    if favorites_only: query = query.filter(Video.is_favorite == True)
    query = query.filter(Video.duration >= duration_min)
    if duration_max < 3600: query = query.filter(Video.duration <= duration_max)
    if quality != "All":
        if quality == "4K": query = query.filter(Video.height >= 2160)
        elif quality == "1440p": query = query.filter(Video.height >= 1440, Video.height < 2160)
        elif quality in ["1080p", "FHD"]: query = query.filter(Video.height >= 1080, Video.height < 1440)
        elif quality in ["720p", "HD"]: query = query.filter(Video.height >= 720, Video.height < 1080)
        elif quality == "SD": query = query.filter(Video.height < 720)
    
    if dateMin:
        try: query = query.filter(Video.created_at >= datetime.datetime.fromisoformat(dateMin))
        except ValueError: pass
    if dateMax:
        try: query = query.filter(Video.created_at < datetime.datetime.fromisoformat(dateMax) + datetime.timedelta(days=1))
        except ValueError: pass

    if sort == "date_desc": query = query.order_by(desc(Video.id))
    elif sort == "title_asc": query = query.order_by(asc(Video.title))
    elif sort == "longest": query = query.order_by(desc(Video.duration))
    elif sort == "shortest": query = query.order_by(asc(Video.duration))
    
    videos = query.offset((page - 1) * limit).limit(limit).all()
    
    # Note: Beeg video auto-refresh was removed from GET /videos to prevent thread spam and NameErrors.
    # Link refresh should be handled via a dedicated scheduled task or JIT during playback.
    
    # Convert to dicts and add gif_preview_path
    results = []
    for v in videos:
        video_dict = v.__dict__
        video_dict.pop('_sa_instance_state', None) # Remove SQLAlchemy state
        # Double-check title exists before adding to results
        if video_dict.get('title'):
            results.append(video_dict)
        
    return results

@api_v1_router.get("/export")
@api_legacy_router.get("/export")
def export_videos(search: str = "", batch: str = "All", favorites_only: bool = False, quality: str = "All", duration_min: int = 0, duration_max: int = 99999, sort: str = "date_desc", dateMin: Optional[str] = None, dateMax: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(Video)
    if search: query = query.filter(or_(Video.title.contains(search), Video.tags.contains(search), Video.ai_tags.contains(search), Video.batch_name.contains(search)))
    if batch and batch != "All": query = query.filter(Video.batch_name == batch)
    if favorites_only: query = query.filter(Video.is_favorite == True)
    query = query.filter(Video.duration >= duration_min)
    if duration_max < 3600: query = query.filter(Video.duration <= duration_max)
    if quality != "All":
        if quality == "4K": query = query.filter(Video.height >= 2160)
        elif quality == "1440p": query = query.filter(Video.height >= 1440, Video.height < 2160)
        elif quality in ["1080p", "FHD"]: query = query.filter(Video.height >= 1080, Video.height < 1440)
        elif quality in ["720p", "HD"]: query = query.filter(Video.height >= 720, Video.height < 1080)
        elif quality == "SD": query = query.filter(Video.height < 720)
    
    if dateMin:
        try: query = query.filter(Video.created_at >= datetime.datetime.fromisoformat(dateMin))
        except ValueError: pass
    if dateMax:
        try: query = query.filter(Video.created_at < datetime.datetime.fromisoformat(dateMax) + datetime.timedelta(days=1))
        except ValueError: pass

    if sort == "date_desc": query = query.order_by(desc(Video.id))
    elif sort == "title_asc": query = query.order_by(asc(Video.title))
    elif sort == "longest": query = query.order_by(desc(Video.duration))
    elif sort == "shortest": query = query.order_by(asc(Video.duration))
    
    videos = query.all()
    content = [VideoExport.from_orm(v).dict() for v in videos]
    return JSONResponse(content=content, headers={'Content-Disposition': f'attachment; filename="export.json"'})

@api_v1_router.get("/search/subtitles")
@api_legacy_router.get("/search/subtitles")
def search_subs(query: str, db: Session = Depends(get_db)):
    return search_videos_by_subtitle(query, db)

@api_v1_router.get("/search/external")
@api_legacy_router.get("/search/external")
async def search_external(query: str, source: Optional[str] = None):
    """
    Search external sources (SimpCity, Telegram, etc.) for media content.
    Returns aggregated results from all available sources.
    """
    if not query or len(query.strip()) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters")
    
    try:
        engine = ExternalSearchEngine()
        results = await engine.search(query.strip(), source=source)
        
        # Save to history
        db = next(get_db())
        try:
            history_entry = SearchHistory(
                query=query.strip(),
                source="Quantum",
                results_count=len(results)
            )
            db.add(history_entry)
            db.commit()
        except Exception as ex:
            print(f"Failed to save search history: {ex}")
        
        return {
            "query": query,
            "total_results": len(results),
            "sources": list(set(r['source'] for r in results)),
            "results": results
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")
    
@api_v1_router.get("/batches")
@api_legacy_router.get("/batches")
def get_batches(db: Session = Depends(get_db), sort: str = "name", detailed: bool = False):
    """Get all batches with optional sorting

    Args:
        sort: Sorting method - 'name' (alphabetical), 'newest' (most recent video), 'biggest' (video count)
        detailed: If True, return detailed batch info (name, size, import_date)
    """
    from sqlalchemy import func

    # Get all videos with their batch and stats to calculate total size accurately
    all_videos = db.query(Video.batch_name, Video.download_stats, Video.created_at).filter(Video.batch_name.isnot(None)).all()
    
    batch_stats = {}
    for batch_name, d_stats, created_at in all_videos:
        if not batch_name: continue
        if batch_name not in batch_stats:
            batch_stats[batch_name] = {
                'count': 0, 
                'total_size_mb': 0.0, 
                'first_import': created_at, 
                'last_import': created_at
            }
        
        s = batch_stats[batch_name]
        s['count'] += 1
        if d_stats and isinstance(d_stats, dict) and d_stats.get('size_mb'):
            s['total_size_mb'] += float(d_stats['size_mb'])
        
        if created_at:
            if not s['first_import'] or created_at < s['first_import']:
                s['first_import'] = created_at
            if not s['last_import'] or created_at > s['last_import']:
                s['last_import'] = created_at

    # Convert to list of dicts with metadata
    batches_with_info = []
    for name, s in batch_stats.items():
        total_mb = round(s['total_size_mb'], 2)
        batches_with_info.append({
            'name': name,
            'size': s['count'], # For backwards compatibility (represents video count)
            'total_size_mb': total_mb,
            'size_text': f"{total_mb / 1024:.1f} GB" if total_mb > 1024 else f"{int(total_mb)} MB",
            'import_date': s['first_import'].isoformat() if s['first_import'] else None,
            'last_updated': s['last_import'].isoformat() if s['last_import'] else None
        })

    # Apply sorting
    if sort == "name":
        batches_with_info.sort(key=lambda x: x['name'])
    elif sort == "newest":
        batches_with_info.sort(key=lambda x: x['last_updated'] or '', reverse=True)
    elif sort == "biggest":
        batches_with_info.sort(key=lambda x: x['size'], reverse=True)
    elif sort == "size": # Actual file size
        batches_with_info.sort(key=lambda x: x['total_size_mb'], reverse=True)
    else:
        batches_with_info.sort(key=lambda x: x['name'])

    # Return detailed info if requested, otherwise just names for backwards compatibility
    if detailed:
        return batches_with_info
    else:
        return [b['name'] for b in batches_with_info]

@api_v1_router.get("/tags")
@api_legacy_router.get("/tags")
def get_all_tags(db: Session = Depends(get_db)):
    all_tags = set()
    videos = db.query(Video.tags, Video.ai_tags).filter(or_(Video.tags != None, Video.ai_tags != None)).all()
    for video_tags, video_ai_tags in videos:
        if video_tags: all_tags.update(tag.strip() for tag in video_tags.split(',') if tag.strip())
        if video_ai_tags: all_tags.update(tag.strip() for tag in video_ai_tags.split(',') if tag.strip())
    return sorted(list(all_tags))

# --- Config Endpoints ---
@api_v1_router.get("/config/gofile_token")
@api_legacy_router.get("/config/gofile_token")
async def get_gofile_token():
    """Return the configured GoFile user token so extensions can reuse it."""
    from .extractors.gofile import GoFileExtractor
    token = GoFileExtractor._user_token or (config.GOFILE_TOKEN or "")
    return {"token": token}

# Extension-specific capture hosts not already covered by source_catalog rules.
# Add new entries here to extend interception without updating the extension package.
_EXTENSION_EXTRA_CAPTURE_HOSTS: list[str] = [
    "recurbate.com", "rec-ur-bate.com", "vidara.so", "sxyprn.com",
    "krakenfiles.com", "hornysimp.com", "nsfw247.to", "fullporner.com",
]

@api_v1_router.get("/config/supported_hosts")
@api_legacy_router.get("/config/supported_hosts")
async def get_supported_hosts():
    """Return the canonical list of hostnames that the browser extension should
    intercept.  The extension fetches this on startup and hourly so that new
    sources can be added here without needing to update the extension package."""
    from .source_catalog import _LIBRARY_URL_SOURCE_RULES
    # Build a de-duplicated list of bare hostnames from the source catalog rules.
    # We expose only real hostnames (those that contain a dot) so the extension
    # can do exact hostname matching rather than substring matching.
    seen: set[str] = set()
    hosts: list[str] = []
    for needle, _ in _LIBRARY_URL_SOURCE_RULES:
        host = needle.lstrip(".")
        if "." in host and host not in seen:
            seen.add(host)
            hosts.append(host)
    for h in _EXTENSION_EXTRA_CAPTURE_HOSTS:
        if h not in seen:
            seen.add(h)
            hosts.append(h)
    return {"hosts": hosts}

# --- Stats Endpoints ---
@api_v1_router.get("/stats/batches")
@api_legacy_router.get("/stats/batches")
def api_get_batch_stats(db: Session = Depends(get_db)): return get_batch_stats(db)

@api_v1_router.get("/stats/tags")
@api_legacy_router.get("/stats/tags")
def api_get_tags_stats(db: Session = Depends(get_db)): return get_tags_stats(db)

@api_v1_router.get("/stats/quality")
@api_legacy_router.get("/stats/quality")
def api_get_quality_stats(db: Session = Depends(get_db)): return get_quality_stats(db)

@api_v1_router.get("/search/history")
@api_legacy_router.get("/search/history")
def get_search_history(limit: int = 10, db: Session = Depends(get_db)):
    return db.query(SearchHistory).order_by(desc(SearchHistory.created_at)).limit(limit).all()



def refresh_video_link(video_id: int):
    """Refresh a single video's link by re-extracting from source_url"""
    db = SessionLocal()
    try:
        v = db.query(Video).get(video_id)
        if not v or not v.source_url:
            return
        
        # For XVideos, use the dedicated extractor which prioritizes HLS quality
        if 'xvideos.com' in v.source_url:
            processor = VIPVideoProcessor()
            meta = processor.extract_xvideos_metadata(v.source_url)
            if meta and meta.get('stream') and meta['stream'].get('url'):
                v.url = meta['stream']['url']
                if meta['stream'].get('height'):
                    v.height = meta['stream']['height']
                db.commit()
                logging.info(f"Refreshed link for video {video_id}")
                return
        
        # Beeg Refresh Support - URLs expire quickly
        if 'beeg.com' in (v.source_url or ""):
            try:
                import subprocess
                
                # Use fast refresh script
                cmd = [sys.executable, "beeg_refresh.py", v.source_url]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                
                if result.returncode == 0:
                    new_stream_url = result.stdout.strip()
                    
                    if new_stream_url and new_stream_url.startswith('http'):
                        # Parse HLS if needed
                        if 'multi=' in new_stream_url:
                            import aiohttp
                            async def get_best_quality():
                                async with aiohttp.ClientSession() as session:
                                    async with session.get(new_stream_url) as resp:
                                        if resp.status == 200:
                                            playlist = await resp.text()
                                            lines = playlist.split('\n')
                                            best_url = None
                                            best_bandwidth = 0
                                            
                                            for i, line in enumerate(lines):
                                                if line.startswith('#EXT-X-STREAM-INF'):
                                                    bw_match = re.search(r'BANDWIDTH=(\d+)', line)
                                                    if bw_match and i + 1 < len(lines):
                                                        bandwidth = int(bw_match.group(1))
                                                        url = lines[i + 1].strip()
                                                        if url and bandwidth > best_bandwidth:
                                                            best_bandwidth = bandwidth
                                                            if not url.startswith('http'):
                                                                base = '/'.join(new_stream_url.split('/')[:-1])
                                                                best_url = f"{base}/{url}"
                                                            else:
                                                                best_url = url
                                            return best_url
                                return None
                            
                            # Run async function
                            import asyncio
                            best_url = asyncio.run(get_best_quality())
                            if best_url:
                                new_stream_url = best_url
                        
                        v.url = new_stream_url
                        v.last_checked = datetime.datetime.now()
                        db.commit()
                        logging.info(f"Refreshed Beeg link for video {video_id}")
                        return
            except Exception as e:
                logging.error(f"Beeg refresh failed: {e}")
        
        # Webshare Refresh Support
        if 'webshare.cz' in (v.source_url or "") or 'wsfiles.cz' in (v.source_url or "") or (v.url and v.url.startswith("webshare:")):
            try:
                from extractors.webshare import WebshareAPI
                ws = WebshareAPI()
                ident = None
                
                # Try to find ident
                src = v.source_url or v.url
                if src.startswith("webshare:"):
                    ident = src.split(":", 2)[1]
                elif "/file/" in src:
                    part = src.split('/file/')[1]
                    ident = part.split('/')[0] if '/' in part else part
                
                if not ident and 'wsfiles.cz' in src:
                     parts = src.split('/')
                     for p in parts:
                         if len(p) == 10 and p.isalnum() and not p.isdigit():
                             ident = p
                             break
                
                if ident:
                    new_link = ws.get_vip_link(ident)
                    if new_link:
                        v.url = new_link
                        db.commit()
                        logging.info(f"Refreshed Webshare link for video {video_id}")
                        return
            except Exception as e:
                logging.error(f"Webshare refresh failed: {e}")

        # For other sources, use standard extraction
        cookie_file = 'xvideos.cookies.txt' if 'xvideos.com' in v.source_url else None
        is_deep = 'xvideos.com' in v.source_url or 'xhamster.com' in v.source_url or 'eporner.com' in v.source_url
        opts = {
            'quiet': True, 'skip_download': True, 
            # Prioritize HLS for best quality
            'format': 'best[protocol*=m3u8]/best[ext=mp4]/best',
            'extract_flat': False if is_deep else True
        }
        if cookie_file and os.path.exists(cookie_file):
            opts['cookiefile'] = cookie_file
        
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(v.source_url, download=False)
        
        if info and info.get('url'):
            v.url = info['url']
            # Update height if available
            if info.get('height'):
                v.height = info['height']
            db.commit()
            logging.info(f"Refreshed link for video {video_id}")
    except Exception as e:
        logging.error(f"Failed to refresh link for video {video_id}: {e}")
        db.rollback()
    finally:
        db.close()

@api_v1_router.post("/batch-action")
@api_legacy_router.post("/batch-action")
def batch_action(req: BatchActionRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    query = db.query(Video).filter(Video.id.in_(req.video_ids))
    if req.action == 'delete': query.delete(synchronize_session=False)
    elif req.action == 'favorite': query.update({Video.is_favorite: True}, synchronize_session=False)
    elif req.action == 'unfavorite': query.update({Video.is_favorite: False}, synchronize_session=False)
    elif req.action == 'mark_watched': query.update({Video.is_watched: True}, synchronize_session=False)
    elif req.action == 'refresh_links':
        # Refresh links in background as it's time-consuming
        video_ids = req.video_ids.copy()
        def refresh_batch_links():
            for video_id in video_ids:
                refresh_video_link(video_id)
        bg_tasks.add_task(refresh_batch_links)
        db.commit()
        return {"status": "ok", "message": f"Refreshing links for {len(video_ids)} videos in background"}
    
    db.commit()
    return {"status": "ok"}

@api_v1_router.post("/batch/refresh")
@api_legacy_router.post("/batch/refresh")
def refresh_entire_batch(req: BatchRefreshRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Refresh all video links for an entire batch in the background.
    """
    if not req.batch_name or req.batch_name == "All":
        raise HTTPException(status_code=400, detail="A specific batch name is required.")
    
    video_ids_query = db.query(Video.id).filter(Video.batch_name == req.batch_name).all()
    video_ids = [v_id for v_id, in video_ids_query]

    if not video_ids:
        return {"status": "ok", "message": "No videos found in this batch."}

    # Use the same background task pattern as batch_action
    def refresh_batch_links():
        for video_id in video_ids:
            refresh_video_link(video_id)

    bg_tasks.add_task(refresh_batch_links)
    
    logging.info(f"Queued link refresh for {len(video_ids)} videos in batch '{req.batch_name}'.")
    
    return {"status": "ok", "message": f"Refreshing links for {len(video_ids)} videos in batch '{req.batch_name}' in the background."}


@api_v1_router.post("/batch/delete-all")
@api_legacy_router.post("/batch/delete-all")
def delete_entire_batch(req: BatchDeleteRequest, db: Session = Depends(get_db)):
    if not req.batch_name or req.batch_name == "All": raise HTTPException(400)
    db.query(Video).filter(Video.batch_name == req.batch_name).delete(synchronize_session=False)
    db.commit()
    return {"status": "deleted", "batch": req.batch_name}

@api_v1_router.put("/videos/{video_id}")
@api_legacy_router.put("/videos/{video_id}")
def update_video(video_id: int, update: VideoUpdate, db: Session = Depends(get_db)):
    v = db.query(Video).get(video_id)
    if not v: raise HTTPException(404)
    if update.is_favorite is not None: v.is_favorite = update.is_favorite
    if update.is_watched is not None: v.is_watched = update.is_watched
    if update.resume_time is not None: v.resume_time = update.resume_time
    if update.tags is not None: v.tags = update.tags
    if update.url is not None and update.url.startswith("http"):
        logging.info("[URL-push] video %s url updated by extension: %s", video_id, update.url[:100])
        v.url = update.url
    db.commit()
    return v

@api_v1_router.post("/videos/{video_id}/regenerate")
@api_legacy_router.post("/videos/{video_id}/regenerate")
def regenerate_thumbnail(video_id: int, bg_tasks: BackgroundTasks, mode: str = "mp4", extractor: str = "auto", db: Session = Depends(get_db)):
    v = db.query(Video).get(video_id)
    if not v: raise HTTPException(404)
    v.status = "pending"
    v.error_msg = None
    db.commit()
    processor = VIPVideoProcessor()
    bg_tasks.add_task(processor.process_single_video, video_id, force=True, quality_mode=mode, extractor=extractor)
    return {"status": "queued", "id": video_id}

@api_v1_router.post("/videos/{video_id}/refresh")
@api_legacy_router.post("/videos/{video_id}/refresh")
def refresh_video_url(video_id: int, db: Session = Depends(get_db)):
    """Refresh video URL (useful for Beeg and other sources with expiring links)"""
    v = db.query(Video).get(video_id)
    if not v: raise HTTPException(404)
    
    # Call refresh in a thread to avoid blocking
    import threading
    def do_refresh():
        refresh_video_link(video_id)
    
    thread = threading.Thread(target=do_refresh)
    thread.start()
    
    return {"status": "refreshing", "id": video_id, "message": "Link refresh started"}

import re

# ... existing code ...

active_downloads = {}

@api_v1_router.get("/downloads/active")
@api_legacy_router.get("/downloads/active")
def get_active_downloads():
    return active_downloads

def run_aria_download(video_id: int):
    db = SessionLocal()
    v = db.query(Video).get(video_id)
    if not v:
        db.close()
        return

    try:
        output_dir = os.path.join("app", "static", "local_videos")
        os.makedirs(output_dir, exist_ok=True)
        
        # Sanitize filename
        safe_title = "".join([c for c in v.title if c.isalnum() or c in (' ','-','_')]).strip().replace(' ', '_')
        safe_filename = f"video_{video_id}_{safe_title[:50]}.mp4"
        
        is_hls = ".m3u8" in v.url.lower()
        
        if is_hls:
            # Use FFmpeg for HLS streams to produce a single playable MP4
            command = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", v.url, "-c", "copy", "-bsf:a", "aac_adtstoasc",
                os.path.join(output_dir, safe_filename)
            ]
            print(f"Starting HLS Download for video {video_id} via FFmpeg...")
        else:
            aria2c_path = "aria2c.exe"
            if not os.path.isfile(aria2c_path):
                 aria2c_path = os.path.join("app", "aria2c.exe")
            
            # If aria2c is still not found, fall back to Archivist downloader instead of crashing
            if not os.path.isfile(aria2c_path):
                print("aria2c binary not found, falling back to Archivist downloader.")
                v.status = "downloading"
                db.commit()
                batch_folder = Archivist.sanitize_component(v.batch_name or "General", default="General")
                success = asyncio.run(archivist.download_file(v.url, "Legacy", batch_folder, safe_filename))
                if success:
                    v.status = "ready"
                    v.storage_type = "local"
                    v.url = f"/static/local_videos/Legacy/{batch_folder}/{safe_filename}"
                else:
                    v.status = "error"
                    v.error_msg = "aria2c not installed and Archivist fallback failed."
                db.commit()
                return
            
            command = [
                aria2c_path,
                "--file-allocation=none",
                "--continue=true",
                "--max-connection-per-server=32",
                "--split=32",
                "--min-split-size=512K",
                "--dir", output_dir,
                "--out", safe_filename,
                v.url
            ]
            print(f"Starting Turbo Download for video {video_id}: {' '.join(command)}")

        # Init progress
        active_downloads[video_id] = 0
        start_time = datetime.datetime.now()
        speed_samples = []
        final_total_mb = 0

        process = subprocess.Popen(
            command, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.STDOUT, 
            text=True, 
            encoding='utf-8', 
            errors='ignore',
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )

        # Regex for Aria2c progress: ( 35%)
        # Example output: [#2089b0 10MiB/20MiB(50%) CN:1 DL:1.2MiB]
        progress_pattern = re.compile(r'\((\d+)%\)')
        detailed_pattern = re.compile(
            r'(?P<done>[\d\.]+)(?P<done_unit>[KMG]?i?B)/(?P<total>[\d\.]+)(?P<total_unit>[KMG]?i?B)\('
            r'(?P<percent>\d+)%\).*DL:(?P<speed>[\d\.]+)(?P<speed_unit>[KMG]?i?B)'
        )

        def _to_mb(value: float, unit: str) -> float:
            unit = unit.upper()
            if unit.startswith('K'):
                return value / 1024.0
            if unit.startswith('G'):
                return value * 1024.0
            # default MiB
            return value

        while True:
            line = process.stdout.readline()
            if not line and process.poll() is not None:
                break

            if not line:
                continue

            m_full = detailed_pattern.search(line)
            if m_full:
                try:
                    done = float(m_full.group('done'))
                    done_unit = m_full.group('done_unit')
                    total = float(m_full.group('total'))
                    total_unit = m_full.group('total_unit')
                    percent = int(m_full.group('percent'))
                    speed = float(m_full.group('speed'))
                    speed_unit = m_full.group('speed_unit')

                    done_mb = _to_mb(done, done_unit)
                    total_mb = _to_mb(total, total_unit)
                    speed_mb_s = _to_mb(speed, speed_unit)
                    
                    final_total_mb = total_mb
                    if speed_mb_s > 0:
                        speed_samples.append(speed_mb_s)

                    active_downloads[video_id] = {
                        "percent": percent,
                        "downloaded_mb": round(done_mb, 1),
                        "total_mb": round(total_mb, 1),
                        "speed_mb_s": round(speed_mb_s, 1),
                    }
                except Exception:
                    # Fall back to simple percent parsing below on any error
                    pass

            # Fallback: only percent known or older aria2c formats
            if video_id not in active_downloads or isinstance(active_downloads[video_id], (int, float)):
                m = progress_pattern.search(line)
                if m:
                    try:
                        percent = int(m.group(1))
                        active_downloads[video_id] = percent
                    except Exception:
                        pass

        rc = process.poll()

        if rc == 0:
            v.status = "ready"
            v.storage_type = "local"
            v.url = f"/static/local_videos/{safe_filename}"
            # Calculate and save download stats
            end_time = datetime.datetime.now()
            duration_sec = (end_time - start_time).total_seconds()
            avg_speed = sum(speed_samples) / len(speed_samples) if speed_samples else 0
            max_speed = max(speed_samples) if speed_samples else 0
            
            # If total_mb was not captured correctly, try to get file size
            if final_total_mb == 0 and os.path.exists(output_dir + "/" + safe_filename):
                final_total_mb = os.path.getsize(output_dir + "/" + safe_filename) / (1024 * 1024)
            
            # Recalculate average speed more accurately based on size/time if available
            if duration_sec > 0 and final_total_mb > 0:
                avg_speed = final_total_mb / duration_sec
                
            v.download_stats = {
                "avg_speed_mb": round(avg_speed, 2),
                "max_speed_mb": round(max_speed, 2),
                "time_sec": round(duration_sec, 2),
                "size_mb": round(final_total_mb, 2),
                "date": end_time.isoformat()
            }
        else:
            # Fallback to Archivist if Aria2c fails or for specific streams
            v.status = "downloading"
            db.commit()
            batch_folder = Archivist.sanitize_component(v.batch_name or "General", default="General")
            success = asyncio.run(archivist.download_file(v.url, "Legacy", batch_folder, safe_filename))
            if success:
                v.status = "ready"
                v.storage_type = "local"
                v.url = f"/static/local_videos/Legacy/{batch_folder}/{safe_filename}"
                v.download_stats = {"note": "Downloaded via Legacy Archivist (no stats)"}
            else:
                v.status = "error"
                v.error_msg = f"Aria2c exited with code {rc} and Archivist fallback failed."
        
        db.commit()

    except Exception as e:
        print(f"Error in run_aria_download for video {video_id}: {e}")
        v.status = "error"
        v.error_msg = str(e)
        db.commit()
    finally:
        if video_id in active_downloads:
            del active_downloads[video_id]
        db.close()

@api_v1_router.post("/videos/{video_id}/download")
@api_legacy_router.post("/videos/{video_id}/download")
async def manual_download_video(video_id: int, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    v = db.query(Video).get(video_id)
    if not v:
        raise HTTPException(404, "Video not found")
    
    if not v.url.startswith("http"):
        return {"status": "already_local", "video_id": video_id}

    v.status = 'downloading'
    db.commit()
    
    bg_tasks.add_task(run_aria_download, video_id)
    
    return {"status": "download_queued", "video_id": video_id}

class ExternalDownloadRequest(BaseModel):
    url: str
    title: Optional[str] = "External Download"

@api_v1_router.post("/download/external")
@api_legacy_router.post("/download/external")
async def download_external_video(req: ExternalDownloadRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Imports an external URL (if new) and immediately triggers aria2c download.
    """
    # Check if already exists by source_url or url
    v = db.query(Video).filter(or_(Video.source_url == req.url, Video.url == req.url)).first()
    
    if not v:
        # Create new video entry
        v = Video(
            title=req.title, 
            url=req.url, 
            source_url=req.url, 
            batch_name=f"Download_{datetime.datetime.now().strftime('%d.%m')}", 
            status="pending"
        )
        db.add(v)
        db.commit()
        db.refresh(v)
        VIPVideoProcessor().broadcast_new_video(v)
    else:
        # If it exists but is local, return
        if not v.url.startswith("http"):
             return {"status": "already_local", "video_id": v.id}
    
    v.status = 'ready_to_stream' # Import as metadata only
    db.commit()
    
    
    bg_tasks.add_task(VIPVideoProcessor().process_single_video, v.id)
    
    return {"status": "imported", "video_id": v.id, "message": "Imported as Remote Metadata"}

# --- BRIDGE EXTENSION ENDPOINTS ---

class BridgeSyncRequest(BaseModel):
    url: str
    cookies: Optional[str] = None
    user_agent: Optional[str] = None
    html_content: Optional[str] = None

def ensure_bridge_token(x_nexus_token: Optional[str]) -> None:
    """If NEXUS_BRIDGE_TOKEN is configured, require matching X-Nexus-Token header."""
    required_token = config.NEXUS_BRIDGE_TOKEN
    if not required_token:
        return
    if not x_nexus_token or x_nexus_token.strip() != required_token:
        raise HTTPException(status_code=401, detail="Invalid bridge token")

@api_v1_router.get("/bridge/ping")
@api_legacy_router.get("/bridge/ping")
async def bridge_ping(x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    ensure_bridge_token(x_nexus_token)
    return {"status": "ok", "service": "bridge"}

@api_v1_router.post("/bridge/sync")
@api_legacy_router.post("/bridge/sync")
async def bridge_sync(req: BridgeSyncRequest, x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """
    Receives session data (cookies, ua) from Chrome Extension.
    Saves to domain-specific cookie files.
    """
    domain = urllib.parse.urlparse(req.url).netloc
    
    # Security: whitelist allowed domains to prevent cookie dumping abuse
    # For now allow all, but good to keep in mind
    ensure_bridge_token(x_nexus_token)
    
    if req.cookies:
        # Simple heuristic to map domain to cookie filename
        filename = "cookies.txt" # Default
        if "bunkr" in domain: filename = "bunkr.cookies.txt"
        elif "xvideos" in domain: filename = "xvideos.cookies.txt"
        elif "simpcity" in domain: filename = "simpcity.cookies.txt"
        
        # Save cookies in Netscape format (simplified) or raw header format
        # yt-dlp prefers Netscape, but raw header file also works if passed as --add-header
        # We will save as raw key=value string for requests lib and maybe convert for yt-dlp later
        # Actually, for this prototype, we just save the 'Cookie' header string to a file
        # that our Extractors can read and inject into requests headers.
        
        with open(filename, 'w') as f:
            f.write(req.cookies)
            
        # --- CONVERT TO NETSCAPE FOR YT-DLP ---
        try:
            netscape_name = filename.replace(".cookies.txt", ".netscape.txt") if ".cookies.txt" in filename else "cookies.netscape.txt"
            with open(netscape_name, 'w') as f:
                f.write("# Netscape HTTP Cookie File\n")
                # Domain should start with . for wildcards
                dot_domain = f".{domain}" if not domain.startswith(".") else domain
                # Format: domain, flag, path, secure, expiration, name, value
                # Since we have raw string "a=b; c=d", we split and guess
                pairs = [p.strip() for p in req.cookies.split(';') if '=' in p]
                expiry = str(int(datetime.datetime.now().timestamp()) + 86400 * 30) # +30 days
                for p in pairs:
                    name, val = p.split('=', 1)
                    f.write(f"{dot_domain}\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{val}\n")
            logging.info(f"Bridge: Converted to Netscape: {netscape_name}")
        except Exception as e:
            logging.error(f"Cookie conversion failed: {e}")

        logging.info(f"Bridge: Saved cookies for {domain} to {filename}")

    return {"status": "synced", "domain": domain}

class BridgeImportRequest(BaseModel):
    urls: List[str]
    batch_name: str = "Bridge Import"
    cookies: Optional[str] = None # Optional overriding cookies

@api_v1_router.post("/bridge/import")
@api_legacy_router.post("/bridge/import")
async def bridge_import(req: BridgeImportRequest, bg_tasks: BackgroundTasks, x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """
    Import URLs specifically from the extension, possibly with fresh cookies.
    """
    ensure_bridge_token(x_nexus_token)
    if req.cookies:
         # If import request comes with cookies (e.g. from Bunkr album page)
         # Save them generically as 'latest_bridge.cookies.txt'
         with open("bridge.cookies.txt", "w") as f:
             f.write(req.cookies)
    
    bg_tasks.add_task(background_import_process, req.urls, req.batch_name, "yt-dlp", None, None, None, True)
    return {"status": "ok", "count": len(req.urls)}


class BulkImportVideo(BaseModel):
    url: str
    title: Optional[str] = None
    source_url: Optional[str] = None
    thumbnail: Optional[str] = None
    filesize: Optional[Any] = 0
    quality: Optional[Any] = 0  # may arrive as "720p", "HD", or int
    duration: Optional[Any] = 0  # may arrive as "0:16" string or seconds float
    tags: Optional[str] = ""

    def quality_px(self) -> int:
        q = self.quality
        if isinstance(q, int): return q
        if isinstance(q, float): return int(q)
        if isinstance(q, str):
            m = re.search(r'\d+', q)
            return int(m.group()) if m else 0
        return 0

    def duration_secs(self) -> float:
        d = self.duration
        if isinstance(d, (int, float)): return float(d)
        if isinstance(d, str):
            parts = [p for p in d.replace(',', ':').split(':') if p.strip()]
            try:
                parts = [int(x) for x in parts]
                if len(parts) == 3: return parts[0]*3600 + parts[1]*60 + parts[2]
                if len(parts) == 2: return parts[0]*60 + parts[1]
                if len(parts) == 1: return float(parts[0])
            except: pass
        return 0.0

    def filesize_bytes(self) -> int:
        s = self.filesize
        if isinstance(s, (int, float)):
            return int(s)
        if isinstance(s, str):
            t = s.strip().upper().replace(",", ".")
            try:
                m = re.search(r"([\d.]+)\s*(TB|GB|MB|KB|B)?", t)
                if not m:
                    return int(float(re.sub(r"[^\d.]", "", t)))
                val = float(m.group(1))
                unit = (m.group(2) or "B").upper()
                mult = {
                    "B": 1,
                    "KB": 1024,
                    "MB": 1024 * 1024,
                    "GB": 1024 * 1024 * 1024,
                    "TB": 1024 * 1024 * 1024 * 1024,
                }
                return int(val * mult.get(unit, 1))
            except Exception:
                return 0
        return 0

class BulkImportRequest(BaseModel):
    batch_name: str = "Bulk Import"
    videos: List[BulkImportVideo]

@api_v1_router.post("/import/bulk")
@api_legacy_router.post("/import/bulk")
async def import_bulk(req: BulkImportRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Bulk import pre-scraped video metadata from extensions (gofile explorer, etc.).
    Each video entry already has direct URL + metadata — no yt-dlp needed.
    """
    from .database import Video
    from .services import VIPVideoProcessor
    from .extractors.bunkr import BunkrExtractor
    from .extractors.camwhores import CamwhoresExtractor
    from .extractors.archivebate import ArchivebateExtractor
    from .extractors.recurbate import RecurbateExtractor

    async def _head_content_length(url: str, referer: Optional[str]) -> int:
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "*/*",
            }
            if referer:
                headers["Referer"] = referer
            async with httpx.AsyncClient(timeout=12, follow_redirects=True, verify=False) as client:
                resp = await client.head(url, headers=headers)
                content_len = resp.headers.get("Content-Length")
                if content_len and str(content_len).isdigit():
                    return int(content_len)
                # Niektoré CDN ignorujú HEAD, skúšame malé GET
                headers["Range"] = "bytes=0-0"
                resp = await client.get(url, headers=headers)
                content_range = resp.headers.get("Content-Range", "")
                m = re.search(r"/(\d+)$", content_range)
                if m:
                    return int(m.group(1))
                content_len = resp.headers.get("Content-Length")
                if content_len and str(content_len).isdigit():
                    return int(content_len)
        except Exception:
            pass
        return 0

    new_ids = []
    processor = VIPVideoProcessor()
    bunkr_extractor = BunkrExtractor()
    camwhores_extractor = CamwhoresExtractor()
    archivebate_extractor = ArchivebateExtractor()
    recurbate_extractor = RecurbateExtractor()
    for v in req.videos:
        existing = db.query(Video).filter(Video.url == v.url).first()
        if existing:
            continue

        title = v.title or "Queued..."
        stream_url = v.url
        source_url = v.source_url or v.url
        thumbnail = v.thumbnail
        duration = v.duration_secs()
        height = v.quality_px()
        width = 0
        filesize = v.filesize_bytes()
        status = "pending"

        # Filester extension often sends:
        # - url = https://filester.../d/<id>   (file page, good for extraction/refresh)
        # - source_url = https://filester.../f/<id> (folder page)
        # Use the file page as source_url so refresh/proxy can resolve a playable stream.
        stream_low = (stream_url or "").lower()
        source_low = (source_url or "").lower()
        is_filester_file_page = "filester." in stream_low and "/d/" in stream_low
        if is_filester_file_page and ("filester." in source_low and "/f/" in source_low):
            source_url = stream_url

        is_bunkr = "bunkr" in (stream_url or "").lower() or "bunkr" in (source_url or "").lower() or "scdn.st" in (stream_url or "").lower()
        if is_bunkr:
            # Correct Referer for Bunkr CDN: must be from a bunkr.* domain root, not CDN itself
            def _bunkr_cdn_referer(url_hint: str) -> str:
                try:
                    import urllib.parse as _up
                    p = _up.urlparse(url_hint or "")
                    h = p.netloc.lower()
                    if h and "bunkr" in h:
                        return f"{p.scheme}://{p.netloc}/"
                except Exception:
                    pass
                return "https://bunkr.cr/"

            # Prefer /f/ page URL as source_url; CDN URLs are ephemeral streams
            source_candidate = source_url if ("/f/" in (source_url or "") or "/v/" in (source_url or "")) else None
            if source_candidate and bunkr_extractor.can_handle(source_candidate):
                try:
                    meta = await bunkr_extractor.extract(source_candidate)
                    if meta and meta.get("stream_url"):
                        stream_url = meta.get("stream_url") or stream_url
                        source_url = source_candidate
                        if (not title or title.lower().startswith("queued")) and meta.get("title"):
                            title = meta.get("title")
                        if not thumbnail and meta.get("thumbnail"):
                            thumbnail = meta.get("thumbnail")
                        duration = duration or float(meta.get("duration") or 0)
                        width = int(meta.get("width") or 0)
                        height = height or int(meta.get("height") or 0)
                except Exception as e:
                    logging.warning(f"Bunkr pre-import extract failed for {source_candidate}: {e}")

            # CDN Referer: use bunkr domain root (scdn.st is NOT accepted as Referer by its own CDN)
            cdn_ref = _bunkr_cdn_referer(source_url or stream_url)
            ff_meta = {"duration": duration, "height": height, "width": width}
            ff_meta = processor._ffprobe_fallback(stream_url, ff_meta, referer=cdn_ref)
            duration = float(ff_meta.get("duration") or duration or 0)
            height = int(ff_meta.get("height") or height or 0)
            width = int(ff_meta.get("width") or width or 0)
            if not filesize and stream_url:
                filesize = await _head_content_length(stream_url, cdn_ref)

        is_filester = (
            not is_bunkr
            and "filester." in (stream_url or "").lower()
            and "/d/" in (stream_url or "").lower()
        )
        if is_filester:
            try:
                from .extractors.filester import FilesterExtractor
                f_extractor = FilesterExtractor()
                meta_f = await f_extractor.extract(stream_url)
                if meta_f and meta_f.get("stream_url"):
                    stream_url = meta_f["stream_url"]
                    if (not title or title.lower().startswith("queued")) and meta_f.get("title"):
                        title = meta_f["title"]
                    if not thumbnail and meta_f.get("thumbnail"):
                        thumbnail = meta_f["thumbnail"]
                    duration = duration or float(meta_f.get("duration") or 0)
                    height = height or int(meta_f.get("height") or 0)
                    width = width or int(meta_f.get("width") or 0)
                    if not filesize and meta_f.get("size_bytes"):
                        filesize = meta_f["size_bytes"]
            except Exception as e:
                logging.warning(f"Filester pre-import extract failed for {stream_url}: {e}")

        is_camwhores_watch = (
            not is_bunkr
            and not is_filester
            and "camwhores.tv" in (v.url or "").lower()
            and "/videos/" in (v.url or "").lower()
            and "get_file" not in (v.url or "").lower()
        )
        if is_camwhores_watch and camwhores_extractor.can_handle(v.url):
            watch_page = v.url
            try:
                # Resolve the fresh signed get_file URL via the shared browser-first extractor.
                meta_cw = await camwhores_extractor.extract(watch_page)
                if meta_cw and meta_cw.get("stream_url"):
                    stream_url = meta_cw["stream_url"]
                    if "camwhores.tv/videos/" not in (source_url or "").lower():
                        source_url = watch_page
                    if (not title or title.lower().startswith("queued")) and meta_cw.get("title"):
                        title = meta_cw["title"]
                    if not thumbnail and meta_cw.get("thumbnail"):
                        thumbnail = meta_cw["thumbnail"]
                    duration = duration or float(meta_cw.get("duration") or 0)
                    height = height or int(meta_cw.get("height") or 0)
                    width = width or int(meta_cw.get("width") or 0)
            except Exception as e:
                logging.warning(f"Camwhores pre-import extract failed for {watch_page}: {e}")
            if stream_url and "get_file" in stream_url:
                ff_meta = {"duration": duration, "height": height, "width": width}
                _cw_ffprobe_referer = watch_page if watch_page else "https://www.camwhores.tv/"
                ff_meta = processor._ffprobe_fallback(
                    stream_url, ff_meta, referer=_cw_ffprobe_referer
                )
                duration = float(ff_meta.get("duration") or duration or 0)
                height = int(ff_meta.get("height") or height or 0)
                width = int(ff_meta.get("width") or width or 0)
                if not filesize:
                    filesize = await _head_content_length(
                        stream_url, _cw_ffprobe_referer
                    )

        # CW get_file URL imported directly from extension (token is fresh now — run ffprobe immediately)
        is_cw_getfile_direct = (
            not is_bunkr
            and not is_camwhores_watch
            and "camwhores.tv/get_file" in (stream_url or "").lower()
            and "camwhores.tv/videos/" in (source_url or "").lower()
        )
        if is_cw_getfile_direct and (not height or not duration):
            logging.info("[CW-import] get_file direct — running ffprobe while token is fresh: %s", (stream_url or "")[:80])
            ff_meta = {"duration": duration, "height": height, "width": width}
            _cw_ffprobe_ref = source_url  # watch page as Referer
            ff_meta = processor._ffprobe_fallback(stream_url, ff_meta, referer=_cw_ffprobe_ref)
            duration = float(ff_meta.get("duration") or duration or 0)
            height = int(ff_meta.get("height") or height or 0)
            width = int(ff_meta.get("width") or width or 0)
            if not filesize:
                filesize = await _head_content_length(stream_url, _cw_ffprobe_ref)
            logging.info("[CW-import] ffprobe result: dur=%.1f h=%s w=%s", duration, height, width)

        # ── PornHoarder: extract stream URL at import time ──────────────────
        is_pornhoarder = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and ("pornhoarder.io" in (stream_url or "").lower()
                 or "pornhoarder.net" in (stream_url or "").lower()
                 or "pornhoarder.io" in (source_url or "").lower())
        )
        if is_pornhoarder:
            try:
                from .extractors.pornhoarder import PornHoarderExtractor
                _ph_extractor = PornHoarderExtractor()
                _ph_url = source_url if "pornhoarder.io/watch/" in (source_url or "") else stream_url
                meta_ph = await _ph_extractor.extract(_ph_url)
                if meta_ph and meta_ph.get("stream_url"):
                    stream_url = meta_ph["stream_url"]
                    if (not title or title.lower().startswith("queued")) and meta_ph.get("title"):
                        title = meta_ph["title"]
                    if not thumbnail and meta_ph.get("thumbnail"):
                        thumbnail = meta_ph["thumbnail"]
                    duration = duration or float(meta_ph.get("duration") or 0)
                    height = height or int(meta_ph.get("height") or 0)
                    width = width or int(meta_ph.get("width") or 0)
                    filesize = filesize or int(meta_ph.get("filesize") or 0)
                    logging.info("[PornHoarder-import] stream=%s dur=%.1f h=%s",
                                 (stream_url or "")[:80], duration, height)
            except Exception as e:
                logging.warning(f"PornHoarder pre-import extract failed for {stream_url}: {e}")

        # Archivebate watch/embed URLs need resolving before Nexus can probe/play them.
        is_archivebate = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and (
                archivebate_extractor.can_handle(stream_url)
                or archivebate_extractor.can_handle(source_url)
            )
        )
        if is_archivebate:
            try:
                archivebate_url = source_url if archivebate_extractor.can_handle(source_url) else stream_url
                meta_ab = await archivebate_extractor.extract(archivebate_url)
                if meta_ab and meta_ab.get("stream_url"):
                    stream_url = meta_ab["stream_url"]
                    if archivebate_extractor.can_handle(archivebate_url):
                        source_url = archivebate_url
                    if (not title or title.lower().startswith("queued")) and meta_ab.get("title"):
                        title = meta_ab["title"]
                    if not thumbnail and meta_ab.get("thumbnail"):
                        thumbnail = meta_ab["thumbnail"]
                    duration = duration or float(meta_ab.get("duration") or 0)
                    height = height or int(meta_ab.get("height") or 0)
                    width = width or int(meta_ab.get("width") or 0)
                    filesize = filesize or int(meta_ab.get("size_bytes") or 0)
                    logging.info("[Archivebate-import] stream=%s dur=%.1f h=%s",
                                 (stream_url or "")[:80], duration, height)
            except Exception as e:
                logging.warning(f"Archivebate pre-import extract failed for {stream_url}: {e}")

        is_recurbate = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and (
                recurbate_extractor.can_handle(stream_url)
                or recurbate_extractor.can_handle(source_url)
            )
        )
        if is_recurbate:
            try:
                recurbate_url = source_url if recurbate_extractor.can_handle(source_url) else stream_url
                meta_rb = await recurbate_extractor.extract(recurbate_url)
                if meta_rb and meta_rb.get("stream_url"):
                    stream_url = meta_rb["stream_url"]
                    source_url = meta_rb.get("source_url") or recurbate_url
                    if (not title or title.lower().startswith("queued")) and meta_rb.get("title"):
                        title = meta_rb["title"]
                    if not thumbnail and meta_rb.get("thumbnail"):
                        thumbnail = meta_rb["thumbnail"]
                    duration = duration or float(meta_rb.get("duration") or 0)
                    height = height or int(meta_rb.get("height") or 0)
                    width = width or int(meta_rb.get("width") or 0)
                    filesize = filesize or int(meta_rb.get("size_bytes") or meta_rb.get("filesize") or 0)
                    status = "ready_to_stream"
                    logging.info("[Recurbate-import] stream=%s dur=%.1f h=%s",
                                 (stream_url or "")[:80], duration, height)
            except Exception as e:
                logging.warning(f"Recurbate pre-import extract failed for {stream_url}: {e}")

        video = Video(
            title=title,
            url=stream_url,
            source_url=source_url,
            thumbnail_path=thumbnail,
            duration=duration,
            height=height,
            width=width,
            batch_name=req.batch_name,
            tags=v.tags or "",
            storage_type="remote",
            status=status,
            download_stats={"size_mb": round(filesize / (1024 * 1024), 2)} if filesize else None,
        )
        db.add(video)
        db.flush()
        new_ids.append(video.id)
    db.commit()
    if new_ids:
        bg_tasks.add_task(processor.process_batch, new_ids)
    return {"status": "ok", "count": len(new_ids), "batch": req.batch_name}


def background_import_process(urls: List[str], batch_name: str, parser: str, items: Optional[List[dict]] = None, min_quality: Optional[int] = None, min_duration: Optional[int] = None, auto_heal: bool = True):
    """
    Táto funkcia beží na pozadí. Rozoberá URL, pridáva do DB a spúšťa spracovanie.
    Supports filtering by min_quality (height in pixels) and min_duration (seconds).
    """
    db = SessionLocal()
    new_ids = []
    filtered_count = 0
    def _cw_corr_id(u: str, su: str) -> str:
        for raw in (su or "", u or ""):
            try:
                m = re.search(r"/videos/(\d+)(?:/|$)", raw, re.I)
                if m:
                    return f"cw:{m.group(1)}"
            except Exception:
                pass
        return "cw:unknown"
    
    # 1. Expandovanie playlistov (blokujúca operácia, preto je tu)
    final_urls = []
    for u in urls:
        u = u.strip()
        if not u: continue
        # Webshare pseudo-URLs are not playlists and must not go through yt-dlp/requests.
        if u.startswith("webshare:") or ("wsfiles.cz" in u) or ("webshare.cz" in u):
            final_urls.append(u)
            continue
        # Pixeldrain nepotrebuje expandovať
        if "pixeldrain.com" in u and "/api/file/" in u:
            final_urls.append(u)
        else:
            final_urls.extend(extract_playlist_urls(u, parser=parser))

    # 2. Vloženie do DB
    final_urls = list(dict.fromkeys(final_urls)) # Unikátne URL
    
    # Map for easy lookup of item data if available
    item_data_map = {}
    if items:
        for it in items:
            if it.get('url'):
                item_data_map[it['url']] = it

    def _parse_extension_duration_seconds(item: dict) -> float:
        """Human-readable duration string or numeric seconds from extension JSON."""
        if not item:
            return 0.0
        ds = item.get("duration_seconds")
        if ds is not None:
            try:
                v = float(ds)
                if v > 0:
                    return v
            except (TypeError, ValueError):
                pass
        d = item.get("duration")
        if isinstance(d, (int, float)):
            try:
                v = float(d)
                return v if v > 0 else 0.0
            except (TypeError, ValueError):
                pass
        if isinstance(d, str) and d.strip():
            parts = [p.strip() for p in d.split(":") if p.strip() != ""]
            try:
                if len(parts) == 3:
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
                if len(parts) == 2:
                    return int(parts[0]) * 60 + float(parts[1])
                return float(d)
            except (TypeError, ValueError):
                return 0.0
        return 0.0

    def _parse_extension_height_px(item: dict) -> int:
        """Best-effort quality px from extension item."""
        if not item:
            return 0
        q = item.get("quality")
        try:
            if isinstance(q, (int, float)) and q > 0:
                qi = int(q)
                if qi >= 100: return 2160
                if qi >= 95: return 1440
                if qi >= 90: return 1080
                if qi >= 80: return 720
                if qi >= 70: return 480
        except (TypeError, ValueError):
            pass
        ql = str(item.get("qualityLabel") or "").lower()
        m = re.search(r"(2160|1440|1080|720|480|360)\s*p", ql)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                return 0
        if "4k" in ql:
            return 2160
        if "fhd" in ql:
            return 1080
        if "hd" in ql:
            return 720
        return 0

    def _normalize_camwhores_watch_url(u: str) -> Optional[str]:
        if not u:
            return None
        try:
            p = urllib.parse.urlparse(u)
            if "camwhores.tv" not in p.netloc.lower():
                return None
            m = re.search(r"/videos/(\d+)(?:/([^/?#]+))?(?:/|$)", p.path, re.I)
            if not m:
                return None
            video_id = m.group(1)
            slug = (m.group(2) or "").strip()
            if slug:
                return f"{p.scheme or 'https'}://{p.netloc}/videos/{video_id}/{slug}/"
            return f"{p.scheme or 'https'}://{p.netloc}/videos/{video_id}/"
        except Exception:
            return None

    for url in final_urls:
        url = url.strip()
        if not url: continue
        
        # Check if we have specific item data from extension
        item_data = item_data_map.get(url, {})
        title = item_data.get("title") or item_data.get("label") or item_data.get("name")
        thumbnail = item_data.get("thumbnail")
        source_candidate = item_data.get("source_url") or url
        video_source_url = source_candidate
        # Camwhores: preserve watch page URL as lineage for reliable re-resolve on expired get_file URLs.
        cw_watch_from_source = _normalize_camwhores_watch_url(item_data.get("source_url") or "")
        cw_watch_from_url = _normalize_camwhores_watch_url(url)
        if cw_watch_from_source:
            video_source_url = cw_watch_from_source
        elif cw_watch_from_url:
            video_source_url = cw_watch_from_url
        ext_duration = _parse_extension_duration_seconds(item_data)
        ext_height = _parse_extension_height_px(item_data)

        ext_size_bytes = 0
        try:
            raw_sz = item_data.get("size_bytes")
            if raw_sz is None:
                raw_sz = item_data.get("filesize")
            if raw_sz is not None:
                ext_size_bytes = int(float(raw_sz))
        except (TypeError, ValueError):
            ext_size_bytes = 0
        if ext_size_bytes < 0:
            ext_size_bytes = 0

        # Pixeldrain Title Logic (fallback if no item title)
        if not title:
            title = "Queued..."
            if "pixeldrain.com" in url and "/api/file/" in url:
                 try: 
                     parts = url.split("/")
                     if len(parts) > 5: # .../api/file/ID/Meno
                         title = urllib.parse.unquote(parts[-1])
                 except: pass

        # GoFile Detection and Metadata Extraction (supports folders with multiple videos)
        if 'gofile.io/d/' in url.lower():
            try:
                from app.extractors.gofile import GoFileExtractor
                gofile_extractor = GoFileExtractor()

                if gofile_extractor.can_handle(url):
                    logging.info(f"Extracting GoFile metadata for: {url}")

                    # Try to extract multiple videos (folder support)
                    gofile_videos = gofile_extractor.extract_multiple(url)

                    if gofile_videos and len(gofile_videos) > 0:
                        # Multiple videos found (folder)
                        logging.info(f"Found {len(gofile_videos)} videos in GoFile folder")
                        processor = VIPVideoProcessor()

                        for video_metadata in gofile_videos:
                            v = Video(
                                title=video_metadata.get('title', title),
                                url=video_metadata.get('stream_url'),
                                source_url=url,
                                thumbnail_path=video_metadata.get('thumbnail'),
                                duration=video_metadata.get('duration', 0),
                                height=video_metadata.get('height', 0),
                                width=video_metadata.get('width', 0),
                                batch_name=batch_name,
                                status="ready_to_stream",
                                storage_type="remote"
                            )
                            db.add(v)
                            db.commit()
                            processor.broadcast_new_video(v)
                            new_ids.append(v.id)
                            logging.info(f"GoFile video imported: {v.title}")

                        logging.info(f"All {len(gofile_videos)} GoFile videos imported successfully")
                        continue  # Skip normal processing
                    else:
                        # GoFile extraction failed - folder is private, password-protected, or expired
                        logging.error(f"GoFile folder extraction failed: {url}")
                        logging.error("Possible reasons: folder is private/premium-only, password-protected, expired, or empty")
                        continue  # Skip this URL entirely - don't import broken video
            except Exception as e:
                logging.error(f"Error extracting GoFile metadata: {e}", exc_info=True)
                # Fall through to normal processing

        # VK Video Detection and Metadata Extraction
        # Support all VK domains
        is_vk_video = any(domain in url.lower() for domain in ['vk.com', 'vk.video', 'vkvideo.ru', 'vkvideo.net', 'vkvideo.com', 'vk.ru', 'okcdn.ru'])
        if is_vk_video:
            try:
                from app.extractors.vk import VKExtractor
                import asyncio
                vk_extractor = VKExtractor()
                
                if vk_extractor.can_handle(url):
                    logging.info(f"Extracting VK metadata for: {url}")
                    # Use asyncio.run() since this function is not async
                    vk_metadata = asyncio.run(vk_extractor.extract(url))
                    
                    if vk_metadata:
                        # Use VK metadata
                        title = vk_metadata.get('title', title)
                        thumbnail = vk_metadata.get('thumbnail', thumbnail)
                        stream_url = vk_metadata.get('stream_url', url)
                        duration = vk_metadata.get('duration', 0)
                        height = vk_metadata.get('height', 0)
                        width = vk_metadata.get('width', 0)
                        
                        # Create VK video with full metadata
                        v = Video(
                            title=title,
                            url=stream_url,  # Use extracted stream URL
                            source_url=url,  # Keep page URL for refresh
                            thumbnail_path=thumbnail,
                            duration=duration,
                            height=height,
                            width=width,
                            batch_name=batch_name,
                            status="ready_to_stream",  # Skip processing
                            storage_type="remote"
                        )
                        db.add(v)
                        db.commit()
                        
                        processor = VIPVideoProcessor()
                        processor.broadcast_new_video(v)
                        new_ids.append(v.id)
                        
                        logging.info(f"VK video imported successfully: {title}")
                        continue  # Skip normal processing
                    else:
                        logging.warning(f"VK metadata extraction returned None for: {url}")
            except Exception as e:
                logging.error(f"VK metadata extraction failed for {url}: {e}")
                # Fall through to normal processing


        # Tnaflix Video Detection
        if "tnaflix.com" in url:
            try:
                from app.extractors.tnaflix import TnaflixExtractor
                tna_extractor = TnaflixExtractor()
                if tna_extractor.can_handle(url):
                    logging.info(f"Detected Tnaflix URL: {url}")
                    tna_results = tna_extractor.extract_from_profile(url) if "/profile/" in url else [tna_extractor.extract(url)]
                    
                    tna_handled = False
                    for tna_meta in tna_results:
                        if not tna_meta: continue
                        
                        # FILTER: Skip trailers in backend import
                        if "trailer.mp4" in tna_meta.get("stream_url", "").lower() or "trailer" in tna_meta.get("title", "").lower():
                            logging.info(f"Skipping Tnaflix trailer: {tna_meta.get('title')}")
                            continue
                        
                        v = Video(
                            title=tna_meta["title"],
                            url=tna_meta["stream_url"],
                            source_url=url,
                            thumbnail_path=tna_meta["thumbnail"],
                            duration=tna_meta["duration"],
                            status="ready_to_stream",
                            batch_name=batch_name,
                            storage_type="remote",
                            tags=tna_meta.get("tags", "")
                        )
                        db.add(v)
                        db.commit()
                        
                        processor = VIPVideoProcessor()
                        processor.broadcast_new_video(v)
                        new_ids.append(v.id)
                        logging.info(f"Tnaflix video imported: {tna_meta['title']}")
                        tna_handled = True
                    
                    if tna_handled:
                        continue
            except Exception as e:
                logging.error(f"Tnaflix extraction failed for {url}: {e}")

        # Ukladáme do DB
        if "camwhores.tv" in url.lower():
            # Avoid duplicate rows per same watch-id lineage when URLs differ by rnd/query/signature.
            cw_watch = _normalize_camwhores_watch_url(video_source_url) or _normalize_camwhores_watch_url(url)
            if cw_watch:
                existing_cw = db.query(Video).filter(Video.source_url == cw_watch).first()
                if existing_cw:
                    logging.info(f"Skipping duplicate Camwhores import for watch URL: {cw_watch}")
                    continue
            logging.info(
                "[CW_IMPORT][%s] incoming url=%s source=%s ext_duration=%s ext_height=%s",
                _cw_corr_id(url, video_source_url),
                url[:120],
                (video_source_url or "")[:120],
                int(ext_duration or 0),
                int(ext_height or 0),
            )

        v = Video(
            title=title, 
            url=url, 
            source_url=video_source_url, 
            batch_name=batch_name, 
            status="pending",
            thumbnail_path=thumbnail,
            duration=ext_duration or 0,
            height=ext_height or 0,
            download_stats=({"reported_size_bytes": ext_size_bytes} if ext_size_bytes > 0 else None),
        )
        db.add(v)
        db.commit() # Commit each to get ID and ensure it's in DB for broadcast
        if "camwhores.tv" in (url or "").lower() or "camwhores.tv" in (video_source_url or "").lower():
            logging.info(
                "[CW_IMPORT][%s] persisted video_id=%s status=%s duration=%s height=%s source=%s",
                _cw_corr_id(url, video_source_url),
                v.id,
                v.status,
                int(v.duration or 0),
                int(v.height or 0),
                (v.source_url or "")[:120],
            )
        
        processor = VIPVideoProcessor()
        processor.broadcast_new_video(v)
        
        new_ids.append(v.id)

    db.close()

    # 3. Spustenie spracovania
    if new_ids:
        processor = VIPVideoProcessor()
        processor.process_batch(new_ids)

        # 4. Post-processing filtering if filters are enabled
        if min_quality or min_duration:
            db = SessionLocal()
            try:
                for video_id in new_ids:
                    video = db.query(Video).filter(Video.id == video_id).first()
                    if not video:
                        continue

                    should_filter = False
                    filter_reason = ""

                    # Check quality filter
                    if min_quality and video.height and video.height < min_quality:
                        should_filter = True
                        filter_reason = f"Quality too low ({video.height}p < {min_quality}p)"

                    # Check duration filter
                    if min_duration and video.duration and video.duration < min_duration:
                        should_filter = True
                        filter_reason = f"Duration too short ({int(video.duration)}s < {min_duration}s)"

                    if should_filter:
                        logging.info(f"Filtering out video '{video.title}': {filter_reason}")
                        db.delete(video)
                        filtered_count += 1

                db.commit()

                if filtered_count > 0:
                    logging.info(f"Filtered out {filtered_count} videos that didn't meet criteria (min_quality={min_quality}, min_duration={min_duration})")
            except Exception as e:
                logging.error(f"Error during post-processing filtering: {e}")
                db.rollback()
            finally:
                db.close()

@api_v1_router.post("/import/text")
@api_legacy_router.post("/import/text")
async def import_text(bg_tasks: BackgroundTasks, data: ImportRequest):
    """
    API vráti odpoveď OKAMŽITE. Celý import beží na pozadí.
    """
    batch = data.batch_name or f"Import {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    # Spustíme prácu na pozadí
    bg_tasks.add_task(background_import_process, data.urls, batch, data.parser or "yt-dlp", data.items, data.min_quality, data.min_duration, data.auto_heal)
    return {"count": len(data.items) if data.items else len(data.urls), "batch": batch, "message": "Import started in background"}

@api_v1_router.get("/diagnostics/camwhores-integrity")
@api_legacy_router.get("/diagnostics/camwhores-integrity")
async def camwhores_integrity(limit: int = 20, db: Session = Depends(get_db)):
    """
    Quick integrity snapshot for Camwhores imports/playback lineage.
    Helps identify rows that cannot be re-resolved or have weak metadata.
    """
    rows = db.query(Video).filter(
        or_(
            Video.url.ilike("%camwhores%"),
            Video.source_url.ilike("%camwhores%"),
        )
    ).order_by(desc(Video.id)).all()

    total = len(rows)
    missing_source_watch = 0
    missing_duration = 0
    missing_height = 0
    bad_url_shape = 0
    samples = []
    for v in rows:
        src = (v.source_url or "").lower()
        url = (v.url or "").lower()
        has_watch_source = "camwhores.tv/videos/" in src
        if not has_watch_source:
            missing_source_watch += 1
        if not v.duration or v.duration <= 0:
            missing_duration += 1
        if not v.height or v.height <= 0:
            missing_height += 1
        if "camwhores.tv/get_file/" not in url and "camwhores.tv/videos/" not in url:
            bad_url_shape += 1
        if len(samples) < max(1, min(limit, 100)):
            samples.append({
                "id": v.id,
                "title": v.title,
                "url": v.url,
                "source_url": v.source_url,
                "duration": v.duration,
                "height": v.height,
                "status": v.status,
                "corr_id": (re.search(r"/videos/(\\d+)", v.source_url or "") or re.search(r"/videos/(\\d+)", v.url or "")) and f"cw:{(re.search(r'/videos/(\\d+)', v.source_url or '') or re.search(r'/videos/(\\d+)', v.url or '')).group(1)}" or "cw:unknown",
            })

    return {
        "total": total,
        "missing_source_watch": missing_source_watch,
        "missing_duration": missing_duration,
        "missing_height": missing_height,
        "bad_url_shape": bad_url_shape,
        "samples": samples,
    }

@api_v1_router.post("/import/local-folder")
@api_legacy_router.post("/import/local-folder")
async def import_local_folder(data: dict, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Scan a local folder and index all video files.
    No copying - just creates DB entries pointing to local files.
    """
    folder_path = data.get('folder_path')
    batch_name = data.get('batch_name', f"Local_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}")
    recursive = data.get('recursive', True)

    if not folder_path or not os.path.exists(folder_path):
        raise HTTPException(status_code=400, detail="Invalid folder path")

    from pathlib import Path
    import mimetypes

    video_extensions = {'.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg'}
    file_paths = []

    # Scan folder for video files
    folder = Path(folder_path)
    pattern = '**/*' if recursive else '*'

    for file_path in folder.glob(pattern):
        if file_path.is_file():
            ext = file_path.suffix.lower()
            if ext in video_extensions:
                file_paths.append(str(file_path))

    if not file_paths:
        return {"count": 0, "message": "No video files found in folder"}

    # Index files using the fast indexing endpoint
    indexed_count = 0
    video_ids = []

    for file_path in file_paths:
        try:
            path_obj = Path(file_path)
            file_url = path_obj.as_uri()

            video = Video(
                title=path_obj.name,
                url=file_url,
                source_url=file_url,
                batch_name=batch_name,
                status="ready",
                storage_type="local_direct",
                created_at=datetime.datetime.utcnow()
            )

            db.add(video)
            db.flush()
            video_ids.append(video.id)
            indexed_count += 1

        except Exception as e:
            logging.warning(f"Failed to index {file_path}: {e}")
            continue

    db.commit()

    # Extract metadata in background
    if video_ids:
        bg_tasks.add_task(extract_local_metadata_batch, video_ids)

    return {
        "count": indexed_count,
        "batch": batch_name,
        "message": f"Indexed {indexed_count} videos from folder",
        "video_ids": video_ids
    }

@api_v1_router.post("/import/local-index")
@api_legacy_router.post("/import/local-index")
async def import_local_index(data: dict, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Ultra-fast local file indexing - no copying, no upload.
    Indexes local video files directly from disk paths.
    Expected to handle 100 files in ~3 seconds.
    """
    file_paths = data.get('file_paths', [])
    batch_name = data.get('batch_name', f"Local_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}")

    if not file_paths:
        return {"count": 0, "message": "No files provided"}

    import mimetypes
    from pathlib import Path

    indexed_count = 0
    video_ids = []

    # Fast indexing - minimal processing
    for file_path in file_paths:
        try:
            path_obj = Path(file_path)

            # Quick validation
            if not path_obj.exists() or not path_obj.is_file():
                continue

            # Check if it's a video file
            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type or not mime_type.startswith('video/'):
                continue

            # Get file size and basic info (very fast)
            file_size = path_obj.stat().st_size
            file_name = path_obj.name

            # Create DB entry with local file:// URL
            # Windows paths: file:///C:/path/to/video.mp4
            # Unix paths: file:///path/to/video.mp4
            file_url = path_obj.as_uri()

            video = Video(
                title=file_name,
                url=file_url,
                source_url=file_url,
                batch_name=batch_name,
                status="ready",  # Mark as ready immediately - no processing needed
                storage_type="local_direct",  # New type for direct local access
                created_at=datetime.datetime.utcnow()
            )

            db.add(video)
            db.flush()
            video_ids.append(video.id)
            indexed_count += 1

        except Exception as e:
            logging.warning(f"Failed to index {file_path}: {e}")
            continue

    db.commit()

    # Optional: Extract metadata in background (non-blocking)
    if video_ids:
        bg_tasks.add_task(extract_local_metadata_batch, video_ids)

    return {
        "count": indexed_count,
        "batch": batch_name,
        "message": f"Indexed {indexed_count} local videos instantly",
        "video_ids": video_ids
    }

def extract_local_metadata_batch(video_ids: List[int]):
    """
    Background task to extract metadata from local files.
    Uses ffprobe for fast metadata extraction without processing video.
    """
    import subprocess
    from pathlib import Path

    db = SessionLocal()
    try:
        for video_id in video_ids:
            try:
                video = db.query(Video).get(video_id)
                if not video or not video.url:
                    continue

                # Convert file:// URL back to path
                from urllib.parse import urlparse, unquote
                parsed = urlparse(video.url)
                file_path = unquote(parsed.path)

                # On Windows, remove leading slash from /C:/path
                if os.name == 'nt' and file_path.startswith('/') and ':' in file_path:
                    file_path = file_path[1:]

                if not os.path.exists(file_path):
                    continue

                # Use ffprobe for fast metadata extraction
                cmd = [
                    'ffprobe',
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_format',
                    '-show_streams',
                    file_path
                ]

                result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                if result.returncode == 0:
                    metadata = json.loads(result.stdout)

                    # Extract duration
                    duration = 0
                    if 'format' in metadata and 'duration' in metadata['format']:
                        duration = float(metadata['format']['duration'])
                        video.duration = duration

                    # Extract resolution from video stream
                    for stream in metadata.get('streams', []):
                        if stream.get('codec_type') == 'video':
                            video.width = stream.get('width', 0)
                            video.height = stream.get('height', 0)
                            break

                    # Generate thumbnail (at 10% of duration or 5 seconds, whichever is smaller)
                    thumb_dir = os.path.join("app", "static", "thumbnails", "local")
                    os.makedirs(thumb_dir, exist_ok=True)

                    thumb_time = min(5, duration * 0.1) if duration > 0 else 5
                    thumb_filename = f"local_{video_id}.jpg"
                    thumb_path = os.path.join(thumb_dir, thumb_filename)

                    thumb_cmd = [
                        'ffmpeg',
                        '-y',  # Overwrite if exists
                        '-ss', str(thumb_time),  # Seek to timestamp
                        '-i', file_path,
                        '-vframes', '1',  # Extract 1 frame
                        '-vf', 'scale=320:-1',  # Scale to 320px width, maintain aspect ratio
                        '-q:v', '2',  # High quality JPEG
                        thumb_path
                    ]

                    try:
                        thumb_result = subprocess.run(
                            thumb_cmd,
                            capture_output=True,
                            text=True,
                            timeout=10,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                        )

                        if thumb_result.returncode == 0 and os.path.exists(thumb_path):
                            video.thumbnail_path = f"/static/thumbnails/local/{thumb_filename}"
                            logging.info(f"Generated thumbnail for local video {video_id}")
                    except Exception as thumb_err:
                        logging.warning(f"Failed to generate thumbnail for video {video_id}: {thumb_err}")

                    db.commit()
                    logging.info(f"Extracted metadata for local video {video_id}")

            except Exception as e:
                logging.warning(f"Failed to extract metadata for video {video_id}: {e}")
                continue
    finally:
        db.close()

@api_v1_router.get("/videos/{video_id}/preview")
@api_legacy_router.get("/videos/{video_id}/preview")
async def generate_video_preview(video_id: int, db: Session = Depends(get_db)):
    """
    Generate a 5-second preview clip for hover previews.
    Returns the preview video URL or generates it on-demand.
    """
    import subprocess
    from urllib.parse import urlparse, unquote
    from fastapi.responses import FileResponse

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Create previews directory
    preview_dir = os.path.join("app", "static", "previews")
    os.makedirs(preview_dir, exist_ok=True)

    preview_filename = f"preview_{video_id}.mp4"
    preview_path = os.path.join(preview_dir, preview_filename)

    # If preview already exists, return it
    if os.path.exists(preview_path):
        return FileResponse(preview_path, media_type="video/mp4")

    # For local videos, generate preview from file
    if video.storage_type == "local_direct" and video.url:
        try:
            # Convert file:// URL back to path
            parsed = urlparse(video.url)
            file_path = unquote(parsed.path)

            # On Windows, remove leading slash from /C:/path
            if os.name == 'nt' and file_path.startswith('/') and ':' in file_path:
                file_path = file_path[1:]

            if not os.path.exists(file_path):
                raise HTTPException(status_code=404, detail="Source file not found")

            # Generate 5-second preview starting from 10% into video
            duration = video.duration or 30
            start_time = min(5, duration * 0.1) if duration > 0 else 5

            preview_cmd = [
                'ffmpeg',
                '-y',  # Overwrite if exists
                '-ss', str(start_time),  # Start time
                '-i', file_path,
                '-t', '5',  # Duration: 5 seconds
                '-vf', 'scale=480:-1',  # Scale to 480px width
                '-c:v', 'libx264',  # H.264 codec
                '-preset', 'ultrafast',  # Fast encoding
                '-crf', '28',  # Quality (higher = lower quality, smaller file)
                '-an',  # No audio (smaller file)
                preview_path
            ]

            result = subprocess.run(
                preview_cmd,
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )

            if result.returncode == 0 and os.path.exists(preview_path):
                return FileResponse(preview_path, media_type="video/mp4")
            else:
                raise HTTPException(status_code=500, detail="Failed to generate preview")

        except Exception as e:
            logging.error(f"Error generating preview for video {video_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    else:
        raise HTTPException(status_code=400, detail="Preview generation only supported for local videos")

@api_v1_router.get("/videos/{video_id}/stream")
@api_legacy_router.get("/videos/{video_id}/stream")
async def stream_local_video(video_id: int, request: Request, db: Session = Depends(get_db)):
    """
    Stream local video files directly to the browser.
    Supports range requests for seeking.
    """
    from urllib.parse import urlparse, unquote
    from fastapi.responses import StreamingResponse
    import mimetypes

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Only stream local_direct videos
    if video.storage_type != "local_direct" or not video.url:
        raise HTTPException(status_code=400, detail="Streaming only supported for local videos")

    # Convert file:// URL back to path
    parsed = urlparse(video.url)
    file_path = unquote(parsed.path)

    # On Windows, remove leading slash from /C:/path
    if os.name == 'nt' and file_path.startswith('/') and ':' in file_path:
        file_path = file_path[1:]

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Source file not found")

    # Get file size and type
    file_size = os.path.getsize(file_path)
    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type:
        mime_type = "video/mp4"

    # Handle range requests for seeking
    range_header = request.headers.get("range")

    if range_header:
        # Parse range header (e.g., "bytes=0-1023")
        range_match = range_header.replace("bytes=", "").split("-")
        start = int(range_match[0]) if range_match[0] else 0
        end = int(range_match[1]) if len(range_match) > 1 and range_match[1] else file_size - 1

        # Ensure valid range
        start = max(0, start)
        end = min(file_size - 1, end)
        content_length = end - start + 1

        def iterfile():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    data = f.read(chunk_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
        }

        return StreamingResponse(
            iterfile(),
            status_code=206,
            media_type=mime_type,
            headers=headers
        )
    else:
        # No range, stream entire file
        def iterfile():
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(8192)
                    if not chunk:
                        break
                    yield chunk

        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        }

        return StreamingResponse(
            iterfile(),
            media_type=mime_type,
            headers=headers
        )

@api_v1_router.post("/import/file")
@api_legacy_router.post("/import/file")
async def import_file(bg_tasks: BackgroundTasks, file: UploadFile = File(...), db: Session = Depends(get_db)):
    filename = file.filename
    ext = filename.lower().rsplit('.', 1)[-1]

    if ext in ["mp4", "mkv", "avi", "mov", "webm"]:
        save_dir = "app/static/local_videos"
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, os.path.basename(filename))
        with open(save_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024 * 10)
                if not chunk: break
                f.write(chunk)
        v = Video(
            title=os.path.basename(filename), 
            url=f"/static/local_videos/{os.path.basename(save_path)}", 
            batch_name=f"Local_{filename}", 
            status="pending",
            storage_type="local"
        )
        db.add(v); db.commit()
        processor = VIPVideoProcessor()
        bg_tasks.add_task(processor.process_single_video, v.id, force=True)
        return {"count": 1, "message": "Video uploaded"}

    # CSV import
    if ext == "csv":
        import csv
        import io
        content = await file.read()
        try:
            text = content.decode('utf-8')
        except:
            text = content.decode('latin-1', errors='ignore')
        reader = csv.DictReader(io.StringIO(text))
        count = 0
        new_ids = []
        for row in reader:
            # Očakávame stĺpce: title, url, prípadne ďalšie (prispôsobiť podľa .csv)
            title = row.get('title') or row.get('name') or row.get('Title') or row.get('Name') or 'Untitled'
            url = row.get('url') or row.get('Url') or row.get('URL')
            if not url:
                continue
            video = Video(
                title=title,
                url=url,
                source_url=url,
                batch_name=f"CSV_{filename}",
                status="pending",
                created_at=datetime.datetime.utcnow()
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)
            count += 1
        db.commit()
        processor = VIPVideoProcessor()
        bg_tasks.add_task(processor.process_batch, new_ids)
        return {"count": count, "batch": f"CSV_{filename}", "message": f"Imported {count} videos from CSV"}

    # Text/JSON import - delegujeme na background task
    content = await file.read()
    try: text = content.decode('utf-8')
    except: text = content.decode('latin-1', errors='ignore')
    
    urls = text.splitlines()
    
    if filename.endswith('.json'):
        try:
            j = json.loads(text)
            
            # --- OPRAVA: Extrakcia len 'video_url' z JSON objektov ---
            if isinstance(j, list) and all(isinstance(item, dict) and 'video_url' in item for item in j):
                # Extrahuje 'video_url' zo všetkých objektov v zozname
                urls = [item['video_url'] for item in j]
            else:
                # Fallback pre JSON s čistými URL adresami
                urls = [str(x) for x in j] if isinstance(j, list) else text.splitlines()

            # Odstránenie neplatných (napr. None) a prázdnych URL a kontrola protokolu
            urls = [u for u in urls if u and u.startswith('http')]
            # --- KONIEC OPRAVY ---

        except Exception as e:
            print(f"Failed to parse JSON content: {e}")
            urls = [] # Ak parsovanie zlyhá, neimportujeme nič

    batch = f"Import_{filename}"
    bg_tasks.add_task(background_import_process, urls, batch, "yt-dlp", None, None, None, True)
    return {"count": len(urls), "batch": batch, "message": "File import started in background"}

@api_v1_router.post("/import/xvideos")
@api_legacy_router.post("/import/xvideos")
async def import_xvideos(data: XVideosImportRequest, db: Session = Depends(get_db)):
    """
    Import single XVideos URL, extract metadata, and save to DB.
    Returns JSON metadata for immediate display.
    Uses regex scraper first (better HLS detection), falls back to yt-dlp.
    """
    processor = VIPVideoProcessor()
    
    # Try the improved yt-dlp extractor first (targeted for VIP quality)
    logging.info(f"Extracting XVideos metadata for {data.url}")
    meta = processor.extract_xvideos_metadata(data.url)
    
    # Fallback to regex scraper if yt-dlp failed
    if not meta:
        logging.info(f"Yt-dlp failed, falling back to regex scraper for {data.url}")
        try:
            xv_meta, xv_stream_url = processor._fetch_xvideos_meta(data.url)
            if xv_stream_url:
                meta_with_quality = processor._ffprobe_fallback(xv_stream_url, xv_meta, referer=data.url)
                
                video_id = ''
                try:
                    parts = data.url.split('/')
                    for part in parts:
                        if part.startswith('video.'):
                            video_id = part.split('.')[-1] if '.' in part else part
                            break
                except: pass

                meta = {
                    "source": "xvideos",
                    "id": video_id or data.url.split('/')[-1].split('/')[0] if '/' in data.url else '',
                    "title": xv_meta.get('title', ''),
                    "duration": meta_with_quality.get('duration', xv_meta.get('duration', 0)),
                    "thumbnail": xv_meta.get('thumbnail_url', ''),
                    "stream": {
                        "type": "hls" if '.m3u8' in xv_stream_url.lower() else "mp4",
                        "url": xv_stream_url,
                        "height": meta_with_quality.get('height', 0),
                        "width": meta_with_quality.get('width', 0)
                    },
                    "tags": xv_meta.get('tags', '').split(',') if isinstance(xv_meta.get('tags'), str) else []
                }
        except Exception as e:
            logging.error(f"Fallback scraper also failed: {e}")

    if not meta:
        return JSONResponse(status_code=400, content={"error": "EXTRACTION_FAILED"})
    
    # Check if exists
    existing = db.query(Video).filter(Video.source_url == data.url).first()
    if existing:
        # Update existing
        existing.url = meta['stream']['url']
        existing.title = meta['title']
        existing.duration = meta['duration']
        existing.thumbnail_path = meta['thumbnail']
        existing.height = meta['stream'].get('height', 0)
        existing.width = meta['stream'].get('width', 0)
        existing.status = "ready"
        db.commit()
        db.refresh(existing)
        video_id = existing.id
    else:
        # Create new
        video = Video(
            title=meta['title'],
            url=meta['stream']['url'],
            source_url=data.url,
            duration=meta['duration'],
            thumbnail_path=meta['thumbnail'],
            height=meta['stream'].get('height', 0),
            width=meta['stream'].get('width', 0),
            status="ready",
            batch_name=f"Import XVideos {datetime.datetime.now().strftime('%d.%m')}",
            created_at=datetime.datetime.utcnow()
        )
        db.add(video)
        db.commit()
        db.refresh(video)
        video_id = video.id

    # Add DB ID to response if needed, but the prompt specified a specific shape.
    # The prompt asked for: source, id, title, duration, thumbnail, stream object.
    # The extracted meta has this shape.
    # We might want to pass the DB ID as 'id' or keep the source ID?
    # The prompt example: "id": "okchumv725e" (looks like xvideos ID).
    # But for the frontend to work with the player and internal logic, it usually needs the DB ID.
    # However, the frontend "importXVideos" logic will likely map this response to the internal video object.
    # The internal video object needs 'id' (DB ID) for things like favorites/delete etc.
    # But the prompt explicitly defined the response shape.
    # I will stick to the requested response shape, but if the frontend needs to manipulate the video later,
    # it might be tricky if I don't return the DB ID.
    # Wait, the prompt says "BACKEND RESPONSE (JSON SHAPE)... id: okchumv725e". This is the XVideos ID.
    # But the dashboard displays videos from DB.
    # If I implement "Import", I am adding to DB.
    # The frontend will probably reload or add to the list.
    # If the frontend adds to the list using this JSON, it will have the XVideos ID, not DB ID.
    # If the user clicks "Favorite", it sends the ID. If it sends "okchumv725e", the backend won't find it (expects int).
    # This suggests a conflict.
    # Option A: The frontend reloads the list after import (batch load).
    # Option B: The response should include the DB ID, maybe as a separate field or replacing 'id'.
    # The prompt says "BACKEND RESPONSE (JSON SHAPE) ... id: ...".
    # I will modify the response to include `db_id` or just rely on the fact that `id` in the prompt might be flexible or I should just return what is asked.
    # But for a functional dashboard, I'll return the requested shape. The user said "backend spracúva... priebežne renderuje UI".
    # If the user wants full functionality (like delete/fav) immediately on these items, they need DB ID.
    # I will add `db_id` to the response just in case, it doesn't hurt.
    
    meta['db_id'] = video_id
    return meta
    
@api_v1_router.post("/import/spankbang")
@api_legacy_router.post("/import/spankbang")
async def import_spankbang(data: SpankBangImportRequest, db: Session = Depends(get_db)):
    """
    Import single SpankBang URL, extract metadata, and save to DB.
    """
    from extractors.spankbang import SpankBangExtractor
    sb = SpankBangExtractor()
    meta_raw = await sb.extract_metadata(data.url)
    
    if not meta_raw or not meta_raw.get('found'):
         return JSONResponse(status_code=400, content={"error": "EXTRACTION_FAILED"})
         
    # Check if exists
    existing = db.query(Video).filter(Video.source_url == data.url).first()
    if existing:
        existing.url = meta_raw['stream_url']
        existing.status = 'ready'
        db.commit()
        db.refresh(existing)
        video_id = existing.id
    else:
        video = Video(
            title=meta_raw['title'],
            url=meta_raw['stream_url'],
            source_url=data.url,
            thumbnail_path=meta_raw['thumbnail_url'],
            duration=meta_raw['duration'],
            status='ready',
            storage_type='remote',
            tags=",".join(meta_raw.get('tags', []))
        )
        db.add(video)
        db.commit()
        db.refresh(video)
        video_id = video.id

    # Format response for frontend
    response = {
        "source": "spankbang",
        "id": data.url.split('/')[-1],
        "db_id": video_id,
        "title": meta_raw['title'],
        "duration": meta_raw['duration'],
        "thumbnail": meta_raw['thumbnail_url'],
        "stream": {
            "type": "hls" if ".m3u8" in (meta_raw['stream_url'] or "").lower() else "mp4",
            "url": meta_raw['stream_url'],
            "height": 1080 if "1080p" in (meta_raw.get('quality_source') or "").lower() else 0,
            "width": 1920 if "1080p" in (meta_raw.get('quality_source') or "").lower() else 0
        },
        "tags": meta_raw.get('tags', [])
    }
    return response

@api_v1_router.post("/import/eporner_search")
@api_legacy_router.post("/import/eporner_search")
async def import_eporner_search(bg_tasks: BackgroundTasks, data: EpornerSearchRequest = Body(...), db: Session = Depends(get_db)):
    batch = data.batch_name or f"Eporner {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    videos = fetch_eporner_videos(query=data.query, per_page=data.count, hd=1 if data.min_quality >= 720 else 0, order="newest")
    new_ids = []
    for v in videos:
        video = Video(
            title=(v["title"] or "Queued...") if v["title"] else "Queued...",
            url=v["video_url"] or v["url"],
            source_url=v["url"], # Eporner page URL
            batch_name=batch,
            status="pending",
            thumbnail_path=v["thumbnail"],
            created_at=datetime.datetime.utcnow()
        )
        db.add(video); db.flush(); new_ids.append(video.id)
    db.commit()
    processor = VIPVideoProcessor()
    bg_tasks.add_task(processor.process_batch, new_ids)
    return {"count": len(new_ids), "batch": batch, "message": f"Added {len(new_ids)} Eporner videos"}

@api_v1_router.post("/import/hqporner")
@api_legacy_router.post("/import/hqporner")
async def import_hqporner(bg_tasks: BackgroundTasks, data: HQPornerImportRequest, db: Session = Depends(get_db)):
    """
    Search and import videos from HQPorner based on keywords, quality, and date filters.
    """
    from extractors.hqporner import HQPornerExtractor
    extractor = HQPornerExtractor()
    
    keywords_list = [k.strip() for k in data.keywords.split(',') if k.strip()] if data.keywords else []
    batch = data.batch_name or f"HQPorner {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    page = 1
    max_pages = 5
    
    while total_found < data.count and page <= max_pages:
        # Use category search for 4K quality (keyword search doesn't filter properly on HQPorner)
        if data.category or (data.min_quality and data.min_quality.lower() in ['2160p', '4k']):
            category = data.category or '4k-porn'
            # Pass keywords to category search for filtering within category
            results = await asyncio.to_thread(extractor.search_category, category, page, data.min_quality, data.added_within, ' '.join(keywords_list) if keywords_list else '')
        elif keywords_list:
            results = await asyncio.to_thread(extractor.search, ' '.join(keywords_list), data.min_quality, data.added_within, page)
        else:
            break
            
        if not results:
            break
            
        all_results.extend(results)
        total_found = len(all_results)
        page += 1
    
    # Limit to requested count
    all_results = all_results[:data.count]
    
    # Queue background task to process videos
    async def process_hqporner_batch():
        from app.database import SessionLocal
        
        async def process_single_video(video_data):
            db_task = SessionLocal()
            video_id = None
            try:
                # 1. Check if already exists
                existing = db_task.query(Video).filter(Video.source_url == video_data['url']).first()
                if existing:
                    return

                # 2. Create entry in 'processing' status
                video = Video(
                    title=video_data.get('title', 'Untitled'),
                    url="", 
                    source_url=video_data['url'],
                    thumbnail_path=video_data.get('thumbnail', ''),
                    duration=video_data.get('duration', 0),
                    height=video_data.get('height', 1080),
                    width=video_data.get('width', 1920),
                    status="processing",
                    batch_name=batch,
                    storage_type="remote",
                    created_at=datetime.datetime.utcnow()
                )
                db_task.add(video)
                db_task.commit()
                db_task.refresh(video)
                video_id = video.id

                # Notify UI immediately
                await manager.broadcast(json.dumps({
                    "type": "new_video",
                    "video": {
                        "id": video.id,
                        "title": video.title,
                        "thumbnail_path": video.thumbnail_path,
                        "batch_name": video.batch_name,
                        "status": video.status
                    }
                }))

                # 3. Resolve stream URL with timeout
                try:
                    meta = await asyncio.wait_for(extractor.extract(video.source_url), timeout=30)
                    if meta and meta.get('stream_url'):
                        video.url = meta['stream_url']
                        video.status = "ready"
                    else:
                        video.status = "error"
                        video.error_msg = "Could not extract stream URL"
                except asyncio.TimeoutError:
                    video.status = "error"
                    video.error_msg = "Extraction timed out"
                except Exception as e:
                    video.status = "error"
                    video.error_msg = str(e)

                db_task.commit()

                # Notify UI of status change
                await manager.broadcast(json.dumps({
                    "type": "status_update",
                    "video_id": video.id,
                    "status": video.status,
                    "title": video.title,
                    "thumbnail_path": video.thumbnail_path
                }))

            except Exception as e:
                logging.error(f"Critical error in HQPorner processing for {video_data.get('url')}: {e}")
                if video_id:
                    try:
                        v = db_task.query(Video).get(video_id)
                        if v:
                            v.status = "error"
                            v.error_msg = str(e)
                            db_task.commit()
                    except: pass
                db_task.rollback()
            finally:
                db_task.close()

        # Run all extractions in parallel
        tasks = [process_single_video(vd) for vd in all_results]
        await asyncio.gather(*tasks)

    bg_tasks.add_task(process_hqporner_batch)
    
    return {
        "status": "success",
        "count": len(all_results),
        "batch": batch,
        "message": f"Queued {len(all_results)} videos from HQPorner"
    }

@api_v1_router.post("/import/beeg")
@api_legacy_router.post("/import/beeg")
async def import_beeg(bg_tasks: BackgroundTasks, data: BeegImportRequest, db: Session = Depends(get_db)):
    """
    Crawl and import videos from Beeg.com using the beeg_crawler.py script.
    """
    batch = data.batch_name or f"Beeg {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    async def run_beeg_crawler():
        """Background task to run the Beeg crawler and import results"""
        import tempfile
        db_task = SessionLocal()
        
        try:
            # Create temporary file for crawler output
            with tempfile.NamedTemporaryFile(mode='w+', suffix='.json', delete=False) as tmp_file:
                tmp_path = tmp_file.name
            
            # Run the crawler script
            cmd = [
                sys.executable,
                "beeg_crawler.py",
                "--query", data.query,
                "--max_results", str(data.count),
                "--output", tmp_path
            ]
            
            logging.info(f"Running Beeg crawler: {' '.join(cmd)}")
            result = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )
            
            if result.returncode != 0:
                logging.error(f"Beeg crawler failed: {result.stderr}")
                await manager.log(f"Beeg crawl failed: {result.stderr[:200]}", "error")
                return
            
            # Read the results
            with open(tmp_path, 'r', encoding='utf-8') as f:
                crawler_results = json.load(f)
            
            # Clean up temp file
            os.unlink(tmp_path)
            
            if not crawler_results:
                await manager.log("Beeg crawler returned no results", "warning")
                return
            
            # Import each video
            imported_count = 0
            for video_data in crawler_results:
                try:
                    page_url = video_data.get('video_url', '')
                    stream_url = video_data.get('stream_url', '')
                    
                    if not page_url:
                        continue
                    
                    # Skip if no stream URL was extracted
                    if not stream_url:
                        logging.warning(f"No stream URL for {video_data.get('title', 'Unknown')}, skipping")
                        continue
                    
                    # Check if already exists
                    existing = db_task.query(Video).filter(Video.source_url == page_url).first()
                    if existing:
                        continue
                    
                    # Parse duration (format: "MM:SS" or "HH:MM:SS")
                    duration_str = video_data.get('duration', '0:00')
                    duration_parts = duration_str.split(':')
                    if len(duration_parts) == 2:
                        duration = int(duration_parts[0]) * 60 + int(duration_parts[1])
                    elif len(duration_parts) == 3:
                        duration = int(duration_parts[0]) * 3600 + int(duration_parts[1]) * 60 + int(duration_parts[2])
                    else:
                        duration = 0
                    
                    # Download and save thumbnail locally to avoid CORS issues
                    thumbnail_path = ""
                    if video_data.get('thumbnail'):
                        try:
                            thumb_url = video_data['thumbnail']
                            # Create thumbnails directory if it doesn't exist
                            thumb_dir = os.path.join("app", "static", "thumbnails")
                            os.makedirs(thumb_dir, exist_ok=True)
                            
                            # Generate filename from video ID or hash
                            import hashlib
                            thumb_hash = hashlib.md5(page_url.encode()).hexdigest()
                            thumb_filename = f"beeg_{thumb_hash}.jpg"
                            thumb_path = os.path.join(thumb_dir, thumb_filename)
                            
                            # Download thumbnail
                            async with http_session.get(thumb_url) as resp:
                                if resp.status == 200:
                                    with open(thumb_path, 'wb') as f:
                                        f.write(await resp.read())
                                    thumbnail_path = f"/static/thumbnails/{thumb_filename}"
                        except Exception as e:
                            logging.error(f"Error downloading thumbnail: {e}")
                            # Use original URL as fallback (will be proxied by frontend)
                            thumbnail_path = video_data.get('thumbnail', '')
                    
                    # If stream_url is an HLS playlist, extract the highest quality .mp4 URL
                    final_video_url = stream_url
                    if stream_url and '.m3u8' not in stream_url and 'multi=' in stream_url:
                        # This is a Beeg multi-quality URL, extract the best quality
                        try:
                            async with http_session.get(stream_url) as resp:
                                if resp.status == 200:
                                    playlist_content = await resp.text()
                                    # Parse m3u8 playlist to find highest quality stream
                                    lines = playlist_content.split('\n')
                                    best_url = None
                                    best_bandwidth = 0
                                    
                                    for i, line in enumerate(lines):
                                        if line.startswith('#EXT-X-STREAM-INF'):
                                            # Extract bandwidth
                                            bandwidth_match = re.search(r'BANDWIDTH=(\d+)', line)
                                            if bandwidth_match:
                                                bandwidth = int(bandwidth_match.group(1))
                                                # Next line should be the URL
                                                if i + 1 < len(lines):
                                                    url = lines[i + 1].strip()
                                                    if url and bandwidth > best_bandwidth:
                                                        best_bandwidth = bandwidth
                                                        # Make absolute URL if relative
                                                        if not url.startswith('http'):
                                                            base_url = '/'.join(stream_url.split('/')[:-1])
                                                            best_url = f"{base_url}/{url}"
                                                        else:
                                                            best_url = url
                                    
                                    if best_url:
                                        final_video_url = best_url
                                        logging.info(f"Extracted best quality URL: {best_url[:100]}...")
                        except Exception as e:
                            logging.error(f"Error parsing HLS playlist: {e}")
                            # Keep original URL as fallback
                    
                    # Create video entry
                    video = Video(
                        title=video_data.get('title', 'Untitled'),
                        url=final_video_url,  # Use the final URL (parsed from HLS if needed)
                        source_url=page_url,
                        thumbnail_path=thumbnail_path,
                        duration=duration,
                        tags=','.join(video_data.get('tags', [])),
                        batch_name=batch,
                        status="ready",
                        storage_type="remote",
                        created_at=datetime.datetime.utcnow()
                    )
                    
                    db_task.add(video)
                    db_task.flush()
                    imported_count += 1
                    
                    # Notify UI
                    await manager.broadcast(json.dumps({
                        "type": "new_video",
                        "video": {
                            "id": video.id,
                            "title": video.title,
                            "thumbnail_path": video.thumbnail_path,
                            "batch_name": video.batch_name,
                            "status": video.status
                        }
                    }))
                    
                except Exception as e:
                    logging.error(f"Error importing Beeg video {video_data.get('title')}: {e}")
                    continue
            
            db_task.commit()
            await manager.log(f"✓ Imported {imported_count} videos from Beeg", "success")
            
        except subprocess.TimeoutExpired:
            logging.error("Beeg crawler timed out")
            await manager.log("Beeg crawler timed out after 5 minutes", "error")
        except Exception as e:
            logging.error(f"Beeg import error: {e}")
            await manager.log(f"Beeg import error: {str(e)[:200]}", "error")
            db_task.rollback()
        finally:
            db_task.close()
    
    bg_tasks.add_task(run_beeg_crawler)
    
    return {
        "status": "success",
        "count": data.count,
        "batch": batch,
        "message": f"Started Beeg crawl for '{data.query}'"
    }

@api_v1_router.post("/import/redgifs")
@api_legacy_router.post("/import/redgifs")
async def import_redgifs(bg_tasks: BackgroundTasks, data: RedGifsImportRequest, db: Session = Depends(get_db)):
    """
    Search and import videos from RedGIFs based on keywords.
    """
    from .extractors.redgifs import RedGifsExtractor
    extractor = RedGifsExtractor()
    
    keywords_list = [k.strip() for k in data.keywords.split(',') if k.strip()]
    batch = data.batch_name or f"RedGIFs {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    
    for kw in keywords_list:
        results = extractor.search(kw, count=data.count, hd_only=data.hd_only)
        for res in results:
            # Quick check if title/tags contain rejected words
            rejected = ["meme", "edit", "compilation", "remix", "gif", "loop"]
            title_low = res['title'].lower()
            tags_low = [t.lower() for t in res['tags']]
            if any(r in title_low for r in rejected) or any(any(r in t for r in rejected) for t in tags_low):
                continue
                
            # Check if exists
            existing = db.query(Video).filter(Video.source_url == res['page_url']).first()
            if existing: continue
            
            all_results.append(res)
            total_found += 1
            
    if all_results:
        # Move processing to background to allow metadata (FFprobe) checks if needed
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_resolution, data.only_vertical, data.disable_rejection)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} candidates from RedGIFs"}

@api_v1_router.post("/import/reddit")
@api_legacy_router.post("/import/reddit")
async def import_reddit(bg_tasks: BackgroundTasks, data: RedditImportRequest, db: Session = Depends(get_db)):
    """
    Search and import videos from Reddit subreddits.
    """
    from .extractors.reddit import RedditExtractor
    extractor = RedditExtractor()
    
    subs_list = [s.strip() for s in data.subreddits.split(',') if s.strip()]
    batch = data.batch_name or f"Reddit {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    
    for s in subs_list:
        candidates = extractor.search_subreddit(s, limit=data.count)
        for c in candidates:
            # Check if exists
            existing = db.query(Video).filter(Video.source_url == c['permalink']).first()
            if existing: continue
            
            all_results.append({
                "title": c['title'],
                "page_url": c['permalink'],
                "reddit_url": c['url'], # v.redd.it url
                "tags": [s] # subreddit as tag
            })
            total_found += 1
            
    if all_results:
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_resolution, data.only_vertical, data.disable_rejection, is_reddit=True)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} candidates from Reddit"}

@api_v1_router.post("/import/pornone")
@api_legacy_router.post("/import/pornone")
async def import_pornone(bg_tasks: BackgroundTasks, data: PornOneImportRequest, db: Session = Depends(get_db)):
    """
    Search and import videos from PornOne based on keywords.
    """
    from .extractors.pornone import PornOneExtractor
    extractor = PornOneExtractor()
    
    keywords_list = [k.strip() for k in data.keywords.split(',') if k.strip()]
    batch = data.batch_name or f"PornOne {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    
    for kw in keywords_list:
        results = extractor.search(kw, count=data.count)
        for res in results:
            # Check if exists
            existing = db.query(Video).filter(Video.source_url == res['page_url']).first()
            if existing: continue
            
            all_results.append(res)
            total_found += 1
            
    if all_results:
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_resolution, data.only_vertical, is_pornone=True, debug=data.debug)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} candidates from PornOne"}

@api_v1_router.post("/import/tnaflix")
@api_legacy_router.post("/import/tnaflix")
async def import_tnaflix(bg_tasks: BackgroundTasks, data: TnaflixImportRequest, db: Session = Depends(get_db)):
    """
    Import videos from Tnaflix profile or video URL.
    """
    from .extractors.tnaflix import TnaflixExtractor
    extractor = TnaflixExtractor()
    
    batch = data.batch_name or f"Tnaflix {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    all_results = []
    
    if data.url:
        if "/profile/" in data.url or "/user/" in data.url:
            # Profile import
            results = await asyncio.to_thread(extractor.extract_from_profile, data.url, max_results=data.count)
            all_results.extend([{
                "title": r['title'],
                "page_url": r.get('source_url') or data.url, # Fallback
                "video_url": r['stream_url'],
                "thumbnail": r['thumbnail'],
                "duration": r['duration'],
                "tags": r['tags'].split(',') if r['tags'] else []
            } for r in results])
        else:
            # Single video import
            meta = await asyncio.to_thread(extractor.extract, data.url)
            if meta and meta.get('stream_url'):
                all_results.append({
                    "title": meta['title'],
                    "page_url": data.url,
                    "video_url": meta['stream_url'],
                    "thumbnail": meta['thumbnail'],
                    "duration": meta['duration'],
                    "tags": meta['tags'].split(',') if meta['tags'] else []
                })
    
    total_found = len(all_results)
    if all_results:
        # Tnaflix extractor doesn't provide resolution, process_batch_import_with_filters will use ffprobe
        # We pass only_vertical=False as it's not requested for Tnaflix specifically in the prompt, but filters are applied.
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_quality, False)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} videos from Tnaflix"}

@api_v1_router.post("/import/xvideos_playlist")
@api_legacy_router.post("/import/xvideos_playlist")
async def import_xvideos_playlist(bg_tasks: BackgroundTasks, data: XVideosPlaylistImportRequest, db: Session = Depends(get_db)):
    """
    Import up to 500 videos from an XVideos playlist/favorite URL.
    """
    from .services import extract_playlist_urls
    
    batch = data.batch_name or f"XVideos PL {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    # Delegate extraction to background process for immediate return and robustness
    # But for better UX, we can do a quick check here if it's truly a playlist
    if "xvideos.com" not in data.url:
         return JSONResponse(status_code=400, content={"error": "INVALID_URL", "message": "Only XVideos URLs are supported."})
         
    bg_tasks.add_task(background_import_process, [data.url], batch, "yt-dlp", None, None, None, True)
    
    return {"status": "queued", "batch": batch, "message": "XVideos playlist expansion started in background."}



@api_v1_router.post("/import/eporner_discovery")
@api_legacy_router.post("/import/eporner_discovery")
async def eporner_discovery(data: EpornerDiscoveryRequest):
    """
    Eporner Smart Discovery - Scrapes tag pages directly via HTML parsing.
    Returns preview results for user to select before importing.
    """
    try:
        # Run scraper in thread pool to avoid blocking
        results = await asyncio.to_thread(
            scrape_eporner_discovery,
            keyword=data.keyword,
            min_quality=data.min_quality,
            pages=data.pages,
            auto_skip_low_quality=data.auto_skip_low_quality
        )
        
        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": sum(1 for v in results if v.get('matched', False)),
            "keyword": data.keyword,
            "min_quality": data.min_quality
        }
    except Exception as e:
        logging.error(f"[EPORNER_DISCOVERY] Endpoint error: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )

@api_v1_router.post("/import/eporner_discovery/import")
@api_legacy_router.post("/import/eporner_discovery/import")
async def eporner_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    db: Session = Depends(get_db)
):
    """
    Import selected videos from Eporner Discovery results.
    Accepts a list of video page URLs to import.
    """
    try:
        batch = batch_name or f"Eporner Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []
        
        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue
            
            # Create video entry with pending status
            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.utcnow()
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)
        
        db.commit()
        
        # Process videos in background
        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)
        
        logging.info(f"[EPORNER_DISCOVERY_IMPORT] Queued {len(new_ids)} videos for import")
        
        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from Eporner Discovery"
        }
    except Exception as e:
        logging.error(f"[EPORNER_DISCOVERY_IMPORT] Error: {e}")
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/porntrex_discovery")
@api_legacy_router.post("/import/porntrex_discovery")
async def porntrex_discovery(data: PorntrexDiscoveryRequest):
    """
    Porntrex Smart Discovery - Scrapes search/category pages with concurrent video fetching.
    Returns preview results for user to select before importing.
    """
    try:
        # Validate input
        if not data.keyword and not data.category:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "Either keyword or category must be provided"}
            )

        # Run scraper in thread pool to avoid blocking
        results = await asyncio.to_thread(
            scrape_porntrex_discovery,
            keyword=data.keyword,
            min_quality=data.min_quality,
            pages=data.pages,
            category=data.category,
            upload_type=data.upload_type,
            auto_skip_low_quality=data.auto_skip_low_quality
        )

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": len(results),
            "keyword": data.keyword or data.category,
            "min_quality": data.min_quality
        }
    except Exception as e:
        logging.error(f"[PORNTREX_DISCOVERY] Endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/porntrex_discovery/import")
@api_legacy_router.post("/import/porntrex_discovery/import")
async def porntrex_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    db: Session = Depends(get_db)
):
    """
    Import selected videos from Porntrex Discovery results.
    Accepts a list of video page URLs to import.
    """
    try:
        batch = batch_name or f"Porntrex Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue

            # Check if already exists
            existing = db.query(Video).filter(Video.url == url).first()
            if existing:
                logging.info(f"[PORNTREX_DISCOVERY_IMPORT] Skipping duplicate: {url}")
                continue

            # Create video entry with pending status
            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.utcnow()
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()

        # Process videos in background
        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        logging.info(f"[PORNTREX_DISCOVERY_IMPORT] Queued {len(new_ids)} videos for import")

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from Porntrex Discovery"
        }
    except Exception as e:
        logging.error(f"[PORNTREX_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/whoreshub_discovery")
@api_legacy_router.post("/import/whoreshub_discovery")
async def whoreshub_discovery(data: WhoresHubDiscoveryRequest):
    """
    WhoresHub Smart Discovery - Scrapes search/tag/category pages with filtering.
    Returns preview results for user to select before importing.
    """
    try:
        # Run scraper in thread pool to avoid blocking
        results = await asyncio.to_thread(
            scrape_whoreshub_discovery,
            keyword=data.keyword,
            tag=data.tag,
            min_quality=data.min_quality,
            min_duration=data.min_duration,
            pages=data.pages,
            upload_type=data.upload_type,
            auto_skip_low_quality=data.auto_skip_low_quality
        )

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": len(results),
            "keyword": data.keyword or data.tag or "latest",
            "min_quality": data.min_quality,
            "min_duration": data.min_duration
        }
    except Exception as e:
        logging.error(f"[WHORESHUB_DISCOVERY] Endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/whoreshub_discovery/import")
@api_legacy_router.post("/import/whoreshub_discovery/import")
async def whoreshub_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    db: Session = Depends(get_db)
):
    """
    Import selected videos from WhoresHub Discovery results.
    Accepts a list of video page URLs to import.
    """
    try:
        batch = batch_name or f"WhoresHub Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue

            # Check if already exists
            existing = db.query(Video).filter(Video.url == url).first()
            if existing:
                logging.info(f"[WHORESHUB_DISCOVERY_IMPORT] Skipping duplicate: {url}")
                continue

            # Create video entry with pending status
            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.utcnow()
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()

        # Process videos in background
        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        logging.info(f"[WHORESHUB_DISCOVERY_IMPORT] Queued {len(new_ids)} videos for import")

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from WhoresHub Discovery"
        }
    except Exception as e:
        logging.error(f"[WHORESHUB_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/leakporner_discovery")
@api_legacy_router.post("/import/leakporner_discovery")
async def leakporner_discovery(data: LeakPornerDiscoveryRequest):
    """
    LeakPorner Discovery - Scrapes listing pages and returns preview results.
    """
    try:
        results = await asyncio.to_thread(
            scrape_leakporner_discovery,
            keyword=data.keyword,
            pages=data.pages,
            min_duration=data.min_duration,
            sort=data.sort,
        )

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": len(results),
            "keyword": data.keyword or "latest",
            "min_duration": data.min_duration,
            "sort": data.sort,
        }
    except Exception as e:
        logging.error(f"[LEAKPORNER_DISCOVERY] Endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/leakporner_discovery/import")
@api_legacy_router.post("/import/leakporner_discovery/import")
async def leakporner_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    db: Session = Depends(get_db)
):
    """
    Import selected videos from LeakPorner Discovery results.
    Accepts a list of video page URLs to import.
    """
    try:
        batch = batch_name or f"LeakPorner Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue

            existing = db.query(Video).filter(Video.url == url).first()
            if existing:
                logging.info(f"[LEAKPORNER_DISCOVERY_IMPORT] Skipping duplicate: {url}")
                continue

            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.utcnow()
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()

        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        logging.info(f"[LEAKPORNER_DISCOVERY_IMPORT] Queued {len(new_ids)} videos for import")

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from LeakPorner Discovery"
        }
    except Exception as e:
        logging.error(f"[LEAKPORNER_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


async def process_batch_import_with_filters(candidates: List[dict], batch: str, min_dur: int, min_res: int, only_vert: bool, disable_rejection: bool = False, is_reddit: bool = False, is_pornone: bool = False, debug: bool = False):
    """
    Background job to resolve metadata and add to DB with summary reporting.
    """
    db = SessionLocal()
    processor = VIPVideoProcessor()
    
    stats = {
        "scanned": len(candidates),
        "imported": 0,
        "skipped_short": 0,
        "skipped_low_res": 0,
        "skipped_vertical": 0,
        "skipped_keywords": 0,
        "skipped_exists": 0,
        "error": 0,
        "rejected_samples": []  # List of {title, reason}
    }
    
    # Decision trace logger (simple list)
    trace = []

    from .extractors.reddit import RedditExtractor
    from .extractors.pornone import PornOneExtractor
    reddit_ext = RedditExtractor() if is_reddit else None
    pornone_ext = PornOneExtractor() if is_pornone else None
    
    new_ids = []
    import re
    
    for c in candidates:
        decision = {"title": c.get('title', 'Unknown'), "status": "pending", "reason": ""}
        try:
            # 0. Title/Tag Rejection
            if not disable_rejection:
                rejected_terms = ["meme", "edit", "compilation", "remix", "gif", "loop"]
                title_low = c['title'].lower()
                tags_low = [t.lower() for t in c.get('tags', [])]
                
                found_bad = False
                for bad in rejected_terms:
                    # Using word boundary logic
                    if re.search(rf"\b{re.escape(bad)}\b", title_low):
                        found_bad = True; decision["reason"] = f"Keyword Block (Title): {bad}"; break
                    if any(re.search(rf"\b{re.escape(bad)}\b", t) for t in tags_low):
                        found_bad = True; decision["reason"] = f"Keyword Block (Tag): {bad}"; break
                
                if found_bad:
                    decision["status"] = "rejected"
                    stats["skipped_keywords"] += 1
                    trace.append(decision)
                    stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                    continue

            # NOTE: PornOne restrictive allowlist has been REMOVED as per audit request.
            # It was causing 95% of valid results to be dropped silently.
            # Use 'disable_rejection' in request if you need to bypass the standard blocklist above.

            video_url = c.get('video_url')
            thumbnail = c.get('thumbnail')
            duration = c.get('duration') or 0
            width = c.get('width') or 0
            height = c.get('height') or 0
            
            if is_reddit:
                # Need to resolve v.redd.it
                dur, w, h, real_url = reddit_ext.get_video_info(c['reddit_url'])
                if not real_url: 
                    decision["status"] = "error"
                    decision["reason"] = "Reddit resolution failed"
                    stats["error"] += 1
                    trace.append(decision)
                    continue
                video_url = real_url
                duration = dur or 0
                width = w or 0
                height = h or 0
            elif is_pornone:
                # Need to resolve detail page
                meta = await pornone_ext.extract(c['page_url'])
                if not meta or not meta.get('stream_url'):
                    decision["status"] = "error"
                    decision["reason"] = "PornOne extraction failed"
                    stats["error"] += 1
                    trace.append(decision)
                    continue
                video_url = meta['stream_url']
                duration = meta.get('duration') or duration # Use search duration if extract fails
                width = meta.get('width') or 0
                height = meta.get('height') or 0
                thumbnail = meta.get('thumbnail') or thumbnail
            else:
                # RedGIFs - optionally check metadata if filters are set
                if min_dur > 0 or min_res > 0 or only_vert:
                    # Quick ffprobe
                    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration", "-of", "json", video_url]
                    res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
                    if res.returncode == 0:
                        p_data = json.loads(res.stdout)
                        stream = p_data["streams"][0]
                        duration = float(stream.get("duration", 0))
                        width = int(stream.get("width", 0))
                        height = int(stream.get("height", 0))
                    else:
                        decision["status"] = "error"
                        decision["reason"] = "FFProbe failed"
                        stats["error"] += 1
                        trace.append(decision)
                        continue
            
            # Apply "Brutal Tier" Filters
            min_duration_seconds = min_dur # Explicit naming
            if min_duration_seconds > 0 and duration < min_duration_seconds: 
                decision["status"] = "rejected"
                decision["reason"] = f"Too Short ({int(duration)}s < {min_duration_seconds}s)"
                stats["skipped_short"] += 1
                trace.append(decision)
                stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                continue
            
            if min_res > 0 and max(width, height) < min_res: 
                decision["status"] = "rejected"
                decision["reason"] = f"Low Res ({max(width, height)}p < {min_res}p)"
                stats["skipped_low_res"] += 1
                trace.append(decision)
                stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                continue
                
            if only_vert and height <= width:
                decision["status"] = "rejected"
                decision["reason"] = "Not Vertical"
                stats["skipped_vertical"] += 1
                trace.append(decision)
                stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                continue
            
            # Check for Duplicate
            existing = db.query(Video).filter(Video.source_url == c['page_url']).first()
            if existing:
                 decision["status"] = "rejected"
                 decision["reason"] = "Duplicate (Already Imported)"
                 stats["skipped_exists"] += 1
                 trace.append(decision)
                 continue

            video = Video(
                title=c['title'],
                url=video_url,
                source_url=c['page_url'],
                thumbnail_path=thumbnail,
                batch_name=batch,
                status="pending",
                tags=",".join(c.get('tags', [])),
                duration=int(duration) if duration else None,
                width=width if width else None,
                height=height if height else None,
                created_at=datetime.datetime.utcnow()
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)
            stats["imported"] += 1
            decision["status"] = "accepted"
            trace.append(decision)
            
            # Broadcast progress or new video
            processor.broadcast_new_video(video)
            
        except Exception as e:
            print(f"Error processing candidate {c.get('title')}: {e}")
            stats["error"] += 1
            decision["status"] = "error"
            decision["reason"] = str(e)
            trace.append(decision)
            
    db.commit()
    
    if debug:
        print("\n=== IMPORT DECISION TRACE ===")
        for t in trace:
            print(f"[{t['status'].upper()}] {t['title']} -> {t['reason']}")
        print("=============================\n")

    # Send Final Summary via WebSocket
    summary_msg = {
        "type": "import_summary",
        "batch": batch,
        "stats": stats,
        "debug": debug,
        "trace": trace if debug else [] # Only send full trace if debug enabled
    }
    await manager.broadcast(json.dumps(summary_msg))
    
    if new_ids:
        processor.process_batch(new_ids)
    db.close()

@api_v1_router.get("/search_external")
@api_legacy_router.get("/search_external")
async def search_external_endpoint(query: str):
    engine = ExternalSearchEngine()
    results = await engine.search(query)
    return results

@api_v1_router.get("/videos/recommendations")
@api_legacy_router.get("/videos/recommendations")
def get_recommendations(limit: int = 12, db: Session = Depends(get_db)):
    """
    Neural Discovery Engine: Recommends videos based on favorite and watched tags.
    """
    # 1. Get favorite/watched tags
    fav_videos = db.query(Video).filter(or_(Video.is_favorite == True, Video.is_watched == True)).all()
    
    all_tags = []
    for v in fav_videos:
        if v.tags: all_tags.extend([t.strip().lower() for t in v.tags.split(",") if t.strip()])
        if v.ai_tags: all_tags.extend([t.strip().lower() for t in v.ai_tags.split(",") if t.strip()])
    
    if not all_tags:
        # Fallback: Just return newest ready videos
        return db.query(Video).filter(Video.status == 'ready', Video.thumbnail_path.isnot(None)).order_by(desc(Video.id)).limit(limit).all()
    
    # 2. Rank tags by frequency
    tag_counts = collections.Counter(all_tags)
    top_tags = [t for t, count in tag_counts.most_common(5)]
    
    # 3. Find videos with these tags that haven't been watched yet
    watched_ids = [v.id for v in fav_videos if v.is_watched]
    
    recommended = []
    for tag in top_tags:
        videos = db.query(Video).filter(
            Video.status == 'ready',
            Video.thumbnail_path.isnot(None),
            Video.id.notin_(watched_ids),
            or_(Video.tags.contains(tag), Video.ai_tags.contains(tag))
        ).limit(limit).all()
        recommended.extend(videos)
    
    # 4. Mix and deduplicate
    unique_rec = []
    seen = set()
    for v in recommended:
        if v.id not in seen:
            unique_rec.append(v)
            seen.add(v.id)
            if len(unique_rec) >= limit: break
            
    # Final fallback if still too few
    if len(unique_rec) < limit:
        extra = db.query(Video).filter(Video.status == 'ready', Video.thumbnail_path.isnot(None), Video.id.notin_(list(seen))).limit(limit - len(unique_rec)).all()
        unique_rec.extend(extra)
        
    return unique_rec[:limit]

# --- TELEGRAM DEEP SEARCH AUTH ---
@api_v1_router.get("/settings/telegram/status")
@api_legacy_router.get("/settings/telegram/status")
async def tg_status():
    is_active = await tg_auth_manager.content_status()
    api_id_set = bool(config.TELEGRAM_API_ID)
    return {"is_connected": is_active, "has_creds": api_id_set}

@api_v1_router.post("/settings/telegram/login")
@api_legacy_router.post("/settings/telegram/login")
async def tg_login(req: TelegramLoginRequest):
    try:
        return await tg_auth_manager.send_code(req.api_id, req.api_hash, req.phone)
    except Exception as e:
        raise HTTPException(400, detail=str(e))

@api_v1_router.post("/settings/telegram/verify")
@api_legacy_router.post("/settings/telegram/verify")
async def tg_verify(req: TelegramVerifyRequest):
    try:
        if req.password and not req.code:
             return await tg_auth_manager.verify_password(req.password)
        return await tg_auth_manager.verify_code(req.code, req.password)
    except Exception as e:
        raise HTTPException(400, detail=str(e))

# --- VK STREAMING ENDPOINT ---
# VK URLs expire quickly, so we extract fresh stream URLs on-demand

@api_v1_router.get("/stream/vk/{video_id}")
@api_legacy_router.get("/stream/vk/{video_id}")
async def get_vk_stream(video_id: int, db: Session = Depends(get_db)):
    """
    Extract fresh VK stream URL on-demand.
    VK URLs expire quickly, so we use yt-dlp to get a fresh URL each time.
    Results are cached for 30 minutes to improve performance.
    """
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")
    
    # Check if this is a VK video
    source_url = video.source_url or video.url
    if not any(domain in source_url.lower() for domain in ['vk.com', 'vk.video', 'vkvideo.ru']):
        raise HTTPException(400, detail="Not a VK video")
    
    # Extract fresh stream URL using yt-dlp
    async def extract_vk_stream():
        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'extract_flat': False,
            'format': 'best',
            'ignoreerrors': True,
            'no_warnings': True,
            'user_agent': user_agent,
            'http_headers': {
                'User-Agent': user_agent,
                'Referer': 'https://vk.com/'
            }
        }
        
        # Try to use cookies if available
        import os
        if os.path.exists("vk.netscape.txt"):
            ydl_opts['cookiefile'] = "vk.netscape.txt"
        elif os.path.exists("cookies.netscape.txt"):
            ydl_opts['cookiefile'] = "cookies.netscape.txt"
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(source_url, download=False)
                if not info:
                    return None
                
                # Get best format
                formats = info.get('formats', [])
                best_format = None
                max_height = 0
                
                for f in formats:
                    if not f.get('url'):
                        continue
                    height = f.get('height') or 0
                    if height > max_height:
                        max_height = height
                        best_format = f
                
                # Fallback to info URL if no formats
                stream_url = best_format['url'] if best_format else info.get('url')
                is_hls = '.m3u8' in stream_url if stream_url else False
                
                return {
                    "stream_url": stream_url,
                    "is_hls": is_hls,
                    "height": max_height,
                    "duration": info.get('duration') or 0
                }
        except Exception as e:
            logging.error(f"VK stream extraction failed for {video_id}: {e}")
            return None
    
    result = await asyncio.to_thread(extract_vk_stream)
    
    if not result or not result.get('stream_url'):
        raise HTTPException(500, detail="Failed to extract VK stream URL")
    
    return result

# --- PROXY ---

@app.api_route("/stream_proxy/{video_id}.mp4", methods=["GET", "HEAD"])
async def proxy_video(video_id: str, request: Request, url: Optional[str] = None, db: Session = Depends(get_db)):
    v = None
    if url:
        # Generic URL proxying for search previews etc.
        target_url = url
        v_source_url = url
    else:
        v = db.query(Video).get(video_id)
        if not v: raise HTTPException(404)
        target_url = v.url
        v_source_url = v.source_url
    _cw_match = re.search(r"/videos/(\d+)", str(v_source_url or "") + " " + str(target_url or ""), re.I)
    cw_corr = f"cw:{_cw_match.group(1)}" if _cw_match else "cw:unknown"

    if not target_url:
        logging.error(f"Stream proxy requested for video {video_id} but target_url is empty")
        raise HTTPException(400, detail="Video URL is missing in the database. The video might be from a broken source.")

    # --- URL SANITIZATION ---
    # Strip malformed prefixes that can end up in the DB (e.g. "function/0/https://...")
    import re as _re
    _http_match = _re.search(r'https?://', target_url)
    if _http_match and _http_match.start() > 0:
        original_url = target_url
        target_url = target_url[_http_match.start():]
        logging.warning(f"Stripped malformed prefix from video {video_id} URL: '{original_url[:40]}' → '{target_url[:60]}'")
        if v:
            try:
                v.url = target_url
                db.commit()
                logging.info(f"Auto-healed URL in DB for video {video_id}")
            except Exception as _e:
                logging.warning(f"Could not auto-heal DB URL: {_e}")

    if not target_url.startswith(('http://', 'https://')):
        logging.error(f"Proxy attempt with non-HTTP URL for video {video_id}: '{target_url}'")
        raise HTTPException(500, detail=f"Invalid protocol or empty URL for proxy. Got: '{target_url}'")

    # --- OPTIMISTIC STREAMING (Fix for single-use tokens) ---
    range_header = request.headers.get('Range')

    def _looks_like_hls_payload(stream_url: str, content_type: str) -> bool:
        low_url = (stream_url or "").lower()
        low_ctype = (content_type or "").lower()
        if ".m3u8" in low_url:
            return True
        return any(
            token in low_ctype
            for token in (
                "application/vnd.apple.mpegurl",
                "application/x-mpegurl",
                "audio/mpegurl",
            )
        )

    # --- CAMWHORES: rnd=<unix_ms> is required for many get_file URLs (extension always includes it).
    if "camwhores" in target_url and "get_file" in target_url:
        from .extractors.camwhores import normalize_camwhores_get_file_rnd

        target_url = normalize_camwhores_get_file_rnd(target_url)

    async def get_request_params(v_url, ref_url):
        domain = urllib.parse.urlparse(v_url).netloc
        # Safe default: use the target stream domain as referer.
        # Site-specific branches below can override this when needed.
        referer = f"https://{domain}/"
        origin = None
        if "webshare.cz" in v_url or "wsfiles.cz" in v_url:
            referer = None
        elif "eporner.com" in v_url or (ref_url and "eporner.com" in ref_url):
            referer = ref_url if (ref_url and "eporner.com" in ref_url) else "https://www.eporner.com/"
        elif "xvideos." in v_url:
            referer = f"https://{domain}/"
        elif "erome.com" in v_url:
            referer = "https://www.erome.com/"
        elif "camwhores" in v_url:
            referer = ref_url if (ref_url and "camwhores.tv/videos/" in ref_url) else "https://www.camwhores.tv/"
        elif "bunkr" in v_url or "scdn.st" in v_url or any(
            x in (v_url or "").lower()
            for x in ("media-files", "stream-files", "milkshake", "cdn.", "bunkr.")
        ):
            ref = ref_url or ""
            if ref and ("bunkr" in ref.lower() or "/f/" in ref or "/v/" in ref):
                referer = ref if ref.endswith("/") else ref + "/"
            else:
                parsed_b = urllib.parse.urlparse(v_url)
                referer = f"{parsed_b.scheme}://{parsed_b.netloc}/"
        elif "filester." in (v_url or "").lower() or ("filester." in (ref_url or "").lower()):
            filester_ref = ref_url or ""
            if "filester." in filester_ref.lower():
                referer = filester_ref
            else:
                parsed_f = urllib.parse.urlparse(v_url)
                referer = f"{parsed_f.scheme}://{parsed_f.netloc}/"
            if referer:
                p = urllib.parse.urlparse(referer)
                origin = f"{p.scheme}://{p.netloc}"
        elif "mydaddy.cc" in v_url:
            referer = "https://hqporner.com/"
        elif any(x in (v_url or "").lower() for x in ("archivebate.com", "mxcontent.net", "mixdrop.", "m1xdrop.")) or (
            ref_url and "archivebate.com" in (ref_url or "").lower()
        ):
            # Archivebate/Mixdrop CDN links often require Archivebate referer context.
            if ref_url and "archivebate.com" in ref_url.lower():
                referer = ref_url if ref_url.endswith("/") else ref_url + "/"
            else:
                referer = "https://archivebate.com/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else None
        elif any(x in (v_url or "").lower() for x in ("rec-ur-bate.com", "recurbate.com")):
            # Recurbate streams are safest with the watch page or site root as Referer.
            if ref_url and any(x in ref_url.lower() for x in ("rec-ur-bate.com", "recurbate.com")):
                referer = ref_url if ref_url.endswith("/") else ref_url + "/"
            else:
                referer = "https://rec-ur-bate.com/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else None

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': referer,
            'Origin': origin,
            'Accept': '*/*',
            'Connection': 'keep-alive'
        }
        if range_header:
            headers['Range'] = range_header
        return {k: v for k, v in headers.items() if v is not None}

    # --- WEBSHARE FIX: Only for DB videos ---
    if v and ((target_url and target_url.startswith("webshare:")) or (target_url and "wsfiles.cz" in target_url)):
        async def resolve_webshare_upfront():
             try:
                 from extractors.webshare import WebshareAPI
                 ws = WebshareAPI()
                 ident = None
                 src = v_source_url or target_url
                 if src and "webshare:" in src:
                     ident = src.split(":", 2)[1]
                 elif src and "/file/" in src:
                     part = src.split('/file/')[1]
                     ident = part.split('/')[0] if '/' in part else part
                 
                 if not ident and 'wsfiles.cz' in (target_url or ""):
                     import re
                     match = re.search(r'/([a-zA-Z0-9]{10})/', target_url)
                     if match: ident = match.group(1)
                 
                 if ident:
                     logging.info(f"Resolving fresh Webshare link for {ident}...")
                     new_link = await asyncio.to_thread(ws.get_vip_link, ident)
                     return new_link
                 return None
             except Exception as e:
                 logging.error(f"Failed to resolve Webshare link upfront: {e}")
                 return None

        fresh_url = await resolve_webshare_upfront()
        if fresh_url:
            target_url = fresh_url
            try:
                v.url = fresh_url
                db.commit()
            except: pass
        elif target_url.startswith("webshare:"):
             raise HTTPException(502, detail="Could not resolve Webshare VIP link")

    try:
        if not target_url.startswith(('http://', 'https://')):
             logging.error(f"Proxy attempt with non-HTTP URL: {target_url}")
             raise HTTPException(500, detail=f"Invalid protocol for proxy: {target_url}")

        # Musí byť pred prvým použitím (cookies nižšie), inak UnboundLocalError → 500 na každom streame
        _combined_lower = f"{target_url or ''} {v_source_url or ''}".lower()
        is_unreliable = any(
            d in _combined_lower
            for d in [
                "vk.com", "vk.video", "vkvideo.ru", "okcdn.ru", "userapi.com",
                "vkvideo.net", "mycdn.me", "vk-cdn.net", "vkay.net", "vk.ru",
                "vkvideo.com", "ok.ru",
                "filester.gg", "filester.me", "cache1.filester.gg",
                "xvideos.com", "xvideos.red", "xv-video.com",
                "bunkr.cr", "bunkr.is", "bunkr.si", "bunkr.black", "bunkr.pk",
                "camwhores.tv", "cwvids.com",
                "leakporner.com", "luluvids.com", "luluvids.top",
                "archivebate.com", "mxcontent.net", "mixdrop.", "m1xdrop.",
                "rec-ur-bate.com", "recurbate.com",
            ]
        )
        # Keep VK-specific logic strictly for VK/OK domains only.
        is_vk = any(
            d in _combined_lower
            for d in [
                "vk.com", "vk.video", "vkvideo.ru", "okcdn.ru", "userapi.com",
                "vkvideo.net", "mycdn.me", "vk-cdn.net", "vkay.net", "vk.ru",
                "vkvideo.com", "ok.ru",
            ]
        )

        current_headers = await get_request_params(target_url, v_source_url)
        
        # Load cookies for VK/OK if available
        cookies = {}
        if is_vk:
            for cf in ['vk.netscape.txt', 'cookies.netscape.txt']:
                if os.path.exists(cf):
                    try:
                        with open(cf, 'r') as f:
                            for line in f:
                                if not line.startswith('#') and line.strip():
                                    parts = line.strip().split('\t')
                                    if len(parts) >= 7:
                                        cookies[parts[5]] = parts[6]
                        break
                    except: pass
        
        is_expired = False
        content_len = 0
        try:
            upstream_response = await http_session.get(target_url, headers=current_headers, cookies=cookies if cookies else None, allow_redirects=True, ssl=False)
            status_code = upstream_response.status
            content_len = int(upstream_response.headers.get('Content-Length', 0))
        except aiohttp.ClientError as e:
            logging.warning(f"Connection error proxying {target_url}: {e} - treating as expired.")
            is_expired = True
            status_code = 502
            upstream_response = None
        
        content_type = ""
        if upstream_response is not None:
            content_type = (upstream_response.headers.get("Content-Type") or "").lower()
            is_hls_payload = _looks_like_hls_payload(target_url, content_type)
            if not is_expired:
                is_expired = upstream_response.status in [403, 410, 401, 404]
            if 'na.mp4' in str(upstream_response.url) or (
                upstream_response.status == 200 and content_len < 100000 and not is_hls_payload
            ):
                is_expired = True

            # Eporner-specific expiration detection: 
            if (
                upstream_response.status == 200 
                and "eporner.com" in target_url 
                and (content_len == 5433 or content_type.startswith("text/html"))
            ):
                is_expired = True

            # Filester /d/<id> page URL or cache CDN can return HTML (200) instead of media URL.
            # Force smart refresh to resolve a direct stream.
            if "filester." in (target_url or "").lower() and (
                "/d/" in (target_url or "").lower()
                or "text/html" in content_type
                or content_len < 100000
            ):
                is_expired = True

            # XVideos/XVideos.red: if target_url is a watch page (not a stream), force refresh
            if any(x in (target_url or "").lower() for x in ["xvideos.com/video", "xvideos.red/video"]) and (
                "text/html" in content_type or not any(target_url.lower().endswith(e) for e in [".mp4", ".m3u8", ".webm", ".flv"])
            ):
                is_expired = True

            # VK/OK: ak je target_url ešte stránka videa, nie priamy súbor — treba refresh (is_vk už nastavené vyššie)
            if is_vk and "/video" in target_url and not ('.mp4' in target_url.lower() or '.m3u8' in target_url.lower()):
                is_expired = True
            
            # VK stream URL validation: Check if it's a valid stream or needs refresh
            if is_vk and not is_expired:
                # Check for content-length mismatch or other VK-specific issues
                if upstream_response.status == 200:
                    # If content-length is suspiciously small or missing, refresh
                    if content_len < 100000 or content_len == 0:
                        logging.warning(f"VK stream URL has suspicious content-length: {content_len}. Refreshing...")
                        is_expired = True

        _src_for_refresh = (v.source_url if v else None) or v_source_url
        if is_expired and (_src_for_refresh or is_vk):
            logging.info(f"[PROXY][{cw_corr}] Link for video {video_id} appears expired ({upstream_response.status}). Refreshing...")
            
            # For VK videos without source_url, try to use the current URL as source
            if v and is_vk and not v.source_url:
                logging.warning(f"VK video {video_id} missing source_url, using current URL")
                v.source_url = target_url
                db.commit()
            
            async def try_refresh():
                nonlocal upstream_response, current_headers, status_code, target_url
                if not v:
                    return False

                # 0. Camwhores quick ladder: refresh rnd and retry direct before heavier re-resolve.
                if "camwhores.tv/get_file" in (target_url or "").lower():
                    try:
                        from .extractors.camwhores import normalize_camwhores_get_file_rnd

                        retry_url = normalize_camwhores_get_file_rnd(target_url)
                        logging.info("[CW-L0][%s] rnd retry_url=%s", cw_corr, retry_url[:120])
                        retry_headers = await get_request_params(retry_url, v.source_url)
                        retry_resp = await http_session.get(retry_url, headers=retry_headers, allow_redirects=True, ssl=False)
                        retry_len = int(retry_resp.headers.get("Content-Length", "0") or 0)
                        retry_ctype = (retry_resp.headers.get("Content-Type") or "").lower()
                        logging.info("[CW-L0][%s] rnd-retry: status=%s ctype=%s len=%s", cw_corr, retry_resp.status, retry_ctype, retry_len)
                        if retry_resp.status in (200, 206) and (
                            retry_resp.status == 206 or retry_len >= 65536 or "video/" in retry_ctype
                        ):
                            upstream_response.close()
                            upstream_response = retry_resp
                            current_headers = retry_headers
                            status_code = retry_resp.status
                            target_url = retry_url
                            v.url = retry_url
                            db.commit()
                            logging.info("[CW-L0][%s] quick refresh succeeded, v.url committed", cw_corr)
                            return True
                        retry_resp.close()
                        logging.info("[CW-L0][%s] rnd-retry rejected — falling to deep refresh", cw_corr)
                    except Exception as e:
                        logging.warning("[CW-L0][%s] quick refresh exception: %s", cw_corr, e)

                # 1. Webshare Refresh
                if 'webshare.cz' in (v.source_url or "") or 'wsfiles.cz' in (v.source_url or "") or (v.url and "wsfiles.cz" in v.url):
                    try:
                        from extractors.webshare import WebshareAPI
                        ws = WebshareAPI()
                        ident = None
                        src = v.source_url or v.url
                        if src and "webshare:" in src:
                            ident = src.split(":", 2)[1]
                        elif src and "/file/" in src:
                            part = src.split('/file/')[1]
                            ident = part.split('/')[0] if '/' in part else part
                        
                        if not ident and 'wsfiles.cz' in (src or ""):
                            import re
                            match = re.search(r'/([a-zA-Z0-9]{10})/', src)
                            if match: ident = match.group(1)

                        if ident:
                            new_link = await asyncio.to_thread(ws.get_vip_link, ident)
                            if new_link:
                                upstream_response.close()
                                v.url = new_link
                                db.commit()
                                current_headers = await get_request_params(v.url, v.source_url)
                                upstream_response = await http_session.get(v.url, headers=current_headers, allow_redirects=True)
                                status_code = upstream_response.status
                                return True
                    except Exception as e:
                        logging.error(f"Webshare proxy refresh failed: {e}")
                    return False

                # 2. General/VK/Deep Refresh
                async def refresh_link_smart():
                    is_camwhores_source = bool(v.source_url and "camwhores.tv" in v.source_url.lower())
                    refresh_source_url = v.source_url or v.url
                    # Backward-compat for already imported Filester rows with source_url=/f/... .
                    if (
                        "filester." in (refresh_source_url or "").lower()
                        and "/f/" in (refresh_source_url or "").lower()
                        and "filester." in (v.url or "").lower()
                        and "/d/" in (v.url or "").lower()
                    ):
                        refresh_source_url = v.url

                    # --- Camwhores: use the same extractor as import/processing ---
                    if is_camwhores_source:
                        try:
                            from .extractors.camwhores import CamwhoresExtractor

                            logging.info("[CW-L2][%s] extractor refresh: %s", cw_corr, v.source_url)
                            _cw_extractor = CamwhoresExtractor()
                            _cw_result = await _cw_extractor.extract(v.source_url)
                            if _cw_result and _cw_result.get("stream_url"):
                                _resolved = _cw_result["stream_url"]
                                logging.info(
                                    "[CW-L2][%s] extractor(%s)→url=%s",
                                    cw_corr,
                                    _cw_result.get("_resolver") or "unknown",
                                    _resolved[:120],
                                )
                                return {
                                    "url": _resolved,
                                    "height": _cw_result.get("height") or 0,
                                    "_prevalidated": bool(_cw_result.get("_prevalidated")),
                                }
                            logging.warning("[CW-L2][%s] extractor returned no stream", cw_corr)
                        except Exception as _e:
                            logging.warning("[CW-L2][%s] extractor refresh error: %s", cw_corr, _e)
                        return None

                    # Try Plugin First (Eporner, Bunkr, Filester, XVideos, etc.) - FAST
                    try:
                        from .extractors.registry import ExtractorRegistry
                        from .extractors import init_registry, register_extended_extractors
                        # Ensure ALL extractors (including XVideos, Filester, etc.) are registered
                        init_registry()
                        register_extended_extractors()
                        plugin = ExtractorRegistry.find_extractor(refresh_source_url)
                        if plugin:
                             logging.info(f"[REFRESH] Using plugin {plugin.name} for refresh of video {v.id}")
                             res = await plugin.extract(refresh_source_url)
                             if res and res.get('stream_url'):
                                 return {'url': res['stream_url'], 'height': res.get('height')}
                             logging.warning(f"[REFRESH] Plugin {plugin.name} found no stream for {refresh_source_url}")
                    except Exception as e:
                         logging.warning(f"Plugin smart refresh failed: {e}")

                    # Fallback to yt-dlp for other deep sites (VK, xvideos, etc.)
                    def run_ytdlp():
                        is_deep = any(
                            x in (refresh_source_url or "")
                            for x in [
                                'xvideos.com', 'xvideos.red', 'xv-video.com',
                                'xhamster.com',
                                'eporner.com',
                                'spankbang.com',
                                'vk.com', 'vk.video', 'vkvideo.ru',
                                'pornhub.com',
                            ]
                        )
                        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        opts = {
                            'quiet': True, 'skip_download': True,
                            'format': 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best',
                            'extract_flat': False,
                            'socket_timeout': 20,
                            'user_agent': user_agent,
                            'http_headers': {'User-Agent': user_agent, 'Referer': refresh_source_url}
                        }
                        for cf in ['xvideos.netscape.txt', 'vk.netscape.txt', 'eporner.netscape.txt', 'cookies.netscape.txt']:
                            if os.path.exists(cf):
                                opts['cookiefile'] = cf
                                break
                        info = None
                        try:
                            with yt_dlp.YoutubeDL(opts) as ydl:
                                info = ydl.extract_info(refresh_source_url, download=False)
                        except (yt_dlp.utils.DownloadError, yt_dlp.utils.UnsupportedError) as e:
                            logging.warning("[CW-L2] yt-dlp cannot handle URL %s: %s", refresh_source_url, e)
                            return None
                        if not info:
                            return None
                        # Pick best video URL from formats list
                        best_url = info.get('url')
                        best_height = info.get('height') or 0
                        formats = info.get('formats', [])
                        if formats:
                            best_score = -1
                            for f in formats:
                                furl = f.get('url')
                                if not furl: continue
                                h = f.get('height') or 0
                                score = h * 10
                                if f.get('ext') == 'mp4': score += 5
                                if score > best_score:
                                    best_score = score
                                    best_url = furl
                                    best_height = h
                        return {'url': best_url, 'height': best_height}

                    return await asyncio.to_thread(run_ytdlp)

                try:
                    info = await refresh_link_smart()
                    if not info:
                        logging.warning("[CW-L2][%s] refresh_link_smart returned None", cw_corr)
                        return False

                    new_url = info.get('url')
                    # VK specific: might be in formats list
                    if not new_url and 'formats' in info:
                        max_h = 0
                        for f in info['formats']:
                            if f.get('url') and (f.get('height') or 0) >= max_h:
                                max_h = f.get('height') or 0
                                new_url = f['url']

                    logging.info("[CW-L2][%s] new_url resolved: %s", cw_corr, (new_url or "None")[:120])

                    if new_url:
                        upstream_response.close()
                        prevalidated = info.get("_prevalidated", False)

                        if prevalidated:
                            # CamwhoresExtractor already probed the URL internally.
                            # Skip re-probe — make ONE real request with the client's original
                            # Range header so the streamed response is correct.
                            logging.info("[CW-L2][%s] pre-validated → streaming directly (no re-probe)", cw_corr)
                            current_headers = await get_request_params(new_url, v.source_url)
                            upstream_response = await http_session.get(
                                new_url, headers=current_headers, allow_redirects=True, ssl=False
                            )
                            stream_ctype = (upstream_response.headers.get("Content-Type") or "").lower()
                            logging.info(
                                "[CW-L2][%s] stream-start: status=%s ctype=%s",
                                cw_corr, upstream_response.status, stream_ctype,
                            )
                            if upstream_response.status in (200, 206):
                                v.url = new_url
                                target_url = new_url
                                if info.get('height'):
                                    v.height = info['height']
                                db.commit()
                                status_code = upstream_response.status
                                logging.info("[CW-L2][%s] v.url committed → %s", cw_corr, new_url[:120])
                                # Backfill height/duration via ffprobe if still missing
                                if (not v.height or not v.duration) and v.source_url:
                                    _ffprobe_vid_id = v.id
                                    _ffprobe_url = new_url
                                    _ffprobe_ref = v.source_url
                                    async def _cw_bg_ffprobe():
                                        try:
                                            _proc = VIPVideoProcessor()
                                            _ff = await asyncio.to_thread(
                                                _proc._ffprobe_fallback,
                                                _ffprobe_url,
                                                {},
                                                _ffprobe_ref,
                                            )
                                            if _ff.get('height') or _ff.get('duration'):
                                                _bdb = SessionLocal()
                                                try:
                                                    _bv = _bdb.query(Video).get(_ffprobe_vid_id)
                                                    if _bv:
                                                        if _ff.get('height') and not _bv.height:
                                                            _bv.height = int(_ff['height'])
                                                        if _ff.get('width') and not _bv.width:
                                                            _bv.width = int(_ff['width'])
                                                        if _ff.get('duration') and not _bv.duration:
                                                            _bv.duration = float(_ff['duration'])
                                                        _bdb.commit()
                                                        logging.info(
                                                            "[CW-L2][%s] bg-ffprobe filled: h=%s dur=%s",
                                                            cw_corr, _ff.get('height'), _ff.get('duration')
                                                        )
                                                finally:
                                                    _bdb.close()
                                        except Exception as _fe:
                                            logging.warning("[CW-L2][%s] bg-ffprobe error: %s", cw_corr, _fe)
                                    asyncio.create_task(_cw_bg_ffprobe())
                                return True
                            upstream_response.close()
                            logging.warning(
                                "[CW-L2][%s] stream-start rejected: status=%s url=%s",
                                cw_corr, upstream_response.status, new_url[:120],
                            )
                        else:
                            # Standard candidate probe for non-extractor sources (VK, yt-dlp, etc.)
                            candidate_headers = await get_request_params(new_url, v.source_url)
                            candidate_resp = await http_session.get(
                                new_url, headers=candidate_headers, allow_redirects=True, ssl=False
                            )
                            candidate_len = int(candidate_resp.headers.get("Content-Length", "0") or 0)
                            candidate_ctype = (candidate_resp.headers.get("Content-Type") or "").lower()
                            candidate_is_hls = _looks_like_hls_payload(new_url, candidate_ctype)
                            logging.info(
                                "[CW-L2][%s] candidate probe → status=%s ctype=%s len=%s",
                                cw_corr, candidate_resp.status, candidate_ctype, candidate_len,
                            )
                            probe_ok = candidate_resp.status in (200, 206) and (
                                candidate_resp.status == 206
                                or candidate_len >= 65536
                                or "video/" in candidate_ctype
                                or candidate_is_hls
                            )
                            if probe_ok:
                                v.url = new_url
                                target_url = new_url
                                if info.get('height'):
                                    v.height = info['height']
                                db.commit()
                                current_headers = candidate_headers
                                upstream_response = candidate_resp
                                status_code = upstream_response.status
                                logging.info("[CW-L2][%s] v.url committed → %s", cw_corr, new_url[:120])
                                return True
                            candidate_resp.close()
                            logging.warning(
                                "[CW-L2][%s] candidate rejected: status=%s ctype=%s len=%s url=%s",
                                cw_corr,
                                getattr(candidate_resp, 'status', '?'),
                                candidate_ctype,
                                candidate_len,
                                new_url[:120],
                            )
                except Exception as e:
                    logging.error("[CW-L2][%s] refresh raised: %s", cw_corr, e, exc_info=True)
                return False

            refresh_success = await try_refresh()
            if not refresh_success and is_vk:
                upstream_response.close()
                raise HTTPException(500, detail="Failed to refresh VK stream. Check if cookies are needed.")
            if not refresh_success and v and v.source_url and "bunkr" in (v.source_url or "").lower():
                upstream_response.close()
                raise HTTPException(502, detail="Bunkr stream expired and re-resolve failed. Try Regenerate or check bunkr.cookies.txt.")
            if (
                not refresh_success
                and v
                and v.source_url
                and "camwhores.tv" in (v.source_url or "").lower()
                and "/videos/" in (v.source_url or "")
            ):
                upstream_response.close()
                raise HTTPException(
                    502,
                    detail="cw_refresh_failed: Camwhores stream unavailable. Open the watch page while logged in and ensure browser automation can load it, then Regenerate.",
                )
            if (
                not refresh_success
                and v
                and "camwhores.tv/get_file" in str(v.url or "").lower()
                and "camwhores.tv/videos/" not in str(v.source_url or "").lower()
            ):
                upstream_response.close()
                raise HTTPException(
                    502,
                    detail="cw_source_missing: Camwhores video has no watch-page source_url for re-resolve.",
                )

        if upstream_response.status >= 400:
            error_text = await upstream_response.text()
            logging.error(f"Upstream error ({upstream_response.status}) for video {v.id if v else video_id}: {error_text[:200]}")
            upstream_response.close()
            if "camwhores.tv/get_file" in (target_url or "").lower():
                raise HTTPException(status_code=502, detail=f"cw_upstream_5xx: Camwhores upstream returned {upstream_response.status}")
            raise HTTPException(status_code=upstream_response.status, detail="Upstream link unavailable")

        # --- STREAMING RESPONSE ---
        # 1. Clean up headers. Remove specific ones that can cause proxy loops or mismatch
        excluded_headers = {
            'content-encoding', 'content-length', 'transfer-encoding', 
            'connection', 'keep-alive', 'host', 'server', 'vary',
            'x-frame-options', 'content-security-policy', 'strict-transport-security',
            'x-content-type-options', 'access-control-allow-origin', 'access-control-allow-methods',
            'content-disposition'  # Exclude to prevent Unicode encoding errors (e.g., emojis in filenames)
        }
        response_headers = {k: v for k, v in upstream_response.headers.items() if k.lower() not in excluded_headers}
        
        # 2. Handle Status and Range Headers carefully
        status_code = upstream_response.status

        # Backfill height/duration via bg ffprobe for CW videos that streamed OK but lack metadata
        if (
            v is not None
            and status_code in (200, 206)
            and v.source_url and "camwhores.tv/videos/" in v.source_url
            and (not v.height or not v.duration)
            and "get_file" in (v.url or "")
        ):
            _bfp_vid_id = v.id
            _bfp_url = v.url
            _bfp_ref = v.source_url
            async def _cw_main_bg_ffprobe():
                try:
                    _proc = VIPVideoProcessor()
                    _ff = await asyncio.to_thread(_proc._ffprobe_fallback, _bfp_url, {}, _bfp_ref)
                    if _ff.get('height') or _ff.get('duration'):
                        _bdb = SessionLocal()
                        try:
                            _bv = _bdb.query(Video).get(_bfp_vid_id)
                            if _bv:
                                if _ff.get('height') and not _bv.height:
                                    _bv.height = int(_ff['height'])
                                if _ff.get('width') and not _bv.width:
                                    _bv.width = int(_ff['width'])
                                if _ff.get('duration') and not _bv.duration:
                                    _bv.duration = float(_ff['duration'])
                                _bdb.commit()
                                logging.info(
                                    "[CW-meta] bg-ffprobe filled vid=%s h=%s dur=%s",
                                    _bfp_vid_id, _ff.get('height'), _ff.get('duration')
                                )
                        finally:
                            _bdb.close()
                except Exception as _fe:
                    logging.warning("[CW-meta] bg-ffprobe error vid=%s: %s", _bfp_vid_id, _fe)
            asyncio.create_task(_cw_main_bg_ffprobe())

        # If browser sent a Range but we got 200, we must clear Content-Length or the browser
        # might try to match the range it asked for against the full file we are sending.
        # Actually, best is to pass Content-Length only if it matches exactly what we're sending.
        # For unreliable streams, skip Content-Length to avoid mismatch after refresh or upstream interruption
        if 'Content-Length' in upstream_response.headers and not is_unreliable:
            response_headers['Content-Length'] = upstream_response.headers['Content-Length']
        if 'Content-Range' in upstream_response.headers:
            response_headers['Content-Range'] = upstream_response.headers['Content-Range']

        # Force these for stability and CORS
        response_headers.update({
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
            "X-Video-ID": str(video_id),
            "Cache-Control": "no-cache, no-store, must-revalidate" # Don't cache proxy streams
        })

        async def content_streamer():
            try:
                # iter_chunked with a specific size (128KB) is often the most stable balanced choice
                async for chunk in upstream_response.content.iter_chunked(128 * 1024):
                    if chunk:
                        yield chunk
            except Exception as e:
                logging.debug(f"Stream finished or interrupted for {video_id}")
            finally:
                upstream_response.close()

        # media_type is important for the browser to know it's a video
        media_type = upstream_response.headers.get("Content-Type", "video/mp4")
        
        return StreamingResponse(
            content_streamer(), 
            status_code=status_code, 
            headers=response_headers,
            media_type=media_type
        )

    except HTTPException:
        raise
    except Exception as e:
        if 'upstream_response' in locals() and upstream_response:
            try: upstream_response.close()
            except: pass
        logging.error(f"Proxy error for video {video_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_v1_router.get("/proxy")
@api_legacy_router.get("/proxy")
async def universal_cors_proxy(url: str):
    """
    Universal CORS proxy to bypass external CDN restrictions.
    Usage: /api/proxy?url=https://example.com/image.jpg
    """
    if not url:
        raise HTTPException(status_code=400, detail="URL parameter required")
    
    # Clean up URL (sometimes passed with double protocol or spaces)
    url = url.strip()
    if url.startswith('https//'): url = url.replace('https//', 'https://', 1)
    if url.startswith('http//'): url = url.replace('http//', 'http://', 1)
    
    try:
        domain_parts = url.split('/')
        base_domain = domain_parts[0] + '//' + domain_parts[2] if len(domain_parts) > 2 else url
        
        # Pick correct Referer so CDNs don't 403 the thumbnail request
        if "camwhores" in url or "cwvids" in url or "cwstore" in url:
            _referer = "https://www.camwhores.tv/"
        elif "hqporner" in url or "mydaddy" in url:
            _referer = "https://hqporner.com/"
        elif "pixeldrain" in url:
            _referer = "https://pixeldrain.com/"
        elif "eporner" in url:
            _referer = "https://www.eporner.com/"
        elif "xvideos" in url:
            _referer = "https://www.xvideos.com/"
        elif "leakporner" in url or "58img" in url:
            _referer = "https://leakporner.com/"
        elif "rec-ur-bate" in url or "recurbate" in url:
            _referer = "https://rec-ur-bate.com/"
        else:
            _referer = base_domain
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": _referer,
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
        
        # Use the global http_session for better performance
        async with http_session.get(url, timeout=15, headers=headers, ssl=False) as resp:
            if resp.status != 200:
                logging.warning(f"Proxy upstream returned {resp.status} for {url}")
                raise HTTPException(status_code=resp.status, detail=f"Upstream returned {resp.status}")
            
            content = await resp.read()
            content_type = resp.headers.get('Content-Type', 'image/jpeg') # Fallback to jpeg
            
            return Response(
                content=content,
                media_type=content_type,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=86400", # Cache for 24h
                    "X-Proxy-Source": "Quantum-CORS"
                }
            )
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Detailed CORS proxy error for {url}: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail=f"Proxy error: {str(e)}")


@app.get("/hls_proxy")
async def hls_proxy(url: str, referer: str = ""):
    """
    HLS rewriting proxy — rewrites m3u8 playlists so .ts segments are fetched
    through this proxy with the correct Referer header (fixes Pornhub/WhoresHub 404s).
    Usage: /hls_proxy?url=https://cdn.../master.m3u8&referer=https://www.pornhub.com/
    """
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "Invalid URL")

    # Detect JW Player ping URLs with hidden manifest in 'mu' parameter
    if "ping.gif" in url.lower() and "mu=" in url.lower():
        try:
            parsed_query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            if 'mu' in parsed_query:
                real_url = parsed_query['mu'][0]
                logging.info(f"HLS Proxy: Extracted real manifest from ping URL mu param: {real_url[:120]}...")
                url = real_url
        except Exception as e:
            logging.warning(f"HLS Proxy: Failed to parse ping URL mu parameter: {e}")

    # Derive referer from URL origin if not supplied
    if not referer:
        parts = url.split("/")
        referer = parts[0] + "//" + parts[2] + "/" if len(parts) > 2 else url

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": referer,
        "Origin": referer.rstrip("/"),
    }

    is_m3u8 = ".m3u8" in url.lower()

    # Load cookies for VK/OK if available
    cookies = {}
    is_vk = any(d in url.lower() for d in ['vk.com', 'vk.video', 'vkvideo.ru', 'okcdn.ru', 'vkvideo.net', 'vk.ru'])
    if is_vk:
        for cf in ['vk.netscape.txt', 'cookies.netscape.txt']:
            if os.path.exists(cf):
                try:
                    with open(cf, 'r') as f:
                        for line in f:
                            if not line.startswith('#') and line.strip():
                                parts = line.strip().split('\t')
                                if len(parts) >= 7:
                                    cookies[parts[5]] = parts[6]
                    break
                except: pass

    try:
        timeout = aiohttp.ClientTimeout(total=30)
        async with http_session.get(url, headers=headers, cookies=cookies if cookies else None, timeout=timeout, ssl=False) as resp:
            if resp.status != 200:
                raise HTTPException(resp.status, f"Upstream returned {resp.status}")
            content_type = resp.headers.get("Content-Type", "")
            raw = await resp.read()

        # Decide: m3u8 playlist or raw segment
        if is_m3u8 or "mpegurl" in content_type.lower():
            body = raw.decode("utf-8", errors="replace")
            base_url = url.rsplit("/", 1)[0] + "/"
            encoded_referer = urllib.parse.quote(referer, safe="")
            lines = []
            for line in body.splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#"):
                    # Resolve segment/variant/key URIs robustly (absolute, root-relative,
                    # protocol-relative, ../ traversal, query-only, etc.).
                    seg_url = urllib.parse.urljoin(url, stripped)
                    encoded_seg = urllib.parse.quote(seg_url, safe="")
                    lines.append(f"/hls_proxy?url={encoded_seg}&referer={encoded_referer}")
                elif stripped.startswith("#EXT-X-KEY:") and 'URI="' in stripped:
                    # Rewrite encryption key URI so browser fetches it through our proxy
                    def rewrite_key_uri(m):
                        key_url = urllib.parse.urljoin(url, m.group(1))
                        encoded_key = urllib.parse.quote(key_url, safe="")
                        return f'URI="/hls_proxy?url={encoded_key}&referer={encoded_referer}"'
                    lines.append(re.sub(r'URI="([^"]+)"', rewrite_key_uri, stripped))
                else:
                    lines.append(line)
            return Response(
                content="\n".join(lines),
                media_type="application/vnd.apple.mpegurl",
                headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"},
            )

        # Raw segment (.ts / .aac / etc.)
        ct = content_type or "video/MP2T"
        return Response(
            content=raw,
            media_type=ct,
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"HLS proxy error for {url}: {e}")
        raise HTTPException(500, f"HLS proxy error: {e}")


@app.get("/download/{video_id}")
async def download_direct(video_id: int, db: Session = Depends(get_db)):
    v = db.query(Video).get(video_id)
    if not v: raise HTTPException(404)
    async def iter_file():
        async with aiohttp.ClientSession() as session:
            async with session.get(v.url) as resp:
                async for chunk in resp.content.iter_chunked(64*1024): yield chunk
    
    # Create ASCII-safe filename for compatibility
    safe = "".join([c for c in v.title if c.isalnum() or c in (' ','-','_')]).strip()
    if not safe:
        safe = f"video_{video_id}"
    
    # Use RFC 5987 encoding for Unicode support (filename* parameter)
    import urllib.parse
    encoded_title = urllib.parse.quote(v.title.encode('utf-8'))
    
    # Provide both ASCII fallback and UTF-8 encoded filename
    content_disposition = f'attachment; filename="{safe}.mp4"; filename*=UTF-8\'\'{encoded_title}.mp4'
    
    return StreamingResponse(iter_file(), headers={"Content-Disposition": content_disposition})

def get_stream_url(video_id: int):
    return f"/stream_proxy/{video_id}.mp4"

# --- UTILITY ENDPOINTS ---

@api_v1_router.get("/export-library")
@api_legacy_router.get("/export-library")
def export_library(db: Session = Depends(get_db)):
    """Export entire library as JSON"""
    videos = db.query(Video).all()
    results = []
    for v in videos:
        video_dict = v.__dict__
        video_dict.pop('_sa_instance_state', None)
        # Convert datetime to ISO format
        if video_dict.get('created_at'):
            video_dict['created_at'] = video_dict['created_at'].isoformat()
        if video_dict.get('last_checked'):
            video_dict['last_checked'] = video_dict['last_checked'].isoformat()
        results.append(video_dict)
    
    return JSONResponse(content={
        "export_date": datetime.datetime.utcnow().isoformat(),
        "total_videos": len(results),
        "videos": results
    })

@api_v1_router.post("/batch/tag")
@api_legacy_router.post("/batch/tag")
def batch_tag_videos(video_ids: List[int] = Body(...), tags: str = Body(...), db: Session = Depends(get_db)):
    """Add tags to multiple videos"""
    for vid_id in video_ids:
        video = db.query(Video).get(vid_id)
        if video:
            existing_tags = set(video.tags.split(',')) if video.tags else set()
            new_tags = set(tags.split(','))
            combined = existing_tags.union(new_tags)
            video.tags = ','.join(filter(None, combined))
    db.commit()
    return {"success": True, "updated": len(video_ids)}

@api_v1_router.post("/batch/delete")
@api_legacy_router.post("/batch/delete")
def batch_delete_videos(video_ids: List[int] = Body(...), db: Session = Depends(get_db)):
    """Delete multiple videos"""
    for vid_id in video_ids:
        video = db.query(Video).get(vid_id)
        if video:
            # Delete thumbnail files
            if video.thumbnail_path:
                thumb_path = f"app{video.thumbnail_path.split('?')[0]}"
                if os.path.exists(thumb_path):
                    os.remove(thumb_path)
            db.delete(video)
    db.commit()
    return {"success": True, "deleted": len(video_ids)}

# ...napr. v get_videos alebo export_videos môžete pridať do výsledku:
# video['stream_url'] = get_stream_url(video.id)


# ===== DISCOVERY PROFILES API =====

class DiscoveryProfileCreate(BaseModel):
    name: str
    enabled: bool = True
    schedule_type: str = "interval"  # "interval", "cron", "manual"
    schedule_value: str = "3600"  # seconds for interval, cron expression for cron
    keywords: str = ""
    exclude_keywords: str = ""
    sources: List[str] = []
    min_height: Optional[int] = None
    max_height: Optional[int] = None
    aspect_ratio: Optional[str] = None
    min_duration: Optional[int] = None
    max_duration: Optional[int] = None
    max_results: int = 20
    auto_import: bool = False
    batch_prefix: str = "Auto"

class DiscoveryProfileUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    schedule_type: Optional[str] = None
    schedule_value: Optional[str] = None
    keywords: Optional[str] = None
    exclude_keywords: Optional[str] = None
    sources: Optional[List[str]] = None
    min_height: Optional[int] = None
    max_height: Optional[int] = None
    aspect_ratio: Optional[str] = None
    min_duration: Optional[int] = None
    max_duration: Optional[int] = None
    max_results: Optional[int] = None
    auto_import: Optional[bool] = None
    batch_prefix: Optional[str] = None

class ProbeUrlBody(BaseModel):
    url: str

@api_v1_router.get("/discovery/search-sources")
@api_legacy_router.get("/discovery/search-sources")
async def discovery_search_sources_list():
    """Catalog of discovery search keys for dashboard UI."""
    from .source_catalog import DISCOVERY_SOURCE_OPTIONS, EXTRACT_ONLY_SOURCE_NOTES
    return {
        "discovery_sources": DISCOVERY_SOURCE_OPTIONS,
        "import_only_sources": EXTRACT_ONLY_SOURCE_NOTES,
    }

@api_v1_router.post("/tools/probe-url")
@api_legacy_router.post("/tools/probe-url")
async def tools_probe_url(body: ProbeUrlBody):
    """Try plugin extractors then yt-dlp to see if a URL is supported."""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")

    from .extractors import init_registry, register_extended_extractors
    from .extractors.registry import ExtractorRegistry

    init_registry()
    register_extended_extractors()

    plugin = ExtractorRegistry.find_extractor(url)
    if plugin:
        try:
            res = await plugin.extract(url)
            if res and res.get("stream_url"):
                return {
                    "supported": True,
                    "method": "extractor",
                    "extractor": plugin.name,
                    "title": res.get("title"),
                    "has_stream": True,
                    "is_hls": bool(res.get("is_hls")),
                }
            return {
                "supported": bool(res),
                "method": "extractor",
                "extractor": plugin.name,
                "title": (res or {}).get("title"),
                "has_stream": bool(res and res.get("stream_url")),
                "is_hls": bool((res or {}).get("is_hls")),
                "error": None if (res and res.get("stream_url")) else "Extractor returned no stream_url",
            }
        except Exception as e:
            return {
                "supported": False,
                "method": "extractor",
                "extractor": plugin.name,
                "error": str(e),
            }

    def _ytdlp_probe():
        ydl_opts = {"quiet": True, "no_warnings": True, "skip_download": True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        info = await asyncio.to_thread(_ytdlp_probe)
        if info:
            ie = info.get("extractor") or info.get("ie_key") or "yt-dlp"
            has_stream = bool(info.get("url") or info.get("formats"))
            return {
                "supported": True,
                "method": "yt-dlp",
                "extractor": ie,
                "title": info.get("title"),
                "has_stream": has_stream,
            }
    except Exception as e:
        return {
            "supported": False,
            "method": "none",
            "extractor": None,
            "error": str(e),
        }

    return {"supported": False, "method": "none", "extractor": None}

@api_v1_router.get("/discovery/profiles")
async def get_discovery_profiles(db: Session = Depends(get_db)):
    """Get all discovery profiles."""
    profiles = db.query(DiscoveryProfile).order_by(desc(DiscoveryProfile.created_at)).all()

    result = []
    for profile in profiles:
        profile_dict = {
            "id": profile.id,
            "name": profile.name,
            "enabled": profile.enabled,
            "schedule_type": profile.schedule_type,
            "schedule_value": profile.schedule_value,
            "keywords": profile.keywords,
            "exclude_keywords": profile.exclude_keywords,
            "sources": profile.sources or [],
            "min_height": profile.min_height,
            "max_height": profile.max_height,
            "aspect_ratio": profile.aspect_ratio,
            "min_duration": profile.min_duration,
            "max_duration": profile.max_duration,
            "max_results": profile.max_results,
            "auto_import": profile.auto_import,
            "batch_prefix": profile.batch_prefix,
            "last_run": profile.last_run.isoformat() if profile.last_run else None,
            "total_runs": profile.total_runs,
            "total_found": profile.total_found,
            "total_imported": profile.total_imported,
            "created_at": profile.created_at.isoformat(),
            "updated_at": profile.updated_at.isoformat()
        }
        result.append(profile_dict)

    return {"profiles": result}

@api_v1_router.get("/discovery/profiles/{profile_id}")
async def get_discovery_profile(profile_id: int, db: Session = Depends(get_db)):
    """Get a specific discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    return {
        "id": profile.id,
        "name": profile.name,
        "enabled": profile.enabled,
        "schedule_type": profile.schedule_type,
        "schedule_value": profile.schedule_value,
        "keywords": profile.keywords,
        "exclude_keywords": profile.exclude_keywords,
        "sources": profile.sources or [],
        "min_height": profile.min_height,
        "max_height": profile.max_height,
        "aspect_ratio": profile.aspect_ratio,
        "min_duration": profile.min_duration,
        "max_duration": profile.max_duration,
        "max_results": profile.max_results,
        "auto_import": profile.auto_import,
        "batch_prefix": profile.batch_prefix,
        "last_run": profile.last_run.isoformat() if profile.last_run else None,
        "total_runs": profile.total_runs,
        "total_found": profile.total_found,
        "total_imported": profile.total_imported,
        "created_at": profile.created_at.isoformat(),
        "updated_at": profile.updated_at.isoformat()
    }

@api_v1_router.post("/discovery/profiles")
async def create_discovery_profile(profile_data: DiscoveryProfileCreate, db: Session = Depends(get_db)):
    """Create a new discovery profile."""
    # Check if name already exists
    existing = db.query(DiscoveryProfile).filter(DiscoveryProfile.name == profile_data.name).first()
    if existing:
        raise HTTPException(status_code=400, detail="Profile name already exists")

    from .source_catalog import filter_valid_discovery_sources

    # Create profile
    profile = DiscoveryProfile(
        name=profile_data.name,
        enabled=profile_data.enabled,
        schedule_type=profile_data.schedule_type,
        schedule_value=profile_data.schedule_value,
        keywords=profile_data.keywords,
        exclude_keywords=profile_data.exclude_keywords,
        sources=filter_valid_discovery_sources(profile_data.sources),
        min_height=profile_data.min_height,
        max_height=profile_data.max_height,
        aspect_ratio=profile_data.aspect_ratio,
        min_duration=profile_data.min_duration,
        max_duration=profile_data.max_duration,
        max_results=profile_data.max_results,
        auto_import=profile_data.auto_import,
        batch_prefix=profile_data.batch_prefix
    )

    db.add(profile)
    db.commit()
    db.refresh(profile)

    # Schedule the profile if enabled
    if profile.enabled:
        try:
            scheduler = get_scheduler()
            if profile.schedule_type == "interval":
                interval_seconds = int(profile.schedule_value)
                scheduler.add_interval_job(
                    run_discovery_profile,
                    job_id=f"profile_{profile.id}",
                    seconds=interval_seconds,
                    description=f"Discovery: {profile.name}",
                    args=(profile.id,)
                )
            elif profile.schedule_type == "cron":
                scheduler.add_cron_job(
                    run_discovery_profile,
                    job_id=f"profile_{profile.id}",
                    cron_expression=profile.schedule_value,
                    description=f"Discovery: {profile.name}",
                    args=(profile.id,)
                )
        except Exception as e:
            print(f"Failed to schedule new profile: {e}")

    return {"success": True, "profile_id": profile.id}

@api_v1_router.put("/discovery/profiles/{profile_id}")
async def update_discovery_profile(profile_id: int, profile_data: DiscoveryProfileUpdate, db: Session = Depends(get_db)):
    """Update a discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Update fields
    update_data = profile_data.dict(exclude_unset=True)
    if "sources" in update_data and update_data["sources"] is not None:
        from .source_catalog import filter_valid_discovery_sources
        update_data["sources"] = filter_valid_discovery_sources(update_data["sources"])
    for field, value in update_data.items():
        setattr(profile, field, value)

    profile.updated_at = datetime.datetime.utcnow()
    db.commit()

    # Re-schedule the profile
    try:
        scheduler = get_scheduler()
        scheduler.remove_job(f"profile_{profile.id}")

        if profile.enabled:
            if profile.schedule_type == "interval":
                interval_seconds = int(profile.schedule_value)
                scheduler.add_interval_job(
                    run_discovery_profile,
                    job_id=f"profile_{profile.id}",
                    seconds=interval_seconds,
                    description=f"Discovery: {profile.name}",
                    args=(profile.id,)
                )
            elif profile.schedule_type == "cron":
                scheduler.add_cron_job(
                    run_discovery_profile,
                    job_id=f"profile_{profile.id}",
                    cron_expression=profile.schedule_value,
                    description=f"Discovery: {profile.name}",
                    args=(profile.id,)
                )
    except Exception as e:
        print(f"Failed to re-schedule profile: {e}")

    return {"success": True}

@api_v1_router.delete("/discovery/profiles/{profile_id}")
async def delete_discovery_profile(profile_id: int, db: Session = Depends(get_db)):
    """Delete a discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Remove from scheduler
    try:
        scheduler = get_scheduler()
        scheduler.remove_job(f"profile_{profile.id}")
    except Exception as e:
        print(f"Failed to remove job from scheduler: {e}")

    # Delete notifications
    db.query(DiscoveryNotification).filter(DiscoveryNotification.profile_id == profile_id).delete()

    # Delete profile
    db.delete(profile)
    db.commit()

    return {"success": True}

@api_v1_router.post("/discovery/profiles/{profile_id}/run")
async def run_profile_now(profile_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Manually trigger a discovery profile to run now."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Run in background
    background_tasks.add_task(run_discovery_profile, profile_id)

    return {"success": True, "message": f"Profile '{profile.name}' queued to run"}

@api_v1_router.post("/discovery/profiles/{profile_id}/toggle")
async def toggle_profile(profile_id: int, db: Session = Depends(get_db)):
    """Enable or disable a discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    profile.enabled = not profile.enabled
    profile.updated_at = datetime.datetime.utcnow()
    db.commit()

    # Update scheduler
    try:
        scheduler = get_scheduler()
        if profile.enabled:
            if profile.schedule_type == "interval":
                interval_seconds = int(profile.schedule_value)
                scheduler.add_interval_job(
                    run_discovery_profile,
                    job_id=f"profile_{profile.id}",
                    seconds=interval_seconds,
                    description=f"Discovery: {profile.name}",
                    args=(profile.id,)
                )
            elif profile.schedule_type == "cron":
                scheduler.add_cron_job(
                    run_discovery_profile,
                    job_id=f"profile_{profile.id}",
                    cron_expression=profile.schedule_value,
                    description=f"Discovery: {profile.name}",
                    args=(profile.id,)
                )
        else:
            scheduler.remove_job(f"profile_{profile.id}")
    except Exception as e:
        print(f"Failed to update scheduler: {e}")

    return {"success": True, "enabled": profile.enabled}

@api_v1_router.get("/discovery/notifications")
async def get_notifications(unread_only: bool = False, limit: int = 50, db: Session = Depends(get_db)):
    """Get discovery notifications."""
    query = db.query(DiscoveryNotification)

    if unread_only:
        query = query.filter(DiscoveryNotification.read == False)

    notifications = query.order_by(desc(DiscoveryNotification.created_at)).limit(limit).all()

    result = []
    for notif in notifications:
        result.append({
            "id": notif.id,
            "profile_id": notif.profile_id,
            "profile_name": notif.profile_name,
            "type": notif.notification_type,
            "message": notif.message,
            "video_count": notif.video_count,
            "read": notif.read,
            "created_at": notif.created_at.isoformat()
        })

    return {"notifications": result}

@api_v1_router.post("/discovery/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: int, db: Session = Depends(get_db)):
    """Mark a notification as read."""
    notif = db.query(DiscoveryNotification).filter(DiscoveryNotification.id == notification_id).first()

    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")

    notif.read = True
    db.commit()

    return {"success": True}

@api_v1_router.post("/discovery/notifications/mark-all-read")
async def mark_all_notifications_read(db: Session = Depends(get_db)):
    """Mark all notifications as read."""
    db.query(DiscoveryNotification).update({"read": True})
    db.commit()

    return {"success": True}

@api_v1_router.get("/scheduler/jobs")
async def get_scheduler_jobs():
    """Get all scheduled jobs."""
    try:
        scheduler = get_scheduler()
        jobs = scheduler.get_jobs()

        result = []
        for job_id, metadata in jobs.items():
            result.append({
                "job_id": job_id,
                **metadata,
                "next_run": metadata.get('next_run').isoformat() if metadata.get('next_run') else None,
                "last_run": metadata.get('last_run').isoformat() if metadata.get('last_run') else None,
                "added_at": metadata.get('added_at').isoformat() if metadata.get('added_at') else None
            })

        return {"jobs": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===== DISCOVERED VIDEOS (REVIEW) API =====

@api_v1_router.get("/discovery/review/{profile_id}")
async def get_discovered_videos(profile_id: int, imported: bool = False, db: Session = Depends(get_db)):
    """Get discovered videos for a profile for review."""
    query = db.query(DiscoveredVideo).filter(DiscoveredVideo.profile_id == profile_id)

    if not imported:
        query = query.filter(DiscoveredVideo.imported == False)

    discovered = query.order_by(desc(DiscoveredVideo.discovered_at)).all()

    result = []
    for vid in discovered:
        result.append({
            "id": vid.id,
            "profile_id": vid.profile_id,
            "profile_name": vid.profile_name,
            "title": vid.title,
            "url": vid.url,
            "source_url": vid.source_url,
            "thumbnail": vid.thumbnail,
            "duration": vid.duration,
            "width": vid.width,
            "height": vid.height,
            "source": vid.source,
            "imported": vid.imported,
            "video_id": vid.video_id,
            "discovered_at": vid.discovered_at.isoformat(),
            "imported_at": vid.imported_at.isoformat() if vid.imported_at else None
        })

    return {"discovered_videos": result}

@api_v1_router.post("/discovery/import-selected")
async def import_selected_videos(
    video_ids: List[int] = Body(...),
    background_tasks: BackgroundTasks = None,
    db: Session = Depends(get_db)
):
    """Import selected discovered videos to main library."""
    imported_count = 0

    for vid_id in video_ids:
        discovered = db.query(DiscoveredVideo).filter(DiscoveredVideo.id == vid_id).first()

        if not discovered or discovered.imported:
            continue

        # Check if URL already exists in main videos
        existing = db.query(Video).filter(Video.url == discovered.url).first()
        if existing:
            # Mark as imported with existing video_id
            discovered.imported = True
            discovered.video_id = existing.id
            discovered.imported_at = datetime.datetime.utcnow()
            continue

        # Create new video entry
        video = Video(
            title=discovered.title,
            url=discovered.url,
            source_url=discovered.source_url,
            thumbnail_path=discovered.thumbnail,
            duration=discovered.duration,
            width=discovered.width,
            height=discovered.height,
            batch_name=f"{discovered.profile_name}-{datetime.datetime.utcnow().strftime('%Y%m%d')}",
            storage_type='remote',
            status='pending'
        )

        db.add(video)
        db.flush()

        # Mark discovered video as imported
        discovered.imported = True
        discovered.video_id = video.id
        discovered.imported_at = datetime.datetime.utcnow()

        # Queue for processing in background
        if background_tasks:
            background_tasks.add_task(VIPVideoProcessor().process_single_video, video.id)

        imported_count += 1

    db.commit()

    return {"success": True, "imported_count": imported_count}

@api_v1_router.delete("/discovery/review/{discovered_id}")
async def delete_discovered_video(discovered_id: int, db: Session = Depends(get_db)):
    """Delete a discovered video from review list."""
    discovered = db.query(DiscoveredVideo).filter(DiscoveredVideo.id == discovered_id).first()

    if not discovered:
        raise HTTPException(status_code=404, detail="Discovered video not found")

    db.delete(discovered)
    db.commit()

    return {"success": True}

@api_v1_router.post("/discovery/clear-imported/{profile_id}")
async def clear_imported_discoveries(profile_id: int, db: Session = Depends(get_db)):
    """Clear all imported discovered videos for a profile."""
    deleted_count = db.query(DiscoveredVideo).filter(
        DiscoveredVideo.profile_id == profile_id,
        DiscoveredVideo.imported == True
    ).delete()

    db.commit()

    return {"success": True, "deleted_count": deleted_count}


# ============================================
# QUANTUM UX BACKEND API ENDPOINTS
# Supporting 10 powerful UX features
# ============================================

# ========== TAG CLOUD & AUTOCOMPLETE ==========
@api_v1_router.get("/tags/cloud")
@api_legacy_router.get("/tags/cloud")
async def get_tag_cloud(db: Session = Depends(get_db)):
    """Get tag cloud with frequency counts."""
    from sqlalchemy import func

    # Get all tags and count their frequency
    all_tags = db.query(Video.tags, Video.ai_tags).filter(
        or_(Video.tags != "", Video.ai_tags != "")
    ).all()

    tag_counts = {}
    for tags, ai_tags in all_tags:
        for tag_str in [tags, ai_tags]:
            if tag_str:
                for tag in tag_str.split(','):
                    tag = tag.strip()
                    if tag:
                        tag_counts[tag] = tag_counts.get(tag, 0) + 1

    # Convert to sorted list
    tag_list = [{"tag": tag, "count": count} for tag, count in tag_counts.items()]
    tag_list.sort(key=lambda x: x['count'], reverse=True)

    return {"tags": tag_list[:50]}  # Top 50 tags

@api_v1_router.get("/tags/search")
@api_legacy_router.get("/tags/search")
async def search_tags(q: str, db: Session = Depends(get_db)):
    """Search for tags matching query."""
    all_tags = db.query(Video.tags, Video.ai_tags).filter(
        or_(Video.tags.contains(q), Video.ai_tags.contains(q))
    ).limit(100).all()

    matching_tags = set()
    for tags, ai_tags in all_tags:
        for tag_str in [tags, ai_tags]:
            if tag_str:
                for tag in tag_str.split(','):
                    tag = tag.strip()
                    if tag and q.lower() in tag.lower():
                        matching_tags.add(tag)

    tag_list = [{"tag": tag} for tag in sorted(matching_tags)]
    return {"tags": tag_list[:20]}


# ========== LINK HEALTH DASHBOARD ==========
@api_v1_router.get("/health/stats")
@api_legacy_router.get("/health/stats")
async def get_health_stats(db: Session = Depends(get_db)):
    """Get overall library health statistics."""
    total = db.query(Video).count()
    working = db.query(Video).filter(Video.link_status == 'working').count()
    broken = db.query(Video).filter(Video.link_status == 'broken').count()
    unknown = db.query(Video).filter(Video.link_status == 'unknown').count()
    never_checked = db.query(Video).filter(Video.last_checked == None).count()

    health_percentage = (working / total * 100) if total > 0 else 0

    return {
        "total": total,
        "working": working,
        "broken": broken,
        "unknown": unknown,
        "never_checked": never_checked,
        "health_percentage": round(health_percentage, 1)
    }

@api_v1_router.get("/health/sources")
@api_legacy_router.get("/health/sources")
async def get_health_by_source(db: Session = Depends(get_db)):
    """Get health statistics grouped by source plus Unknown domain backlog."""
    from collections import Counter

    from .source_catalog import classify_library_source_name, unknown_domain_from_urls

    videos = db.query(Video).all()

    sources = {}
    domain_counts: Counter = Counter()

    for video in videos:
        label = classify_library_source_name(video.url, video.source_url)
        if label == "Unknown":
            host = unknown_domain_from_urls(video.url, video.source_url)
            if host:
                domain_counts[host] += 1

        if label not in sources:
            sources[label] = {"total": 0, "working": 0, "broken": 0, "unknown": 0}

        sources[label]["total"] += 1
        status = video.link_status or 'unknown'
        sources[label][status] = sources[label].get(status, 0) + 1

    source_list = []
    for name, stats in sources.items():
        score = (stats['working'] / stats['total'] * 100) if stats['total'] > 0 else 0
        source_list.append({
            "name": name,
            "score": round(score, 1),
            "stats": stats
        })

    source_list.sort(key=lambda x: x['score'], reverse=True)

    unknown_domains = [
        {"host": host, "count": count}
        for host, count in domain_counts.most_common(50)
    ]

    return {"sources": source_list, "unknown_domains": unknown_domains}

@api_v1_router.post("/health/refresh-broken")
@api_legacy_router.post("/health/refresh-broken")
async def refresh_broken_links(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Refresh all broken links in the background."""
    broken_videos = db.query(Video).filter(Video.link_status == 'broken').all()

    async def refresh_all():
        for video in broken_videos:
            try:
                # Use existing refresh logic from services
                pass  # TODO: Call refresh_video_link
            except Exception as e:
                print(f"Failed to refresh {video.id}: {e}")

    background_tasks.add_task(refresh_all)

    return {"status": "started", "count": len(broken_videos)}


# ========== DISCOVERY DASHBOARD ENHANCEMENTS ==========
@api_v1_router.get("/discovery/profiles/{profile_id}/stats")
async def get_discovery_profile_stats(profile_id: int, db: Session = Depends(get_db)):
    """Get statistics for a specific discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Get match counts
    total_found = db.query(DiscoveredVideo).filter(DiscoveredVideo.profile_id == profile_id).count()
    imported = db.query(DiscoveredVideo).filter(
        DiscoveredVideo.profile_id == profile_id,
        DiscoveredVideo.imported == True
    ).count()
    pending = total_found - imported

    # Calculate progress
    progress = (imported / total_found * 100) if total_found > 0 else 0

    return {
        "profile_id": profile_id,
        "total_found": total_found,
        "imported": imported,
        "pending": pending,
        "progress": round(progress, 1),
        "last_run": profile.last_run.isoformat() if profile.last_run else None,
        "status": "running" if False else "idle"  # TODO: Check actual running status
    }

@api_v1_router.post("/discovery/profiles/{profile_id}/run")
async def run_discovery_profile_endpoint(profile_id: int, background_tasks: BackgroundTasks):
    """Manually trigger a discovery profile run."""
    background_tasks.add_task(run_discovery_profile, profile_id)
    return {"status": "started"}

@api_v1_router.get("/discovery/profiles/{profile_id}/matches")
async def get_discovery_matches(profile_id: int, db: Session = Depends(get_db)):
    """Get pending matches for a discovery profile."""
    matches = db.query(DiscoveredVideo).filter(
        DiscoveredVideo.profile_id == profile_id,
        DiscoveredVideo.imported == False
    ).order_by(DiscoveredVideo.discovered_at.desc()).limit(50).all()

    return {"matches": [
        {
            "id": m.id,
            "title": m.title,
            "url": m.url,
            "thumbnail": m.thumbnail,
            "duration": m.duration,
            "width": m.width,
            "height": m.height,
            "source": m.source,
            "discovered_at": m.discovered_at.isoformat()
        }
        for m in matches
    ]}


# ========== SESSION & PROGRESS TRACKING ==========
class VideoProgressUpdate(BaseModel):
    video_id: int
    current_time: float
    duration: float

@api_v1_router.post("/session/progress")
@api_legacy_router.post("/session/progress")
async def update_video_progress(progress: VideoProgressUpdate, db: Session = Depends(get_db)):
    """Update video playback progress."""
    video = db.query(Video).filter(Video.id == progress.video_id).first()

    if video:
        video.resume_time = progress.current_time
        db.commit()

    return {"success": True}

@api_v1_router.get("/session/state")
@api_legacy_router.get("/session/state")
async def get_session_state(db: Session = Depends(get_db)):
    """Get current session state for restoration."""
    # Get recent videos
    recent = db.query(Video).order_by(Video.created_at.desc()).limit(10).all()

    return {
        "recent_videos": [v.id for v in recent],
        "timestamp": datetime.datetime.now().isoformat()
    }


# ========== BATCH OPERATIONS ==========
class BatchActionRequest(BaseModel):
    video_ids: List[int]
    action: str  # 'favorite', 'delete', 'download', 'refresh'

@api_v1_router.post("/batch/execute")
@api_legacy_router.post("/batch/execute")
async def execute_batch_action(request: BatchActionRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Execute batch actions on multiple videos."""
    results = {"success": 0, "failed": 0, "errors": []}

    for video_id in request.video_ids:
        try:
            video = db.query(Video).filter(Video.id == video_id).first()
            if not video:
                results["failed"] += 1
                results["errors"].append(f"Video {video_id} not found")
                continue

            if request.action == 'favorite':
                video.is_favorite = not video.is_favorite
            elif request.action == 'delete':
                db.delete(video)
            elif request.action == 'download':
                # TODO: Trigger download
                pass
            elif request.action == 'refresh':
                # TODO: Refresh link
                pass

            results["success"] += 1
        except Exception as e:
            results["failed"] += 1
            results["errors"].append(str(e))

    db.commit()

    return results


app.include_router(api_v1_router)
app.include_router(api_legacy_router)


@app.websocket("/ws/status")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep the connection open
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

if __name__ == "__main__":
    import uvicorn
    # Use 8001 as primary port to avoid conflicts
    uvicorn.run(app, host="0.0.0.0", port=8001)
