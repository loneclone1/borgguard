"""BorgGuard – Restic CLI Service

Wraps restic CLI commands and parses their output.
All commands are executed asynchronously via asyncio.subprocess.
"""

import asyncio
import json
import os
import re
import yaml
from datetime import datetime
from pathlib import Path
from typing import Optional, Callable, Awaitable, List

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
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )

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
        except Exception as e:
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "\n".join(stdout_lines),
                "stderr": str(e),
                "duration_seconds": (datetime.now() - start).total_seconds(),
            }

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
                await job_manager.update_progress(job, phase="Führe Post-Backup Hooks aus…", percent=98)
            await run_hook(yaml_config["after_backup"], job_manager, job)

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
