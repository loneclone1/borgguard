"""BorgGuard – Scheduler Service

Manages scheduled/automatic backup jobs using APScheduler.
Configuration is persisted in a JSON file on the persistent volume.
"""

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from . import config

logger = logging.getLogger("borgguard.scheduler")

# Preset schedules
PRESETS = {
    "daily_03": {
        "label": "Täglich um 03:00 Uhr",
        "cron": "0 3 * * *",
        "hour": 3, "minute": 0,
    },
    "daily_22": {
        "label": "Täglich um 22:00 Uhr",
        "cron": "0 22 * * *",
        "hour": 22, "minute": 0,
    },
    "every_6h": {
        "label": "Alle 6 Stunden",
        "cron": "0 */6 * * *",
        "hour": "*/6", "minute": 0,
    },
    "every_12h": {
        "label": "Alle 12 Stunden",
        "cron": "0 */12 * * *",
        "hour": "*/12", "minute": 0,
    },
    "weekly_sun": {
        "label": "Wöchentlich (Sonntag 02:00)",
        "cron": "0 2 * * 0",
        "day_of_week": "sun", "hour": 2, "minute": 0,
    },
}

JOB_ID = "borgguard_scheduled_backup"


class SchedulerService:
    """Manages scheduled automatic backups."""

    def __init__(self):
        self._scheduler = AsyncIOScheduler()
        self._config: dict = self._default_config()
        self._started = False

    def _default_config(self) -> dict:
        return {
            "enabled": False,
            "preset": "daily_03",
            "custom_cron": "",
            "use_custom": False,
            "options": {
                "auto_prune": False,
                "auto_check_weekly": False,
                "verbosity": 1,
            },
            "last_modified": None,
            "last_scheduled_run": None,
        }

    def load_config(self):
        """Load scheduler configuration from disk."""
        try:
            if config.SCHEDULE_FILE.exists():
                with open(config.SCHEDULE_FILE, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                # Merge with defaults to ensure all keys exist
                merged = self._default_config()
                merged.update(saved)
                if isinstance(saved.get("options"), dict):
                    merged["options"] = {**self._default_config()["options"], **saved["options"]}
                self._config = merged
                logger.info(f"Scheduler config loaded: enabled={self._config['enabled']}")
            else:
                logger.info("No scheduler config found, using defaults")
        except Exception as e:
            logger.error(f"Error loading scheduler config: {e}")
            self._config = self._default_config()

    def save_config(self):
        """Save current scheduler configuration to disk."""
        try:
            config.SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(config.SCHEDULE_FILE, "w", encoding="utf-8") as f:
                json.dump(self._config, f, indent=2, ensure_ascii=False)
            logger.info("Scheduler config saved")
        except Exception as e:
            logger.error(f"Error saving scheduler config: {e}")

    def get_config(self) -> dict:
        """Get the current scheduler configuration with additional metadata."""
        result = {**self._config}
        result["presets"] = {k: v["label"] for k, v in PRESETS.items()}
        result["active_cron"] = self._get_active_cron()
        result["active_label"] = self._get_active_label()

        # Next run time
        job = self._scheduler.get_job(JOB_ID)
        if job and job.next_run_time:
            result["next_run"] = job.next_run_time.isoformat()
        else:
            result["next_run"] = None

        return result

    def set_config(self, new_config: dict) -> dict:
        """Update the scheduler configuration and reschedule if needed."""
        if "enabled" in new_config:
            self._config["enabled"] = bool(new_config["enabled"])
        if "preset" in new_config and new_config["preset"] in PRESETS:
            self._config["preset"] = new_config["preset"]
        if "custom_cron" in new_config:
            self._config["custom_cron"] = str(new_config["custom_cron"]).strip()
        if "use_custom" in new_config:
            self._config["use_custom"] = bool(new_config["use_custom"])
        if "options" in new_config and isinstance(new_config["options"], dict):
            self._config["options"].update(new_config["options"])

        self._config["last_modified"] = datetime.now().isoformat()
        self.save_config()
        self._apply_schedule()

        return self.get_config()

    def enable(self) -> dict:
        """Enable the scheduler."""
        self._config["enabled"] = True
        self._config["last_modified"] = datetime.now().isoformat()
        self.save_config()
        self._apply_schedule()
        return self.get_config()

    def disable(self) -> dict:
        """Disable the scheduler."""
        self._config["enabled"] = False
        self._config["last_modified"] = datetime.now().isoformat()
        self.save_config()
        self._apply_schedule()
        return self.get_config()

    def start(self):
        """Start the scheduler (called on app startup)."""
        self.load_config()
        if not self._started:
            self._scheduler.start()
            self._started = True
            logger.info("APScheduler started")
        self._apply_schedule()

    def stop(self):
        """Stop the scheduler (called on app shutdown)."""
        if self._started:
            self._scheduler.shutdown(wait=False)
            self._started = False
            logger.info("APScheduler stopped")

    def _get_active_cron(self) -> str:
        """Get the currently active cron expression."""
        if self._config.get("use_custom") and self._config.get("custom_cron"):
            return self._config["custom_cron"]
        preset = self._config.get("preset", "daily_03")
        return PRESETS.get(preset, PRESETS["daily_03"])["cron"]

    def _get_active_label(self) -> str:
        """Get a human-readable label for the current schedule."""
        if self._config.get("use_custom") and self._config.get("custom_cron"):
            return f"Benutzerdefiniert: {self._config['custom_cron']}"
        preset = self._config.get("preset", "daily_03")
        return PRESETS.get(preset, PRESETS["daily_03"])["label"]

    def _apply_schedule(self):
        """Apply the current schedule configuration to APScheduler."""
        # Remove existing job
        existing = self._scheduler.get_job(JOB_ID)
        if existing:
            self._scheduler.remove_job(JOB_ID)
            logger.info("Removed existing scheduled job")

        if not self._config.get("enabled"):
            logger.info("Scheduler is disabled, no job scheduled")
            return

        cron_expr = self._get_active_cron()
        try:
            parts = cron_expr.split()
            if len(parts) != 5:
                logger.error(f"Invalid cron expression: {cron_expr}")
                return

            trigger = CronTrigger(
                minute=parts[0],
                hour=parts[1],
                day=parts[2],
                month=parts[3],
                day_of_week=parts[4],
            )

            self._scheduler.add_job(
                self._run_scheduled_backup,
                trigger=trigger,
                id=JOB_ID,
                name="BorgGuard Scheduled Backup",
                replace_existing=True,
            )

            job = self._scheduler.get_job(JOB_ID)
            next_run = job.next_run_time if job else "unknown"
            logger.info(f"Scheduled backup: {cron_expr} (next: {next_run})")

        except Exception as e:
            logger.error(f"Error scheduling backup: {e}")

    async def _run_scheduled_backup(self):
        """Execute a scheduled backup via the job manager."""
        from .job_manager import JobManager, JobType, job_manager
        from .restic_service import create_backup, prune_repo as prune_archives
        from .log_service import write_job_log

        logger.info("Starting scheduled backup")
        self._config["last_scheduled_run"] = datetime.now().isoformat()
        self.save_config()

        if job_manager.is_busy():
            logger.warning("Skipping scheduled backup: another job is running")
            return

        async def _run():
            job = job_manager.current_job
            result = await create_backup(
                verbosity=self._config["options"].get("verbosity", 1),
                job=job,
                job_manager=job_manager,
            )
            if result.get("stdout") or result.get("stderr"):
                lines = (result.get("stdout", "") + "\n" + result.get("stderr", "")).splitlines()
                write_job_log("backup_scheduled", lines)

            # Auto-prune if configured
            if self._config["options"].get("auto_prune") and result.get("success"):
                await prune_archives(job=job, job_manager=job_manager)

            return result

        await job_manager.start_job(JobType.BACKUP, _run)


# Global singleton
scheduler = SchedulerService()
