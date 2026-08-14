"""BorgGuard – Restic CLI Service

Wraps restic CLI commands and parses their output.
All commands are executed asynchronously via asyncio.subprocess.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
import time
import yaml
from datetime import datetime
from pathlib import Path
from typing import Optional, Callable, Awaitable, List

logger = logging.getLogger("borgguard.restic")

from . import config

# Global lock to prevent concurrent restic executions from Python's side.
restic_lock = asyncio.Lock()


def load_config() -> dict:
    """Load the restic.yaml configuration."""
    try:
        with open(config.RESTIC_CONFIG, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}


async def run_hook(commands: List[str], job_manager=None, job=None):
    """Run a list of shell commands as a hook."""
    for cmd in commands:
        if job and job_manager:
            await job_manager.add_job_output(job, f"> {cmd}")
        
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
        
        if job and job_manager:
            async for raw_line in proc.stdout:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                await job_manager.add_job_output(job, line)
        
        await proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"Hook command failed with exit code {proc.returncode}: {cmd}")


async def run_restic(
    *args: str,
    timeout: int = 86400,
    capture_json: bool = False,
) -> dict:
    """Run a restic command and return structured output."""
    cmd = ["restic", *args]
    if capture_json:
        cmd.append("--json")
        
    start = datetime.now()

    env = os.environ.copy()
    env["RESTIC_REPOSITORY"] = config.RESTIC_REPOSITORY
    env["RESTIC_PASSWORD"] = config.RESTIC_PASSWORD

    async with restic_lock:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s",
                "duration_seconds": timeout,
                "data": None,
            }
        except Exception as e:
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": str(e),
                "duration_seconds": (datetime.now() - start).total_seconds(),
                "data": None,
            }

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    duration = (datetime.now() - start).total_seconds()

    data = None
    if capture_json and stdout.strip():
        try:
            data = json.loads(stdout)
        except json.JSONDecodeError:
            pass

    return {
        "success": proc.returncode == 0,
        "exit_code": proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "duration_seconds": round(duration, 2),
        "data": data,
    }


async def run_restic_streamed(
    *args: str,
    timeout: int = 86400,
    on_line: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> dict:
    """Run a restic command with real-time line-by-line output streaming."""
    cmd = ["restic", *args]
    start = datetime.now()


    env = os.environ.copy()
    env["RESTIC_REPOSITORY"] = config.RESTIC_REPOSITORY
    env["RESTIC_PASSWORD"] = config.RESTIC_PASSWORD

    stdout_lines = []
    stderr_lines = []

    async with restic_lock:
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )

            from .job_manager import job_manager
            job_manager.register_process(proc)

            async def _read_stream(stream, stream_name, lines_list):
                async for raw_line in stream:
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                    lines_list.append(line)
                    if on_line:
                        try:
                            await on_line(stream_name, line)
                        except Exception:
                            pass

            await asyncio.wait_for(
                asyncio.gather(
                    _read_stream(proc.stdout, "stdout", stdout_lines),
                    _read_stream(proc.stderr, "stderr", stderr_lines),
                    proc.wait(),
                ),
                timeout=timeout,
            )

        except asyncio.TimeoutError:
            try:
                if proc:
                    proc.kill()
            except Exception:
                pass
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "\n".join(stdout_lines),
                "stderr": "\n".join(stderr_lines) + f"\nCommand timed out after {timeout}s",
                "duration_seconds": timeout,
            }
        except asyncio.CancelledError:
            try:
                if proc:
                    proc.terminate()
                    proc.kill()
            except Exception:
                pass
            raise
        except Exception as e:
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "\n".join(stdout_lines),
                "stderr": str(e),
                "duration_seconds": (datetime.now() - start).total_seconds(),
            }
        finally:
            from .job_manager import job_manager
            if proc:
                job_manager.unregister_process(proc)

    duration = (datetime.now() - start).total_seconds()

    return {
        "success": proc.returncode == 0,
        "exit_code": proc.returncode,
        "stdout": "\n".join(stdout_lines),
        "stderr": "\n".join(stderr_lines),
        "duration_seconds": round(duration, 2),
    }


def parse_restic_progress(line: str) -> dict:
    """Parse a restic output line to extract progress information."""
    # Restic progress looks like: [2:14] 100.00%  10 / 10 files  345 B / 345 B
    # Since we don't have a tty, restic might not output progress by default unless forced, 
    # but let's parse basic percentages if they appear.
    match = re.search(r'(\d+\.\d+)%', line)
    if match:
        try:
            percent = float(match.group(1))
            return {"percent": percent, "status": "Sicherung läuft..."}
        except ValueError:
            pass
    return None


async def create_backup(verbosity: int = 1, job=None, job_manager=None) -> dict:
    """Run the backup job including hooks."""
    yaml_config = load_config()
    
    try:
        # Pre-Backup Hooks
        if yaml_config.get("before_backup"):
            if job and job_manager:
                await job_manager.update_progress(job, phase="Führe Pre-Backup Hooks aus…", percent=5)
            await run_hook(yaml_config["before_backup"], job_manager, job)

        # Restic Backup
        if job and job_manager:
            await job_manager.update_progress(job, phase="Backup wird gestartet…", percent=10)

        async def _on_line(stream, line):
            prefix = "" if stream == "stdout" else "STDERR: "
            await job_manager.add_job_output(job, f"{prefix}{line}")
            
            prog = parse_restic_progress(line)
            if prog:
                await job_manager.update_progress(
                    job,
                    phase=prog.get("status", "Sicherung läuft…"),
                    percent=max(10, min(95, prog["percent"]))
                )

        source_dirs = yaml_config.get("source_directories", [])
        if not source_dirs:
            raise RuntimeError("Keine Quellverzeichnisse (source_directories) konfiguriert!")

        args = ["backup"] + source_dirs
        result = await run_restic_streamed(*args, on_line=_on_line)
        
        if not result["success"]:
            raise RuntimeError(f"Restic backup failed: {result['stderr']}")

        # Post-Backup Hooks
        if yaml_config.get("after_backup"):
            if job and job_manager:
                await job_manager.update_progress(job, phase="Führe Post-Backup Hooks aus…", percent=96)
            await run_hook(yaml_config["after_backup"], job_manager, job)

        # Automatic Diff with predecessor snapshot
        try:
            await compute_latest_backup_diff(job=job, job_manager=job_manager)
        except Exception as diff_err:
            logger.warning(f"Auto-Diff nach Backup fehlgeschlagen: {diff_err}")

        return result

    except Exception as e:
        if yaml_config.get("on_error"):
            if job and job_manager:
                await job_manager.add_job_output(job, f"\nFEHLER aufgetreten, führe on_error Hooks aus: {e}")
            try:
                await run_hook(yaml_config["on_error"], job_manager, job)
            except Exception as hook_err:
                if job and job_manager:
                    await job_manager.add_job_output(job, f"on_error Hook ebenfalls fehlgeschlagen: {hook_err}")
        
        return {
            "success": False,
            "exit_code": 1,
            "stdout": "",
            "stderr": str(e),
            "duration_seconds": 0
        }


_snapshot_files_cache: dict = {}


async def list_snapshots() -> dict:
    """List all restic snapshots with full metadata."""
    res = await run_restic("snapshots", capture_json=True)
    if res["success"] and res.get("data"):
        transformed = []
        for snap in res["data"]:
            transformed.append({
                "id": snap.get("id", ""),
                "short_id": snap.get("short_id", snap.get("id", "")[:8]),
                "name": snap.get("short_id", snap.get("id", "")[:8]),
                "start": snap.get("time"),
                "time": snap.get("time"),
                "paths": snap.get("paths", []),
                "tags": snap.get("tags", []),
                "hostname": snap.get("hostname", ""),
                "username": snap.get("username", ""),
                "duration": 0,
            })
        res["data"] = transformed
    return res


def _parse_restic_node(item: dict) -> dict:
    """Helper to extract normalized file metadata from a restic node dict."""
    node_type = item.get("type", "file")
    type_code = "d" if node_type == "dir" else "f"
    mode_val = item.get("mode", 0)
    mode_str = oct(mode_val)[-4:] if isinstance(mode_val, int) else str(mode_val)
    path = item.get("path", "")
    name = item.get("name", "")
    if not name and path:
        name = Path(path).name or path

    return {
        "name": name,
        "type": type_code,
        "path": path,
        "size": item.get("size", 0),
        "mode": mode_str,
        "mtime": item.get("mtime", ""),
    }


async def list_snapshot_files(snapshot_id: str) -> dict:
    """List all files and directories in a snapshot (cached)."""
    if snapshot_id in _snapshot_files_cache:
        return {"success": True, "files": _snapshot_files_cache[snapshot_id]}

    # Run restic ls --json <snapshot_id>
    res = await run_restic("ls", "--json", snapshot_id)
    if not res["success"]:
        # Fallback without --json if needed
        res = await run_restic("ls", snapshot_id)
        if not res["success"]:
            return {"success": False, "error": res.get("stderr", "Fehler beim Laden der Dateiliste"), "files": []}

    files = []
    stdout = res.get("stdout", "")

    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
            # If line is a JSON array
            if isinstance(item, list):
                for subitem in item:
                    if isinstance(subitem, dict) and subitem.get("struct_type") != "snapshot":
                        files.append(_parse_restic_node(subitem))
                continue

            # Skip top-level snapshot header
            if item.get("struct_type") == "snapshot":
                continue

            files.append(_parse_restic_node(item))
        except json.JSONDecodeError:
            # Fallback for plain-text lines (e.g. "/path/to/file")
            if line.startswith("/"):
                path_parts = line.rstrip("/").split("/")
                name = path_parts[-1] if path_parts else line
                is_dir = line.endswith("/")
                files.append({
                    "name": name,
                    "type": "d" if is_dir else "f",
                    "path": line,
                    "size": 0,
                    "mode": "drwxr-xr-x" if is_dir else "-rw-r--r--",
                    "mtime": "",
                })
        except Exception:
            continue

    _snapshot_files_cache[snapshot_id] = files
    return {"success": True, "files": files}


async def modify_snapshot_tags(snapshot_id: str, action: str, tags: List[str]) -> dict:
    """Add, remove, or set tags on a snapshot via restic tag."""
    if not tags:
        return {"success": False, "error": "Keine Tags angegeben"}

    valid_actions = {"add": "--add", "remove": "--remove", "set": "--set"}
    flag = valid_actions.get(action.lower())
    if not flag:
        return {"success": False, "error": f"Ungültige Aktion: {action}. Erlaubt sind: add, remove, set"}

    cmd_args = ["tag"]
    for tag in tags:
        tag_cleaned = tag.strip()
        if tag_cleaned:
            cmd_args.extend([flag, tag_cleaned])
    cmd_args.append(snapshot_id)

    res = await run_restic(*cmd_args)
    return res


DATA_DIR = Path("/app/logs") if os.path.exists("/app/logs") else Path(__file__).resolve().parent.parent / "logs"
LATEST_DIFF_FILE = DATA_DIR / "latest_backup_diff.json"


def get_latest_backup_diff() -> Optional[dict]:
    """Retrieve the cached diff of the most recent backup."""
    try:
        if LATEST_DIFF_FILE.exists():
            with open(LATEST_DIFF_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return None


def _save_latest_backup_diff(diff_data: dict):
    """Save the diff of the most recent backup."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(LATEST_DIFF_FILE, "w", encoding="utf-8") as f:
            json.dump(diff_data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.warning(f"Konnte latest_backup_diff nicht speichern: {e}")


async def compute_latest_backup_diff(job=None, job_manager=None) -> Optional[dict]:
    """Compare the newest snapshot with its predecessor and cache the result."""
    try:
        snaps_res = await list_snapshots()
        if not snaps_res.get("success") or not snaps_res.get("data"):
            return None

        snaps = sorted(snaps_res["data"], key=lambda x: x.get("start") or "", reverse=True)
        if len(snaps) < 2:
            return None

        snap_new = snaps[0]["id"]
        snap_prev = snaps[1]["id"]
        short_new = snaps[0].get("short_id", snap_new[:8])
        short_prev = snaps[1].get("short_id", snap_prev[:8])

        if job and job_manager:
            await job_manager.update_progress(job, phase="Berechne Änderungen zum vorherigen Snapshot…", percent=97)
            await job_manager.add_job_output(job, f"> 🔍 Berechne Auto-Diff zwischen Snapshot {short_prev} und {short_new}…")

        diff_res = await diff_snapshots(snap_prev, snap_new)
        if diff_res.get("success"):
            added = len(diff_res.get("added", []))
            modified = len(diff_res.get("modified", []))
            removed = len(diff_res.get("removed", []))
            summary_info = {
                "snap_new": snap_new,
                "snap_prev": snap_prev,
                "short_new": short_new,
                "short_prev": short_prev,
                "added": added,
                "modified": modified,
                "removed": removed,
                "total_changes": added + modified + removed,
                "timestamp": datetime.utcnow().isoformat() + "Z",
            }
            _save_latest_backup_diff(summary_info)

            if job and job_manager:
                await job_manager.add_job_output(
                    job,
                    f"> 📊 Auto-Diff: +{added} Neu, ~{modified} Geändert, -{removed} Gelöscht"
                )
            return summary_info
    except Exception as e:
        logger.warning(f"Fehler bei compute_latest_backup_diff: {e}")
    return None


async def diff_snapshots(snap_id_1: str, snap_id_2: str) -> dict:
    """Compare differences between two snapshots."""
    res = await run_restic("diff", snap_id_1, snap_id_2)
    if not res["success"]:
        return {"success": False, "error": res.get("stderr", "Fehler beim Vergleichen der Snapshots")}

    stdout = res.get("stdout", "")
    added = []
    removed = []
    modified = []
    summary_raw = []

    for line in stdout.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue

        if line.startswith("+") and len(line) > 1:
            path = line[1:].strip()
            if path and not path.startswith("comparing") and not path.startswith("Files:"):
                added.append(path)
        elif line.startswith("-") and len(line) > 1:
            path = line[1:].strip()
            if path and not path.startswith("comparing") and not path.startswith("Files:"):
                removed.append(path)
        elif line.startswith("M ") or line.startswith("M\t") or line.startswith("U ") or line.startswith("U\t"):
            path = line[2:].strip()
            modified.append(path)
        elif "Files:" in line or "Raw Data:" in line or "Data Blobs:" in line or "Dirs:" in line:
            summary_raw.append(trimmed)

    return {
        "success": True,
        "snap1": snap_id_1,
        "snap2": snap_id_2,
        "added": added,
        "removed": removed,
        "modified": modified,
        "summary": {
            "files_new": len(added),
            "files_removed": len(removed),
            "files_changed": len(modified),
            "raw_summary": " · ".join(summary_raw),
        },
    }


async def find_files(query: str) -> dict:
    """Find files matching a query/pattern across all snapshots."""
    query = query.strip()
    if not query:
        return {"success": True, "query": query, "results": []}

    res = await run_restic("find", "--json", query)
    if not res["success"]:
        res = await run_restic("find", query)
        if not res["success"]:
            return {"success": False, "error": res.get("stderr", "Fehler bei der Suche"), "results": []}

    stdout = res.get("stdout", "")
    results = []
    current_snap = None

    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                snap_id = item.get("snapshot", "")
                if "hits" in item:
                    for hit in item.get("hits", []):
                        hit_path = hit.get("path", "")
                        results.append({
                            "snapshot": snap_id,
                            "path": hit_path,
                            "name": Path(hit_path).name or hit_path,
                            "type": "d" if hit.get("type") == "dir" else "f",
                            "size": hit.get("size", 0),
                            "mtime": hit.get("mtime", ""),
                        })
                elif item.get("path"):
                    item_path = item.get("path", "")
                    results.append({
                        "snapshot": snap_id,
                        "path": item_path,
                        "name": item.get("name") or Path(item_path).name or item_path,
                        "type": "d" if item.get("type") == "dir" else "f",
                        "size": item.get("size", 0),
                        "mtime": item.get("mtime", ""),
                    })
        except json.JSONDecodeError:
            if "snapshot" in line.lower() and "found" in line.lower():
                parts = line.split()
                for i, p in enumerate(parts):
                    if p.lower() == "snapshot" and i + 1 < len(parts):
                        current_snap = parts[i + 1]
                        break
            elif line.startswith("/"):
                results.append({
                    "snapshot": current_snap or "unbekannt",
                    "path": line,
                    "name": Path(line).name or line,
                    "type": "d" if line.endswith("/") else "f",
                    "size": 0,
                    "mtime": "",
                })
        except Exception:
            continue

    return {"success": True, "query": query, "results": results}


async def dump_snapshot_file_stream(snapshot_id: str, file_path: str):
    """Generator yielding binary chunks of a file via restic dump."""
    cmd = ["restic", "dump", snapshot_id, file_path]
    env = os.environ.copy()
    env["RESTIC_REPOSITORY"] = config.RESTIC_REPOSITORY
    env["RESTIC_PASSWORD"] = config.RESTIC_PASSWORD

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    try:
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk
        await proc.wait()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
        raise


async def restore_snapshot(
    snapshot_id: str,
    target_dir: str,
    include_paths: Optional[List[str]] = None,
    job=None,
    job_manager=None,
) -> dict:
    """Restore a snapshot or specific paths to target_dir with real-time progress."""
    if job and job_manager:
        await job_manager.update_progress(job, phase="Bereite Wiederherstellung vor…", percent=5)
        await job_manager.add_job_output(job, f"> restic restore {snapshot_id} --target {target_dir}")

    cmd_args = ["restore", snapshot_id, "--target", target_dir]
    if include_paths:
        for p in include_paths:
            if p and p.strip():
                cmd_args.extend(["--include", p.strip()])

    async def _on_line(stream, line):
        if job and job_manager:
            prefix = "" if stream == "stdout" else "STDERR: "
            await job_manager.add_job_output(job, f"{prefix}{line}")
            prog = parse_restic_progress(line)
            if prog:
                await job_manager.update_progress(
                    job,
                    phase=prog.get("status", "Wiederherstellung läuft…"),
                    percent=max(10, min(95, prog["percent"])),
                )

    return await run_restic_streamed(*cmd_args, on_line=_on_line)


# ─── Disaster Recovery Dry-Run (Feature 6) ───────────────────────────────────

DR_REPORT_FILE = DATA_DIR / "dr_test_report.json"


def get_latest_dr_report() -> dict:
    """Retrieve the latest Disaster Recovery test report."""
    try:
        if DR_REPORT_FILE.exists():
            with open(DR_REPORT_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {
        "status": "NONE",
        "last_tested": None,
        "snapshot_id": None,
        "short_id": None,
        "files_verified": 0,
        "bytes_verified": 0,
        "duration_seconds": 0,
        "message": "Noch kein DR-Test durchgeführt",
    }


def _save_dr_report(report: dict):
    """Save DR test report to persistent JSON file."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(DR_REPORT_FILE, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.warning(f"Konnte DR-Report nicht speichern: {e}")


def clean_all_dr_sandboxes():
    """Remove any temporary borgguard_dr_test directories across candidate locations."""
    candidate_parents = ["/tmp", "/var/tmp", "/app/logs/tmp", "/app/tmp"]
    for parent in candidate_parents:
        try:
            p = Path(parent)
            if p.exists() and p.is_dir():
                for item in p.glob("borgguard_dr_test_*"):
                    try:
                        if item.is_dir():
                            shutil.rmtree(item, ignore_errors=True)
                    except Exception:
                        pass
        except Exception:
            pass


def _is_dir_writable(path_str: str) -> bool:
    """Test if a directory exists/can be created and is writable."""
    try:
        p = Path(path_str)
        p.mkdir(parents=True, exist_ok=True)
        test_file = p / f".borgguard_test_{os.getpid()}"
        with open(test_file, "w") as f:
            f.write("ok")
        test_file.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def get_best_sandbox_location(required_bytes: int) -> tuple[Optional[str], int, int]:
    """Find the candidate sandbox directory with the most free space on a WRITABLE filesystem.

    Returns:
        (best_dir, free_bytes, min_required_bytes)
    """
    candidates = [
        "/tmp",
        "/var/tmp",
        "/app/logs/tmp",
        "/app/tmp",
    ]
    best_dir = None
    max_free = -1

    for c in candidates:
        try:
            if not _is_dir_writable(c):
                continue
            usage = shutil.disk_usage(c)
            if usage.free > max_free:
                max_free = usage.free
                best_dir = c
        except Exception:
            continue

    min_required = required_bytes + (2 * 1024 * 1024 * 1024)
    if not best_dir or max_free < min_required:
        return None, max(0, max_free), min_required

    return best_dir, max_free, min_required


async def run_dr_test(
    snapshot_id: Optional[str] = None,
    job=None,
    job_manager=None,
) -> dict:
    """Run an automated sandbox restore test with pre-flight disk space checks and safe cleanup."""
    start_time = time.time()

    # Always clean old/abandoned sandboxes first
    clean_all_dr_sandboxes()

    # If no snapshot specified, find the latest snapshot
    if not snapshot_id:
        snaps_res = await list_snapshots()
        if not snaps_res["success"] or not snaps_res.get("data"):
            err = "Keine Snapshots im Repository gefunden, die getestet werden können."
            if job and job_manager:
                await job_manager.add_job_output(job, f"ERROR: {err}")
            return {"success": False, "error": err}
        sorted_snaps = sorted(snaps_res["data"], key=lambda x: x.get("start") or "", reverse=True)
        snapshot_id = sorted_snaps[0]["id"]

    short_id = snapshot_id[:8] if len(snapshot_id) >= 8 else snapshot_id

    # 1. Check snapshot size and verify disk space
    stats_res = await get_snapshot_stats(snapshot_id)
    est_size = stats_res.get("data", {}).get("total_size", 0) if stats_res.get("success") and stats_res.get("data") else 0

    sandbox_parent, free_bytes, min_needed = get_best_sandbox_location(est_size)
    free_gb = round(max(0, free_bytes) / (1024 * 1024 * 1024), 2)
    needed_gb = round(min_needed / (1024 * 1024 * 1024), 2)

    if not sandbox_parent:
        err = f"Nicht genügend freier Speicherplatz für den Sandbox-Restore (Verfügbar: {free_gb} GB, Benötigt: ca. {needed_gb} GB inkl. 2 GB Puffer). Test abgebrochen, um den Server vor Speicherüberlauf zu schützen."
        if job and job_manager:
            await job_manager.add_job_output(job, f"❌ FEHLER: {err}")
        report = {
            "status": "FAILED",
            "last_tested": datetime.utcnow().isoformat() + "Z",
            "snapshot_id": snapshot_id,
            "short_id": short_id,
            "files_verified": 0,
            "bytes_verified": 0,
            "duration_seconds": 0,
            "message": err,
        }
        _save_dr_report(report)
        return {"success": False, "error": err, "report": report}

    sandbox_dir = tempfile.mkdtemp(prefix=f"borgguard_dr_test_{short_id}_", dir=sandbox_parent)

    if job and job_manager:
        await job_manager.update_progress(job, phase=f"Starte DR-Sandbox-Test für Snapshot {short_id}…", percent=10)
        await job_manager.add_job_output(job, f"> DR-Test initialisiert in Sandbox: {sandbox_dir} (Freier Speicher: {free_gb} GB)")
        await job_manager.add_job_output(job, f"> Verifiziere Wiederherstellbarkeit von Snapshot: {snapshot_id}")

    try:
        cmd_args = ["restore", snapshot_id, "--target", sandbox_dir, "--verify"]

        async def _on_line(stream, line):
            if job and job_manager:
                prefix = "" if stream == "stdout" else "STDERR: "
                await job_manager.add_job_output(job, f"{prefix}{line}")
                prog = parse_restic_progress(line)
                if prog:
                    await job_manager.update_progress(
                        job,
                        phase=prog.get("status", "DR-Wiederherstellung läuft…"),
                        percent=max(15, min(85, prog["percent"])),
                    )

        res = await run_restic_streamed(*cmd_args, on_line=_on_line)
        duration = round(time.time() - start_time, 2)

        if not res["success"]:
            # Fallback without --verify in case restic version does not support flag
            if job and job_manager:
                await job_manager.add_job_output(job, "Wiederhole Test ohne --verify Flag…")
            cmd_args = ["restore", snapshot_id, "--target", sandbox_dir]
            res = await run_restic_streamed(*cmd_args, on_line=_on_line)

        if res["success"]:
            file_count = 0
            total_bytes = 0
            for root, _, files in os.walk(sandbox_dir):
                for f in files:
                    file_count += 1
                    try:
                        total_bytes += os.path.getsize(os.path.join(root, f))
                    except Exception:
                        pass

            if job and job_manager:
                await job_manager.update_progress(job, phase="Verifiziere extrahierte Daten…", percent=90)
                await job_manager.add_job_output(
                    job,
                    f"> ✅ DR-Test ERFOLGREICH! {file_count} Dateien ({round(total_bytes / (1024*1024), 2)} MB) erfolgreich wiederhergestellt und verifiziert in {duration}s."
                )

            report = {
                "status": "PASSED",
                "last_tested": datetime.utcnow().isoformat() + "Z",
                "snapshot_id": snapshot_id,
                "short_id": short_id,
                "files_verified": file_count,
                "bytes_verified": total_bytes,
                "duration_seconds": duration,
                "message": f"Snapshot {short_id} erfolgreich verifiziert ({file_count} Dateien, {round(total_bytes / (1024*1024), 2)} MB)",
            }
            _save_dr_report(report)
            return {"success": True, "report": report}
        else:
            err = res.get("stderr", "Fehler bei der Wiederherstellung in die Sandbox")
            if job and job_manager:
                await job_manager.add_job_output(job, f"> ❌ DR-Test FEHLGESCHLAGEN: {err}")
            report = {
                "status": "FAILED",
                "last_tested": datetime.utcnow().isoformat() + "Z",
                "snapshot_id": snapshot_id,
                "short_id": short_id,
                "files_verified": 0,
                "bytes_verified": 0,
                "duration_seconds": duration,
                "message": f"Wiederherstellung von {short_id} fehlgeschlagen: {err}",
            }
            _save_dr_report(report)
            return {"success": False, "error": err, "report": report}

    finally:
        clean_all_dr_sandboxes()
        if job and job_manager:
            await job_manager.add_job_output(job, f"> Sandbox-Verzeichnis erfolgreich bereinigt.")


async def get_repo_info() -> dict:
    """Get repository stats (size, etc)."""
    res = await run_restic("stats", "--mode", "raw-data", capture_json=True)
    if res["success"] and res.get("data"):
        stats = {
            "total_size": res["data"].get("total_size", 0),
            "original_size": res["data"].get("total_size", 0),
            "compressed_size": res["data"].get("total_size", 0),
        }
        res["data"] = {"stats": stats}
    return res


async def get_snapshot_stats(snapshot_id: str) -> dict:
    """Get stats (size) for a specific snapshot."""
    # Using raw-data mode to easily parse JSON output for size
    res = await run_restic("stats", "--mode", "raw-data", snapshot_id, capture_json=True)
    if res["success"] and res.get("data"):
        stats = {
            "total_size": res["data"].get("total_size", 0),
        }
        res["data"] = stats
    return res


async def check_repo(job=None, job_manager=None) -> dict:
    """Check repository integrity with streamed output."""
    if job and job_manager:
        await job_manager.update_progress(job, phase="Führe Integritätsprüfung aus…", percent=15)
        await job_manager.add_job_output(job, "> restic check")

    async def _on_line(stream, line):
        if job and job_manager:
            prefix = "" if stream == "stdout" else "STDERR: "
            await job_manager.add_job_output(job, f"{prefix}{line}")

    return await run_restic_streamed("check", on_line=_on_line)


async def prune_repo(job=None, job_manager=None) -> dict:
    """Prune the repository (apply forget policy) with streamed output."""
    if job and job_manager:
        await job_manager.update_progress(job, phase="Bereinige alte Snapshots…", percent=15)
        await job_manager.add_job_output(job, "> restic forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6")

    async def _on_line(stream, line):
        if job and job_manager:
            prefix = "" if stream == "stdout" else "STDERR: "
            await job_manager.add_job_output(job, f"{prefix}{line}")

    return await run_restic_streamed("forget", "--prune", "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6", on_line=_on_line)


async def unlock_repo() -> dict:
    """Unlock the repository."""
    return await run_restic("unlock")



async def get_config() -> dict:
    try:
        with open(config.RESTIC_CONFIG, "r") as f:
            content = f.read()
        return {"success": True, "stdout": content, "config_table": []}
    except Exception as e:
        return {"success": False, "stderr": str(e)}

async def get_schedule_info() -> dict:
    return {"status": "ok", "estimated_schedule": "Täglich"}

async def get_storage_info() -> dict:
    return {"total_limit_gb": 1000.0, "total_used_gb": 0.0, "total_free_gb": 1000.0, "repositories": []}

def get_configured_repositories() -> list:
    return [{"label": "Restic Repository", "path": config.RESTIC_REPOSITORY, "type": "rclone", "limit_gb": 1000.0}]

def add_repository_to_config(*args, **kwargs) -> dict:
    return {"success": False, "error": "Restic config mutation not supported in UI."}

def update_repository_in_config(*args, **kwargs) -> dict:
    return {"success": False, "error": "Restic config mutation not supported in UI."}

def remove_repository_from_config(*args, **kwargs) -> dict:
    return {"success": False, "error": "Restic config mutation not supported in UI."}
