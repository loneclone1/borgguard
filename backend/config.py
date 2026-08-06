"""BorgGuard – Application Configuration"""

import os
from pathlib import Path

# Authentication
DASHBOARD_USER = os.getenv("DASHBOARD_USER", "admin")
DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD", "borgguard")

# Restic
RESTIC_CONFIG = os.getenv("RESTIC_CONFIG", "/etc/restic.yaml")
RESTIC_PASSWORD = os.getenv("RESTIC_PASSWORD", "")
RESTIC_REPOSITORY = os.getenv("RESTIC_REPOSITORY", "rclone:gdrive:BorgGuard-Restic")

# Logging
LOG_DIR = Path(os.getenv("LOG_DIR", "/app/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)
MAX_LOG_LINES = 500
# Integrations
IMMICH_KIOSK_CONFIG_PATH = os.getenv("IMMICH_KIOSK_CONFIG_PATH", "/home/jb/immich-kiosk/config/config.yaml")

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8443"))

# ntfy Push Notifications
NTFY_ENABLED = os.getenv("NTFY_ENABLED", "true").lower() in ("true", "1", "yes")
NTFY_URL = os.getenv("NTFY_URL", "https://ntfy.sh")
NTFY_TOPIC = os.getenv("NTFY_TOPIC", "borgguard-backup")

# Scheduler
SCHEDULE_FILE = Path(os.getenv("SCHEDULE_FILE", "/app/logs/schedule.json"))

# Google Drive & Repositories
GDRIVE_URL = os.getenv("GDRIVE_URL", "https://drive.google.com")
GDRIVE_STORAGE_LIMIT_GB = float(os.getenv("GDRIVE_STORAGE_LIMIT_GB", "1000"))  # Default 1 TB
REPO_META_FILE = Path(os.getenv("REPO_META_FILE", "/app/logs/repositories_meta.json"))

# Docker containers to monitor
MONITORED_CONTAINERS = [
    "immich_server",
    "immich_postgres",
    "immich_redis",
    "immich_machine_learning",
    "nextcloud_app",
    "nextcloud_db",
    "nextcloud_redis",
]
