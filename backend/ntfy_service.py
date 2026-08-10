"""BorgGuard – ntfy Notification Service

Sends push notifications via ntfy.sh (or a self-hosted instance)
when backup jobs start, succeed, or fail.
"""

import asyncio
import logging
from typing import Optional

import httpx

from . import config

logger = logging.getLogger("borgguard.ntfy")


async def send_notification(
    title: str,
    message: str,
    priority: str = "default",
    tags: Optional[list[str]] = None,
) -> bool:
    """Send a push notification via ntfy.

    Args:
        title: Notification title
        message: Notification body text
        priority: ntfy priority (min, low, default, high, urgent)
        tags: Optional emoji/tag list (e.g. ["white_check_mark", "backup"])

    Returns:
        True if notification was sent successfully, False otherwise.
    """
    if not config.NTFY_ENABLED:
        return False

    url = f"{config.NTFY_URL.rstrip('/')}/{config.NTFY_TOPIC}"

    headers = {
        "Title": title.encode("utf-8"),
        "Priority": priority,
    }

    if tags:
        headers["Tags"] = ",".join(tags)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, content=message, headers=headers)
            if response.status_code == 200:
                logger.info(f"ntfy notification sent: {title}")
                return True
            else:
                logger.warning(f"ntfy returned status {response.status_code}: {response.text}")
                return False
    except Exception as e:
        logger.warning(f"ntfy notification failed: {e}")
        return False


async def notify_job_started(job_type: str, job_id: str):
    """Notify that a backup job has started."""
    type_labels = {
        "backup": "Backup",
        "check": "Integritätsprüfung",
        "prune": "Bereinigung",
        "compact": "Komprimierung",
        "other": "System-Update",
    }
    label = type_labels.get(job_type, job_type)

    await send_notification(
        title=f"🛡️ BorgGuard by JB: {label} gestartet",
        message=f"Job {job_id} wurde gestartet.",
        priority="low",
        tags=["hourglass_flowing_sand", "borgguard"],
    )


async def notify_job_completed(job_type: str, job_id: str, duration_seconds: float = 0):
    """Notify that a backup job completed successfully."""
    type_labels = {
        "backup": "Backup",
        "check": "Integritätsprüfung",
        "prune": "Bereinigung",
        "compact": "Komprimierung",
        "other": "System-Update",
    }
    label = type_labels.get(job_type, job_type)

    duration_str = ""
    if duration_seconds > 0:
        minutes = int(duration_seconds // 60)
        seconds = int(duration_seconds % 60)
        if minutes > 0:
            duration_str = f" (Dauer: {minutes}m {seconds}s)"
        else:
            duration_str = f" (Dauer: {seconds}s)"

    await send_notification(
        title=f"✅ BorgGuard by JB: {label} erfolgreich",
        message=f"Job {job_id} wurde erfolgreich abgeschlossen.{duration_str}",
        priority="default",
        tags=["white_check_mark", "borgguard"],
    )


async def notify_job_failed(job_type: str, job_id: str, error: str = ""):
    """Notify that a backup job has failed."""
    type_labels = {
        "backup": "Backup",
        "check": "Integritätsprüfung",
        "prune": "Bereinigung",
        "compact": "Komprimierung",
        "other": "System-Update",
    }
    label = type_labels.get(job_type, job_type)

    error_snippet = ""
    if error:
        # Limit error message to 200 chars for the notification
        error_snippet = f"\n\nFehler: {error[:200]}"

    await send_notification(
        title=f"❌ BorgGuard by JB: {label} fehlgeschlagen",
        message=f"Job {job_id} ist fehlgeschlagen.{error_snippet}",
        priority="high",
        tags=["x", "warning", "borgguard"],
    )
