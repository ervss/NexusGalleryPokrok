"""
Centralized configuration management with validation and secure defaults.
"""
import os
import re
import secrets
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
import logging

# Load environment variables from project-root .env and prefer these values.
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH, override=True)

logger = logging.getLogger(__name__)


class ConfigurationError(Exception):
    """Raised when configuration is invalid or missing required values."""
    pass


class Config:
    """
    Application configuration with validation and secure defaults.
    """
    
    def __init__(self):
        """Initialize configuration and validate required settings."""
        self._validate_required_vars()
        self._load_settings()
    
    def _validate_required_vars(self):
        """Ensure critical environment variables are set."""
        required = ['DASHBOARD_PASSWORD', 'SECRET_KEY']
        missing = [var for var in required if not os.getenv(var)]
        
        if missing:
            raise ConfigurationError(
                f"Missing required environment variables: {', '.join(missing)}. "
                f"Please copy .env.example to .env and configure your credentials."
            )
    
    def _load_settings(self):
        """Load all configuration settings."""
        # === SECURITY ===
        self.DASHBOARD_PASSWORD = os.getenv('DASHBOARD_PASSWORD')
        self.SECRET_KEY = os.getenv('SECRET_KEY')
        
        # Validate password strength
        if not self._is_strong_password(self.DASHBOARD_PASSWORD):
            logger.warning(
                "SECURITY WARNING: Dashboard password is weak! "
                "Use at least 12 characters with mixed case, numbers, and symbols."
            )
        
        # Validate secret key entropy
        if len(self.SECRET_KEY) < 32:
            logger.warning(
                "SECURITY WARNING: SECRET_KEY should be at least 32 characters. "
                "Generate a strong key with: python -c 'import secrets; print(secrets.token_urlsafe(32))'"
            )
        
        # === TELEGRAM ===
        self.TELEGRAM_API_ID = os.getenv('TELEGRAM_API_ID')
        self.TELEGRAM_API_HASH = os.getenv('TELEGRAM_API_HASH')
        
        # === GOFILE / EXTRACTORS ===
        self.GOFILE_TOKEN = os.getenv('GOFILE_TOKEN')

        # === WEBSHARE ===
        self.WEBSHARE_TOKEN = os.getenv('WEBSHARE_TOKEN')
        self.WEBSHARE_LOGIN = os.getenv('WEBSHARE_LOGIN')
        self.WEBSHARE_PASSWORD = os.getenv('WEBSHARE_PASSWORD')
        
        # === DATABASE ===
        self.DATABASE_URL = os.getenv('DATABASE_URL', 'sqlite:///./videos.db')
        self.DB_POOL_SIZE = int(os.getenv('DB_POOL_SIZE', '20'))
        self.DB_MAX_OVERFLOW = int(os.getenv('DB_MAX_OVERFLOW', '40'))
        self.DB_POOL_TIMEOUT = int(os.getenv('DB_POOL_TIMEOUT', '60'))
        
        # === SERVER ===
        self.SERVER_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
        self.SERVER_PORT = int(os.getenv('SERVER_PORT', '8000'))
        self.SERVER_RELOAD = os.getenv('SERVER_RELOAD', 'false').lower() == 'true'
        
        # === BACKUP ===
        self.BACKUP_RETENTION_DAYS = int(os.getenv('BACKUP_RETENTION_DAYS', '7'))
        self.BACKUP_DIR = os.getenv('BACKUP_DIR', 'backups')
        
        # === LOGGING ===
        self.LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()
        self.LOG_JSON = os.getenv('LOG_JSON', 'false').lower() == 'true'

        # === CORS (browser / extension calling API) ===
        self.CORS_ALLOW_ALL = os.getenv('CORS_ALLOW_ALL', 'false').lower() == 'true'
        _raw_origins = os.getenv(
            'CORS_ORIGINS',
            'http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173',
        )
        if self.CORS_ALLOW_ALL:
            self.CORS_ORIGINS = ['*']
        else:
            self.CORS_ORIGINS = [x.strip() for x in _raw_origins.split(',') if x.strip()]

        # === BRIDGE (browser extension) ===
        self.NEXUS_BRIDGE_TOKEN = (os.getenv('NEXUS_BRIDGE_TOKEN') or '').strip()
        
        # === PERFORMANCE ===
        self.PERFORMANCE_MODE = os.getenv('PERFORMANCE_MODE', 'high').lower()  # 'high', 'balanced', 'eco'
        self.MAX_WORKERS = int(os.getenv('MAX_WORKERS', '16'))  # Parallel video processing workers
        self.FFMPEG_THREADS = int(os.getenv('FFMPEG_THREADS', '8'))  # FFmpeg thread count (0 = auto)
        self.GPU_ACCELERATION = os.getenv('GPU_ACCELERATION', 'true').lower() == 'true'  # Enable NVIDIA GPU

    
    @staticmethod
    def _is_strong_password(password: str) -> bool:
        """
        Validate password strength.
        
        Requirements:
        - At least 12 characters
        - Contains uppercase letter
        - Contains lowercase letter
        - Contains digit
        - Contains special character
        """
        if not password or len(password) < 12:
            return False
        
        has_upper = bool(re.search(r'[A-Z]', password))
        has_lower = bool(re.search(r'[a-z]', password))
        has_digit = bool(re.search(r'\d', password))
        has_special = bool(re.search(r'[!@#$%^&*()_+\-=\[\]{};:\'",.<>?/\\|`~]', password))
        
        return has_upper and has_lower and has_digit and has_special
    
    @staticmethod
    def generate_secret_key() -> str:
        """Generate a cryptographically secure secret key."""
        return secrets.token_urlsafe(32)
    
    @staticmethod
    def generate_secure_password(length: int = 16) -> str:
        """
        Generate a secure password meeting strength requirements.
        
        Args:
            length: Password length (minimum 12)
        
        Returns:
            Secure password string
        """
        if length < 12:
            length = 12
        
        # Ensure we have all character types
        chars = (
            secrets.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ') +
            secrets.choice('abcdefghijklmnopqrstuvwxyz') +
            secrets.choice('0123456789') +
            secrets.choice('!@#$%^&*()_+-=[]{}')
        )
        
        # Fill remaining length with random characters
        all_chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}:;<>?'
        chars += ''.join(secrets.choice(all_chars) for _ in range(length - 4))
        
        # Shuffle to avoid predictable pattern
        char_list = list(chars)
        secrets.SystemRandom().shuffle(char_list)
        
        return ''.join(char_list)
    
    def get_database_config(self) -> dict:
        """Get database configuration dictionary."""
        return {
            'url': self.DATABASE_URL,
            'pool_size': self.DB_POOL_SIZE,
            'max_overflow': self.DB_MAX_OVERFLOW,
            'pool_timeout': self.DB_POOL_TIMEOUT
        }
    
    def get_server_config(self) -> dict:
        """Get server configuration dictionary."""
        return {
            'host': self.SERVER_HOST,
            'port': self.SERVER_PORT,
            'reload': self.SERVER_RELOAD
        }
    
    def validate(self) -> list[str]:
        """
        Validate all configuration and return list of warnings/errors.
        
        Returns:
            List of validation messages (empty if all valid)
        """
        issues = []
        
        # Check password strength
        if not self._is_strong_password(self.DASHBOARD_PASSWORD):
            issues.append("Dashboard password does not meet strength requirements")
        
        # Check secret key
        if len(self.SECRET_KEY) < 32:
            issues.append("SECRET_KEY is too short (should be at least 32 characters)")
        
        # Check Telegram credentials if used
        if self.TELEGRAM_API_ID and not self.TELEGRAM_API_HASH:
            issues.append("TELEGRAM_API_ID set but TELEGRAM_API_HASH is missing")
        
        # Check Webshare credentials
        if self.WEBSHARE_TOKEN and not (self.WEBSHARE_LOGIN and self.WEBSHARE_PASSWORD):
            issues.append("WEBSHARE_TOKEN set but login credentials are incomplete")
        
        return issues


# Global configuration instance
try:
    config = Config()
    
    # Log configuration validation on load
    validation_issues = config.validate()
    if validation_issues:
        logger.warning(f"Configuration validation warnings: {'; '.join(validation_issues)}")
    else:
        logger.info("Configuration loaded and validated successfully")
        
except ConfigurationError as e:
    logger.error(f"Configuration error: {e}")
    raise
except Exception as e:
    logger.error(f"Unexpected error loading configuration: {e}")
    raise ConfigurationError(f"Failed to load configuration: {e}")
