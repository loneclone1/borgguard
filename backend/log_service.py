"""BorgGuard – Log Service

Reads and manages backup log files.
Instead of relying on systemd journalctl (not available in Docker),
we read our own application logs and borgmatic output logs.
"""

import asyncio
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from . import config


def get_log_files() -> list[dict]:
    """List available log files sorted by modification time (newest first)."""
    log_dir = config.LOG_DIR
    if not log_dir.exists():
        return []

    files = []
    for f in log_dir.iterdir():
        if f.is_file() and f.suffix in (".log", ".txt"):
            stat = f.stat()
            files.append({
                "name": f.name,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })

    return sorted(files, key=lambda x: x["modified"], reverse=True)


def read_log_file(filename: str, tail: int = 200) -> Optional[dict]:
    """Read a log file, returning the last `tail` lines.

    Args:
        filename: Name of the log file (no path traversal allowed)
        tail: Number of lines to return from the end

    Returns:
        dict with name, content (list of lines), total_lines, or None if not found
    """
    # Prevent path traversal
    safe_name = Path(filename).name
    filepath = config.LOG_DIR / safe_name

    if not filepath.exists() or not filepath.is_file():
        return None

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return None

    total = len(lines)
    content = lines[-tail:] if tail < total else lines

    return {
        "name": safe_name,
        "content": [line.rstrip("\n") for line in content],
        "total_lines": total,
        "showing_from": max(0, total - tail),
    }


def write_job_log(job_id: str, lines: list[str]):
    """Write job output to a log file."""
    log_dir = config.LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filepath = log_dir / f"{timestamp}_{job_id}.log"

    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except Exception:
        pass

    # Cleanup old logs (keep last 100)
    _cleanup_old_logs(log_dir, keep=100)


def _cleanup_old_logs(log_dir: Path, keep: int = 100):
    """Remove the oldest log files if there are more than `keep`."""
    files = sorted(
        [f for f in log_dir.iterdir() if f.is_file() and f.suffix in (".log", ".txt")],
        key=lambda f: f.stat().st_mtime,
    )
    if len(files) > keep:
        for f in files[: len(files) - keep]:
            try:
                f.unlink()
            except Exception:
                pass


async def get_recent_logs_async(max_lines: int = 150) -> str:
    """Read the most recent BorgGuard log files and combine them.

    Since we run inside Docker (no systemd/journalctl), we read our
    own log files from the log directory instead.
    """
    log_dir = config.LOG_DIR

    if not log_dir.exists():
        return "Noch keine Logs vorhanden. Starte ein Backup, um Logs zu erzeugen."

    # Find all log files, sorted newest first
    log_files = sorted(
        [f for f in log_dir.iterdir() if f.is_file() and f.suffix == ".log"],
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )

    if not log_files:
        return "Noch keine Logs vorhanden. Starte ein Backup, um Logs zu erzeugen."

    # Combine lines from the most recent log files
    combined_lines = []
    for log_file in log_files[:5]:  # Last 5 log files
        try:
            mod_time = datetime.fromtimestamp(log_file.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
            header = f"── [{mod_time}] {log_file.name} ──"
            combined_lines.append(header)
            with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                file_lines = f.readlines()
                # Take last N lines per file
                for line in file_lines[-50:]:
                    line_str = line.rstrip("\n")
                    if line_str and not line_str.startswith("──"):
                        if not (line_str.startswith("[") and len(line_str) > 10 and line_str[1:5].isdigit()):
                            line_str = f"[{mod_time}] {line_str}"
                    combined_lines.append(line_str)
            combined_lines.append("")
        except Exception:
            continue

    if not combined_lines:
        return "Logs konnten nicht gelesen werden."

    # Return the last max_lines
    result = combined_lines[-max_lines:] if len(combined_lines) > max_lines else combined_lines
    return "\n".join(result)
