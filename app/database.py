from sqlalchemy import create_engine, Column, Integer, String, Boolean, Float, DateTime, Text, JSON, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
from sqlalchemy import event

from .config import config

SQLALCHEMY_DATABASE_URL = config.DATABASE_URL

_is_sqlite = (SQLALCHEMY_DATABASE_URL or "").strip().lower().startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args=_connect_args,
    pool_size=config.DB_POOL_SIZE,
    max_overflow=config.DB_MAX_OVERFLOW,
    pool_timeout=config.DB_POOL_TIMEOUT,
)

@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Video(Base):
    __tablename__ = "videos"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    url = Column(String)
    source_url = Column(String) # For JIT link refreshing
    thumbnail_path = Column(String)
    gif_preview_path = Column(String)
    preview_path = Column(String)
    duration = Column(Float, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    aspect_ratio = Column(String, nullable=True)  # "16:9", "9:16", "4:3", "1:1", etc.
    batch_name = Column(String, index=True)
    tags = Column(String, default="") 
    ai_tags = Column(String, default="")
    subtitle = Column(Text, default="")
    sprite_path = Column(String, nullable=True)
    storage_type = Column(String, default="remote") # "remote" or "local"
    is_favorite = Column(Boolean, default=False)
    is_watched = Column(Boolean, default=False)
    resume_time = Column(Float, default=0)
    status = Column(String, default="pending")
    error_msg = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    views = Column(Integer, default=0)
    upload_date = Column(String, nullable=True) # "May 2, 2025" or ISO format
    quality = Column(String, default="SD")
    file_size_mb = Column(Float, default=0)
    
    # Duplicate Detection
    phash = Column(String, index=True, nullable=True)  # Perceptual hash of thumbnail
    duplicate_of = Column(Integer, nullable=True)  # ID of original if this is a duplicate
    
    # Health Monitoring
    last_checked = Column(DateTime, nullable=True)  # Last time link was validated
    link_status = Column(String, default="unknown")  # "working", "broken", "unknown"
    check_count = Column(Integer, default=0)  # Number of times checked
    
    # Statistics
    download_stats = Column(JSON, nullable=True) # {"avg_speed_mb": 12.5, "time_sec": 45, "size_mb": 200, "max_speed_mb": 15.0}

class SmartPlaylist(Base):
    __tablename__ = "smart_playlists"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, unique=True)
    rules = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)

class SearchHistory(Base):
    __tablename__ = "search_history"
    id = Column(Integer, primary_key=True, index=True)
    query = Column(String, index=True)
    source = Column(String, nullable=True) # e.g. "Quantum" or "Subtitles"
    results_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

class DiscoveryProfile(Base):
    __tablename__ = "discovery_profiles"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, unique=True)
    enabled = Column(Boolean, default=True)

    # Schedule settings (cron format)
    schedule_type = Column(String, default="interval")  # "interval", "cron", "manual"
    schedule_value = Column(String, default="3600")  # For interval: seconds; For cron: cron expression

    # Search settings
    keywords = Column(String, default="")  # Comma-separated keywords
    exclude_keywords = Column(String, default="")  # Comma-separated exclude keywords
    sources = Column(JSON, default=list)  # List of source names to search

    # Quality filters
    min_height = Column(Integer, nullable=True)  # e.g., 720, 1080, 2160
    max_height = Column(Integer, nullable=True)
    aspect_ratio = Column(String, nullable=True)  # "16:9", "9:16", "4:3", "any"

    # Duration filters (in seconds)
    min_duration = Column(Integer, nullable=True)
    max_duration = Column(Integer, nullable=True)

    # Import settings
    max_results = Column(Integer, default=20)  # Max videos to import per run
    auto_import = Column(Boolean, default=False)  # Auto-import or notify only

    # Batch settings
    batch_prefix = Column(String, default="Auto")  # Batch name prefix for imported videos

    # Statistics
    last_run = Column(DateTime, nullable=True)
    total_runs = Column(Integer, default=0)
    total_found = Column(Integer, default=0)
    total_imported = Column(Integer, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class DiscoveryNotification(Base):
    __tablename__ = "discovery_notifications"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, index=True)
    profile_name = Column(String)

    # Notification details
    notification_type = Column(String)  # "new_matches", "import_complete", "error"
    message = Column(Text)
    video_count = Column(Integer, default=0)

    # Status
    read = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)

class DiscoveredVideo(Base):
    __tablename__ = "discovered_videos"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, index=True)
    profile_name = Column(String)

    # Video details from search results
    title = Column(String)
    url = Column(String, index=True)
    source_url = Column(String)
    thumbnail = Column(String)
    duration = Column(Float, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    source = Column(String)  # Which site it's from

    # Status
    imported = Column(Boolean, default=False)  # Has it been imported to main videos table
    video_id = Column(Integer, nullable=True)  # Reference to imported video if imported

    discovered_at = Column(DateTime, default=datetime.utcnow)
    imported_at = Column(DateTime, nullable=True)

def init_db():
    from sqlalchemy import inspect
    inspector = inspect(engine)
    if not inspector.has_table("videos"):
        Base.metadata.create_all(bind=engine)
    else:
        columns = [c['name'] for c in inspector.get_columns('videos')]
        if 'sprite_path' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN sprite_path VARCHAR'))
        if 'source_url' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN source_url VARCHAR'))
        if 'storage_type' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN storage_type VARCHAR DEFAULT "remote"'))
        if 'phash' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN phash VARCHAR'))
                connection.execute(text('CREATE INDEX IF NOT EXISTS idx_phash ON videos(phash)'))
        if 'duplicate_of' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN duplicate_of INTEGER'))
        if 'last_checked' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN last_checked DATETIME'))
        if 'link_status' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN link_status VARCHAR DEFAULT "unknown"'))
        if 'check_count' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN check_count INTEGER DEFAULT 0'))
        if 'download_stats' not in columns:
            with engine.connect() as connection:
                # Add JSON column for download statistics (speed, time, size)
                # SQLite supports JSON just as TEXT, SQLAlchemy handles the serialization
                connection.execute(text('ALTER TABLE videos ADD COLUMN download_stats JSON'))
        if 'aspect_ratio' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN aspect_ratio VARCHAR'))
        if 'views' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN views INTEGER DEFAULT 0'))
        if 'upload_date' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN upload_date VARCHAR'))
        if 'quality' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN quality VARCHAR DEFAULT "SD"'))
        if 'file_size_mb' not in columns:
            with engine.connect() as connection:
                connection.execute(text('ALTER TABLE videos ADD COLUMN file_size_mb FLOAT DEFAULT 0'))

    if not inspector.has_table("smart_playlists"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("search_history"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("discovery_profiles"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("discovery_notifications"):
         Base.metadata.create_all(bind=engine)

    if not inspector.has_table("discovered_videos"):
         Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()


def get_db_health() -> dict:
    """
    Check database health and return status information.
    
    Returns:
        Dictionary with health check results
    """
    health = {
        "status": "unknown",
        "database_exists": False,
        "database_size_mb": 0,
        "tables": [],
        "total_videos": 0,
        "connection_pool": {},
        "errors": []
    }
    
    try:
        from sqlalchemy import inspect
        import os
        
        # Check if database file exists
        db_path = SQLALCHEMY_DATABASE_URL.replace('sqlite:///', '')
        if os.path.exists(db_path):
            health["database_exists"] = True
            health["database_size_mb"] = round(os.path.getsize(db_path) / (1024 * 1024), 2)
        
        # Check connection and schema
        inspector = inspect(engine)
        health["tables"] = inspector.get_table_names()
        
        # Get pool statistics
        pool = engine.pool
        health["connection_pool"] = {
            "size": pool.size(),
            "checked_in": pool.checkedin(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
            "max_overflow": pool._max_overflow if hasattr(pool, '_max_overflow') else 0
        }
        
        # Count videos
        db = SessionLocal()
        try:
            health["total_videos"] = db.query(Video).count()
        finally:
            db.close()
        
        health["status"] = "healthy"
        
    except Exception as e:
        health["status"] = "unhealthy"
        health["errors"].append(str(e))
    
    return health


def get_migration_version() -> dict:
    """
    Get current Alembic migration version.
    
    Returns:
        Dictionary with version information
    """
    version_info = {
        "current_revision": None,
        "is_up_to_date": False,
        "error": None
    }
    
    try:
        from alembic import command
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        from alembic.migration import MigrationContext
        
        # Get current revision from database
        with engine.connect() as conn:
            context = MigrationContext.configure(conn)
            current_rev = context.get_current_revision()
            version_info["current_revision"] = current_rev
        
        # Check if up to date
        alembic_cfg = Config("alembic.ini")
        script = ScriptDirectory.from_config(alembic_cfg)
        head_rev = script.get_current_head()
        
        version_info["head_revision"] = head_rev
        version_info["is_up_to_date"] = (current_rev == head_rev)
        
    except Exception as e:
        version_info["error"] = str(e)
    
    return version_info
