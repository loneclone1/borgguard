"""BorgGuard – Main FastAPI Application

Central entry point for the BorgGuard backup management dashboard.
Serves the REST API and the static frontend files.
"""

import asyncio
import base64
from contextlib import asynccontextmanager
from pathlib import Path
from time import time

from fastapi import Depends, FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .auth import verify_credentials
from .restic_service import (
    add_repository_to_config,
    unlock_repo as break_lock,
    check_repo as check_integrity,
    create_backup,
    list_snapshots,
    get_config,
    get_configured_repositories,
    get_repo_info,
    get_schedule_info,
    get_storage_info,
    prune_repo,
    remove_repository_from_config,
    update_repository_in_config,
)
from .docker_service import get_container_status, get_service_summary, perform_container_action, update_compose_project
from .job_manager import JobManager, JobType, job_manager
from .log_service import (
    get_log_files,
    get_recent_logs_async,
    read_log_file,
    write_job_log,
)
from .scheduler_service import scheduler

# Build timestamp for cache-busting (regenerated on each container start)
BUILD_TS = str(int(time()))

STATUS_CACHE_TIME = 0.0
STATUS_CACHE_TTL = 300.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan – startup and shutdown."""
    print("🛡️  RestiGuard by JB gestartet")
    print(f"   Dashboard: http://{config.HOST}:{config.PORT}")
    print(f"   Restic-Config: {config.RESTIC_CONFIG}")
    # Start scheduler
    scheduler.start()
    print(f"   Scheduler: {'aktiv' if scheduler.get_config().get('enabled') else 'inaktiv'}")
    yield
    # Stop scheduler
    scheduler.stop()
    print("🛡️  RestiGuard by JB gestoppt")


app = FastAPI(
    title="RestiGuard by JB",
    description="Backup-Management-Dashboard für Restic",
    version="1.1.0",
    lifespan=lifespan,
)

# Mount static frontend files
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# ─── Dashboard (serves index.html) ───────────────────────────────────────────

@app.get("/health")
async def health_check():
    """Public endpoint for Docker HEALTHCHECK."""
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
async def serve_dashboard(username: str = Depends(verify_credentials)):
    """Serve the main dashboard page."""
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        html = index_file.read_text(encoding="utf-8")
        # Inject build timestamp for cache-busting
        html = html.replace("__BORGGUARD_BUILD__", BUILD_TS)
        # Inject WebSocket authentication token
        ws_token = base64.b64encode(f"{config.DASHBOARD_USER}:{config.DASHBOARD_PASSWORD}".encode()).decode()
        html = html.replace("__BORGGUARD_WS_TOKEN__", ws_token)
        return HTMLResponse(content=html)
    return HTMLResponse(content="<h1>RestiGuard by JB – Frontend nicht gefunden</h1>", status_code=404)


# ─── Status / Overview ───────────────────────────────────────────────────────

@app.get("/api/status")
async def api_status(username: str = Depends(verify_credentials)):
    """Get overall backup and service status."""
    global STATUS_CACHE_TIME
    
    # Run blocking Docker API calls in a threadpool to prevent event loop stalls
    services = await asyncio.to_thread(get_service_summary)
    now = time()

    last_backup = None
    archive_count = 0
    repo_info = {}
    cached = False

    if job_manager.is_busy() or (now - STATUS_CACHE_TIME < STATUS_CACHE_TTL and job_manager.last_known_backup is not None):
        # Borg lock prevents listing, or we are in cache period – use cached values
        last_backup = job_manager.last_known_backup
        archive_count = job_manager.last_known_archive_count or 0
        repo_info = job_manager.last_known_repo_info or {}
        cached = True
    else:
        # Fetch fresh data
        archives_result = await list_snapshots()
        repo_result = await get_repo_info()

        if archives_result["success"] and archives_result.get("data"):
            archive_list = archives_result["data"]
            archive_count = len(archive_list)
            if archive_list:
                last_backup = archive_list[-1]
            # Update cache
            job_manager.last_known_backup = last_backup
            job_manager.last_known_archive_count = archive_count
            job_manager.last_known_archives = archive_list

        if repo_result["success"]:
            repo_info = repo_result.get("data", {})
            job_manager.last_known_repo_info = repo_info

        STATUS_CACHE_TIME = now

    current_job = None
    if job_manager.current_job:
        current_job = job_manager.current_job.to_dict()

    return {
        "status": "ok",
        "last_backup": last_backup,
        "last_backup_cached": cached,
        "archive_count": archive_count,
        "repository": repo_info,
        "services": services,
        "current_job": current_job,
        "recent_jobs": job_manager.history[:5],
    }


# ─── Archives ────────────────────────────────────────────────────────────────

@app.get("/api/archives")
async def api_archives(username: str = Depends(verify_credentials)):
    """List all archives with details."""
    global STATUS_CACHE_TIME
    now = time()
    
    if (job_manager.is_busy() or now - STATUS_CACHE_TIME < STATUS_CACHE_TTL) and job_manager.last_known_archives:
        return {
            "success": True,
            "archives": job_manager.last_known_archives,
            "error": None,
            "detailed": True,
            "cached": True,
        }

    info_result = await list_snapshots()
    data = info_result.get("data")

    if not info_result["success"] or not data:
        # Return what we got (no separate fallback function available)
        return {
            "success": info_result["success"],
            "archives": data or [],
            "error": info_result.get("stderr", ""),
            "detailed": False,
        }

    # Cache the detailed list
    if data:
        job_manager.last_known_archives = data

    return {
        "success": True,
        "archives": data,
        "error": None,
        "detailed": True,
    }



@app.get("/api/archives/{archive_name}/stats")
async def api_archive_stats(archive_name: str, username: str = Depends(verify_credentials)):
    """Get size stats for a specific archive (snapshot)."""
    # Import the new function dynamically or from restic_service
    from .restic_service import get_snapshot_stats
    result = await get_snapshot_stats(archive_name)
    if not result["success"]:
        return JSONResponse(status_code=500, content={"error": result.get("stderr", "Fehler beim Lesen der Statistiken")})
    return {"stats": result.get("data", {})}


# ─── Repository Info ─────────────────────────────────────────────────────────

@app.get("/api/repo-info")
async def api_repo_info(username: str = Depends(verify_credentials)):
    """Get repository storage information."""
    result = await get_repo_info()
    return {
        "success": result["success"],
        "data": result.get("data", {}),
        "error": result.get("stderr", "") if not result["success"] else None,
    }


# ─── Storage Overview & Repositories ──────────────────────────────────────────

@app.get("/api/storage/overview")
async def api_storage_overview(username: str = Depends(verify_credentials)):
    """Get detailed storage overview across all configured backup locations."""
    res = await get_storage_info()
    res["gdrive_url"] = config.GDRIVE_URL
    return res


class RepositoryCreate(BaseModel):
    path: str
    label: str
    name: str | None = None
    type: str = "local"  # 'gdrive', 'hetzner', 'ssh', 'local'
    limit_gb: float = 1000.0


class RepositoryUpdate(BaseModel):
    path: str
    label: str
    name: str | None = None
    type: str = "local"
    limit_gb: float = 1000.0


@app.get("/api/repositories")
async def api_get_repositories(username: str = Depends(verify_credentials)):
    """Get all configured backup locations."""
    return {"repositories": get_configured_repositories()}


@app.post("/api/repositories")
async def api_add_repository(body: RepositoryCreate, username: str = Depends(verify_credentials)):
    """Add a new backup location."""
    res = add_repository_to_config(
        path=body.path.strip(),
        label=body.label.strip(),
        name=body.name.strip() if body.name else body.label.strip(),
        repo_type=body.type,
        limit_gb=body.limit_gb,
    )
    if not res["success"]:
        return JSONResponse(status_code=400, content={"error": res["error"]})
    return res


@app.put("/api/repositories/{label}")
async def api_update_repository(label: str, body: RepositoryUpdate, username: str = Depends(verify_credentials)):
    """Update an existing backup location."""
    res = update_repository_in_config(
        original_label=label,
        path=body.path.strip(),
        label=body.label.strip(),
        name=body.name.strip() if body.name else body.label.strip(),
        repo_type=body.type,
        limit_gb=body.limit_gb,
    )
    if not res["success"]:
        return JSONResponse(status_code=400, content={"error": res["error"]})
    return res


@app.delete("/api/repositories/{label}")
async def api_delete_repository(label: str, username: str = Depends(verify_credentials)):
    """Delete a backup location."""
    res = remove_repository_from_config(label)
    if not res["success"]:
        return JSONResponse(status_code=400, content={"error": res["error"]})
    return res


# ─── Actions (trigger jobs) ──────────────────────────────────────────────────

@app.post("/api/backup/create")
async def api_create_backup(username: str = Depends(verify_credentials)):
    """Trigger a new backup (runs in background)."""
    if job_manager.is_busy():
        return JSONResponse(
            status_code=409,
            content={"error": "Ein Job läuft bereits", "current_job": job_manager.current_job.to_dict()},
        )

    async def _run():
        global STATUS_CACHE_TIME
        job = job_manager.current_job
        result = await create_backup(verbosity=1, job=job, job_manager=job_manager)
        if result.get("stdout") or result.get("stderr"):
            lines = (result.get("stdout", "") + "\n" + result.get("stderr", "")).splitlines()
            write_job_log("backup", lines)
        STATUS_CACHE_TIME = 0.0
        return result

    job = await job_manager.start_job(JobType.BACKUP, _run)
    return {"message": "Backup gestartet", "job": job.to_dict()}


@app.post("/api/backup/check")
async def api_check_integrity(username: str = Depends(verify_credentials)):
    """Run a repository integrity check (runs in background)."""
    if job_manager.is_busy():
        return JSONResponse(
            status_code=409,
            content={"error": "Ein Job läuft bereits", "current_job": job_manager.current_job.to_dict()},
        )

    async def _run():
        global STATUS_CACHE_TIME
        job = job_manager.current_job
        result = await check_integrity(job=job, job_manager=job_manager)
        if result.get("stdout") or result.get("stderr"):
            lines = (result.get("stdout", "") + "\n" + result.get("stderr", "")).splitlines()
            write_job_log("check", lines)
        STATUS_CACHE_TIME = 0.0
        return result

    job = await job_manager.start_job(JobType.CHECK, _run)
    return {"message": "Integritätsprüfung gestartet", "job": job.to_dict()}


@app.post("/api/backup/prune")
async def api_prune(username: str = Depends(verify_credentials)):
    """Prune old archives (runs in background)."""
    if job_manager.is_busy():
        return JSONResponse(
            status_code=409,
            content={"error": "Ein Job läuft bereits", "current_job": job_manager.current_job.to_dict()},
        )

    async def _run():
        global STATUS_CACHE_TIME
        job = job_manager.current_job
        result = await prune_repo(job=job, job_manager=job_manager)
        if result.get("stdout") or result.get("stderr"):
            lines = (result.get("stdout", "") + "\n" + result.get("stderr", "")).splitlines()
            write_job_log("prune", lines)
        STATUS_CACHE_TIME = 0.0
        return result

    job = await job_manager.start_job(JobType.PRUNE, _run)
    return {"message": "Bereinigung gestartet", "job": job.to_dict()}


@app.post("/api/backup/break-lock")
async def api_break_lock(username: str = Depends(verify_credentials)):
    """Break the repository lock."""
    if job_manager.is_busy():
        return JSONResponse(
            status_code=409,
            content={"error": "Ein Job läuft bereits", "current_job": job_manager.current_job.to_dict()},
        )

    result = await break_lock()
    if not result["success"]:
        return JSONResponse(
            status_code=500,
            content={"error": result.get("stderr", "Fehler beim Aufheben des Locks")},
        )
    return {"message": "Sperre erfolgreich aufgehoben"}


# ─── Jobs ─────────────────────────────────────────────────────────────────────

@app.get("/api/jobs")
async def api_jobs(username: str = Depends(verify_credentials)):
    """Get current and recent jobs."""
    current = None
    if job_manager.current_job:
        current = job_manager.current_job.to_dict()

    return {
        "current": current,
        "history": job_manager.history,
    }


@app.get("/api/jobs/current/progress")
async def api_current_job_progress(username: str = Depends(verify_credentials)):
    """Get the real-time progress of the currently running job."""
    if not job_manager.current_job:
        return {"active": False}

    job = job_manager.current_job
    return {
        "active": True,
        "job_id": job.id,
        "job_type": job.type.value,
        "status": job.status.value,
        "started_at": job.started_at,
        "progress_phase": job.progress_phase,
        "progress_detail": job.progress_detail,
        "progress_percent": job.progress_percent,
        "output_lines": job.output_lines[-30:],
    }


@app.get("/api/jobs/{job_id}/log")
async def api_job_log(job_id: str, username: str = Depends(verify_credentials)):
    """Get the log output of a specific job."""
    # Check current job
    if job_manager.current_job and job_manager.current_job.id == job_id:
        return {
            "job_id": job_id,
            "status": job_manager.current_job.status.value,
            "lines": job_manager.current_job.log_lines,
        }

    # Check history
    for job in job_manager._history:
        if job.id == job_id:
            return {
                "job_id": job_id,
                "status": job.status.value,
                "lines": job.log_lines,
            }

    return JSONResponse(status_code=404, content={"error": "Job nicht gefunden"})


# ─── Logs ─────────────────────────────────────────────────────────────────────

@app.get("/api/logs/system/borgmatic")
async def api_system_log(lines: int = 150, username: str = Depends(verify_credentials)):
    """Read recent BorgGuard logs."""
    log_text = await get_recent_logs_async(max_lines=lines)
    return {"source": "borgguard", "content": log_text.splitlines()}


@app.get("/api/logs")
async def api_logs(username: str = Depends(verify_credentials)):
    """List available log files."""
    return {"files": get_log_files()}


@app.get("/api/kiosk/config")
async def api_get_kiosk_config(username: str = Depends(verify_credentials)):
    """Read the Immich-Kiosk configuration file."""
    path = Path(config.IMMICH_KIOSK_CONFIG_PATH)
    if not path.exists():
        # Return a default skeleton instead of 404 so the user can create it
        default_content = """# Immich Kiosk Configuration
# Siehe: https://github.com/damongolding/immich-kiosk

immich_url: "http://dein-server:2283"
immich_api_key: "DEIN_API_KEY"

# Optional settings
# duration: 15
# show_image_date: true
"""
        return {"content": default_content, "path": str(path) + " (Wird neu erstellt)"}
    try:
        content = path.read_text(encoding="utf-8")
        return {"content": content, "path": str(path)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Fehler beim Lesen: {str(e)}"})


class KioskConfigUpdate(BaseModel):
    content: str


@app.post("/api/kiosk/config")
async def api_save_kiosk_config(body: KioskConfigUpdate, username: str = Depends(verify_credentials)):
    """Save the Immich-Kiosk configuration file and restart the container."""
    path = Path(config.IMMICH_KIOSK_CONFIG_PATH)
    try:
        # Create directory if it doesn't exist
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body.content, encoding="utf-8")
        
        # Restart the container asynchronously using the docker service
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, perform_container_action, "immich-kiosk", "restart")
        
        if not result["success"]:
            # If the container isn't found or couldn't be restarted, we still saved the file
            return {"message": "Gespeichert ✅, aber Neustart fehlgeschlagen: " + result.get("error", "")}
            
        return {"message": "Gespeichert & Container neugestartet ✅"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Fehler beim Speichern: {str(e)}"})


@app.get("/api/logs/{filename}")
async def api_log_content(filename: str, tail: int = 200, username: str = Depends(verify_credentials)):
    """Read a specific log file."""
    result = read_log_file(filename, tail=tail)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "Log-Datei nicht gefunden"})
    return result


# ─── Services (Docker) ───────────────────────────────────────────────────────

@app.get("/api/services")
async def api_services(username: str = Depends(verify_credentials)):
    """Get Docker container status."""
    containers, summary = await asyncio.gather(
        asyncio.to_thread(get_container_status),
        asyncio.to_thread(get_service_summary)
    )
    return {
        "containers": containers,
        "summary": summary,
    }


@app.post("/api/services/{container_name}/{action}")
async def api_service_action(container_name: str, action: str, username: str = Depends(verify_credentials)):
    """Perform action on a container (start, stop, restart)."""
    if action not in ["start", "stop", "restart"]:
        return JSONResponse(status_code=400, content={"error": "Ungültige Aktion"})
    
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, perform_container_action, container_name, action)
    
    if not result["success"]:
        return JSONResponse(status_code=500, content={"error": result.get("error", "Unbekannter Fehler")})
    return {"message": result.get("message", "Aktion erfolgreich")}


@app.post("/api/services/project/{project_name}/update")
async def api_project_update(project_name: str, username: str = Depends(verify_credentials)):
    """Update a docker compose project (pull and up -d)."""
    result = await update_compose_project(project_name)
    
    if not result["success"]:
        return JSONResponse(status_code=500, content={"error": result.get("error", "Unbekannter Fehler")})
    
    return {"message": result.get("message", "Aktion erfolgreich")}


# ─── Config ──────────────────────────────────────────────────────────────────

@app.get("/api/config")
async def api_config_show(username: str = Depends(verify_credentials)):
    """Show current borgmatic configuration (passwords masked)."""
    result = await get_config()
    return {
        "success": result["success"],
        "config": result.get("stdout", ""),
        "config_table": result.get("config_table", []),
        "error": result.get("stderr", "") if not result["success"] else None,
    }


@app.get("/api/schedule")
async def api_schedule(username: str = Depends(verify_credentials)):
    """Get estimated backup schedule based on archive history."""
    return await get_schedule_info()


# ─── Scheduler ───────────────────────────────────────────────────────────────

@app.get("/api/schedule/config")
async def api_schedule_config(username: str = Depends(verify_credentials)):
    """Get the current automatic backup schedule configuration."""
    return scheduler.get_config()


class ScheduleConfigUpdate(BaseModel):
    enabled: bool | None = None
    preset: str | None = None
    custom_cron: str | None = None
    use_custom: bool | None = None
    options: dict | None = None


@app.post("/api/schedule/config")
async def api_schedule_config_update(
    body: ScheduleConfigUpdate,
    username: str = Depends(verify_credentials),
):
    """Update the automatic backup schedule configuration."""
    return scheduler.set_config(body.model_dump(exclude_none=True))


@app.post("/api/schedule/enable")
async def api_schedule_enable(username: str = Depends(verify_credentials)):
    """Enable automatic scheduled backups."""
    return scheduler.enable()


@app.post("/api/schedule/disable")
async def api_schedule_disable(username: str = Depends(verify_credentials)):
    """Disable automatic scheduled backups."""
    return scheduler.disable()


# ─── WebSocket for live log streaming ────────────────────────────────────────

def _verify_ws_credentials(token: str) -> bool:
    """Verify Basic Auth credentials passed as a base64 token via query parameter."""
    try:
        decoded = base64.b64decode(token).decode("utf-8")
        username, _, password = decoded.partition(":")
        import secrets
        ok_user = secrets.compare_digest(username.encode(), config.DASHBOARD_USER.encode())
        ok_pass = secrets.compare_digest(password.encode(), config.DASHBOARD_PASSWORD.encode())
        return ok_user and ok_pass
    except Exception:
        return False


@app.websocket("/ws/logs")
async def websocket_logs(
    websocket: WebSocket,
    token: str = Query(default=""),
):
    """WebSocket endpoint for live job log streaming.

    Authentication: pass Basic Auth credentials as base64(user:password)
    via the `token` query parameter, e.g. /ws/logs?token=<base64>
    """
    if not _verify_ws_credentials(token):
        await websocket.close(code=1008)  # Policy Violation
        return

    await websocket.accept()
    queue = job_manager.subscribe()

    try:
        while True:
            message = await queue.get()
            await websocket.send_text(message)
    except WebSocketDisconnect:
        pass
    finally:
        job_manager.unsubscribe(queue)


# ─── Entry point ─────────────────────────────────────────────────────────────

def start():
    """Start the BorgGuard server."""
    import uvicorn
    uvicorn.run(
        "backend.main:app",
        host=config.HOST,
        port=config.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    start()
