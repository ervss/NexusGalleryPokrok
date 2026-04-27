"""Duplicate detection API."""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.database import Video
from app.duplicate_detector import compute_all_phashes, find_duplicates, mark_as_duplicate

router = APIRouter(tags=["duplicates"])


class MarkDuplicateBody(BaseModel):
    duplicate_id: int
    original_id: int


class UrlExistsBody(BaseModel):
    urls: list[str]


@router.post("/duplicates/scan")
async def scan_duplicates(background_tasks: BackgroundTasks):
    def scan_task():
        db_local = SessionLocal()
        try:
            compute_all_phashes(db_local)
            duplicates = find_duplicates(db_local, threshold=5)
            logging.info(f"Found {len(duplicates)} potential duplicates")
        finally:
            db_local.close()

    background_tasks.add_task(scan_task)
    return {"status": "scanning", "message": "Duplicate scan started in background"}


@router.get("/duplicates")
def get_duplicates(db: Session = Depends(get_db)):
    duplicates = find_duplicates(db, threshold=5)
    return {"duplicates": duplicates, "count": len(duplicates)}


@router.post("/duplicates/mark")
def mark_duplicate(body: MarkDuplicateBody, db: Session = Depends(get_db)):
    success = mark_as_duplicate(db, body.duplicate_id, body.original_id)
    return {"success": success}


@router.post("/videos/exists")
def videos_exist(body: UrlExistsBody, db: Session = Depends(get_db)):
    urls = [str(url).strip() for url in (body.urls or []) if str(url).strip()]
    if not urls:
        return {"existing": [], "count": 0}

    rows = db.query(Video.url, Video.source_url).filter(
        or_(Video.url.in_(urls), Video.source_url.in_(urls))
    ).all()

    existing = set()
    requested = set(urls)
    for row in rows:
        if row.url in requested:
            existing.add(row.url)
        if row.source_url in requested:
            existing.add(row.source_url)

    return {"existing": sorted(existing), "count": len(existing)}
