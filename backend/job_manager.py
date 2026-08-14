"""BorgGuard – Background Job Manager

Manages long-running borgmatic operations as background tasks.
Only one job can run at a time (borgmatic locks the repository anyway).
"""

import asyncio
import json
from datetime import datetime
from enum import Enum
from typing import Optional
from dataclasses import dataclass, field


class JobType(str, Enum):
    BACKUP = "backup"
    CHECK = "check"
    PRUNE = "prune"
    COMPACT = "compact"
    RESTORE = "restore"
    DR_TEST = "dr_test"
    OTHER = "other"


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Job:
    id: str
    type: JobType
    status: JobStatus = JobStatus.PENDING
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    result: Optional[dict] = None
    log_lines: list[str] = field(default_factory=list)
    # Progress tracking
    progress_phase: str = ""
    progress_detail: str = ""
    progress_percent: int = -1  # -1 = indeterminate
    output_lines: list[str] = field(default_factory=list)
    _max_output_lines: int = field(default=80, repr=False)

    def add_output_line(self, line: str):
        """Add a line of output and keep the buffer bounded."""
        self.log_lines.append(line)
        self.output_lines.append(line)
        if len(self.output_lines) > self._max_output_lines:
            self.output_lines = self.output_lines[-self._max_output_lines:]

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type.value,
            "status": self.status.value,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "result": {
                "success": self.result.get("success"),
                "exit_code": self.result.get("exit_code"),
                "duration_seconds": self.result.get("duration_seconds"),
                "stderr": self.result.get("stderr", "")[-500:] if self.result else "",
            } if self.result else None,
            "log_lines_count": len(self.log_lines),
            "progress_phase": self.progress_phase,
            "progress_detail": self.progress_detail,
            "progress_percent": self.progress_percent,
        }


class JobManager:
    """Manages background borgmatic jobs. Thread-safe via asyncio lock."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self._current_job: Optional[Job] = None
        self._current_task: Optional[asyncio.Task] = None
        self._current_process: Optional[asyncio.subprocess.Process] = None
        self._history: list[Job] = []
        self._max_history = 50
        self._job_counter = 0
        # Subscribers for live log updates (WebSocket)
        self._subscribers: list[asyncio.Queue] = []
        # Cache for last known archive data (survives borg-lock situations)
        self._last_known_backup: Optional[dict] = None
        self._last_known_archive_count: Optional[int] = None
        self._last_known_archives: list[dict] = []
        self._last_known_repo_info: Optional[dict] = None

    def register_process(self, proc):
        """Register the currently active subprocess for cancellation."""
        self._current_process = proc

    def unregister_process(self, proc):
        """Unregister subprocess when completed."""
        if self._current_process == proc:
            self._current_process = None

    async def cancel_current_job(self) -> bool:
        """Cancel the currently running job and kill active subprocesses."""
        if not self.is_busy():
            return False

        job = self._current_job
        if job:
            await self.add_job_output(job, "⚠️ Vorgang wird durch Benutzer abgebrochen…")
            await self.update_progress(job, phase="Wird abgebrochen…", percent=-1)

        # 1. Kill active subprocess
        if self._current_process:
            try:
                self._current_process.terminate()
                for _ in range(6):
                    if self._current_process.returncode is not None:
                        break
                    await asyncio.sleep(0.3)
                if self._current_process.returncode is None:
                    self._current_process.kill()
            except Exception:
                pass
            self._current_process = None

        # 2. Cancel running task
        if self._current_task and not self._current_task.done():
            self._current_task.cancel()

        # Clean DR test sandboxes
        try:
            from .restic_service import clean_all_dr_sandboxes
            clean_all_dr_sandboxes()
        except Exception:
            pass

        return True

    @property
    def current_job(self) -> Optional[Job]:
        return self._current_job

    @property
    def history(self) -> list[dict]:
        return [job.to_dict() for job in reversed(self._history)]

    @property
    def last_known_backup(self) -> Optional[dict]:
        return self._last_known_backup

    @last_known_backup.setter
    def last_known_backup(self, value: Optional[dict]):
        self._last_known_backup = value

    @property
    def last_known_archive_count(self) -> Optional[int]:
        return self._last_known_archive_count

    @last_known_archive_count.setter
    def last_known_archive_count(self, value: Optional[int]):
        self._last_known_archive_count = value

    @property
    def last_known_archives(self) -> list[dict]:
        return self._last_known_archives

    @last_known_archives.setter
    def last_known_archives(self, value: list[dict]):
        self._last_known_archives = value

    @property
    def last_known_repo_info(self) -> Optional[dict]:
        return self._last_known_repo_info

    @last_known_repo_info.setter
    def last_known_repo_info(self, value: Optional[dict]):
        self._last_known_repo_info = value

    def is_busy(self) -> bool:
        return self._current_job is not None and self._current_job.status == JobStatus.RUNNING

    async def start_job(self, job_type: JobType, coro_factory) -> Optional[Job]:
        """Start a new background job.

        Args:
            job_type: Type of job to run
            coro_factory: An async callable that performs the actual work

        Returns:
            The created Job, or None if another job is already running.
        """
        if self.is_busy():
            return None

        self._job_counter += 1
        job_id = f"{job_type.value}-{self._job_counter}-{datetime.now().strftime('%H%M%S')}"
        job = Job(id=job_id, type=job_type)

        self._current_job = job
        self._current_task = asyncio.create_task(self._run_job(job, coro_factory))
        return job

    async def update_progress(self, job: Job, phase: str = "", detail: str = "", percent: int = -1):
        """Update progress state and broadcast to subscribers."""
        if phase:
            job.progress_phase = phase
        if detail:
            job.progress_detail = detail
        if percent >= 0:
            job.progress_percent = percent

        await self._broadcast_json({
            "type": "progress",
            "job_id": job.id,
            "job_type": job.type.value,
            "phase": job.progress_phase,
            "detail": job.progress_detail,
            "percent": job.progress_percent,
        })

    async def add_job_output(self, job: Job, line: str):
        """Add an output line with timestamp to the job and broadcast it."""
        timestamp = datetime.now().strftime("[%Y-%m-%d %H:%M:%S]")
        if not (line.startswith("[") and len(line) > 10 and line[1:5].isdigit()):
            formatted_line = f"{timestamp} {line}"
        else:
            formatted_line = line

        job.add_output_line(formatted_line)
        await self._broadcast_json({
            "type": "log",
            "job_id": job.id,
            "line": formatted_line,
        })

    async def _run_job(self, job: Job, coro_factory):
        """Execute the job and update its status."""
        from .ntfy_service import notify_job_started, notify_job_completed, notify_job_failed
        from .log_service import write_job_log

        job.status = JobStatus.RUNNING
        job.started_at = datetime.now().isoformat()
        job.progress_phase = "Wird gestartet…"

        type_labels = {
            JobType.BACKUP: "Backup",
            JobType.CHECK: "Integritätsprüfung",
            JobType.PRUNE: "Bereinigung",
            JobType.COMPACT: "Komprimierung",
            JobType.RESTORE: "Wiederherstellung",
            JobType.DR_TEST: "DR-Restore Test",
            JobType.OTHER: "System-Update",
        }
        label = type_labels.get(job.type, job.type.value)

        await self._broadcast_json({
            "type": "status",
            "job_id": job.id,
            "job_type": job.type.value,
            "status": "running",
            "started_at": job.started_at,
        })

        await self.add_job_output(job, f"=== Job {job.id} ({label}) gestartet ===")

        # Send ntfy notification (fire-and-forget, errors are logged but don't block)
        asyncio.create_task(notify_job_started(job.type.value, job.id))

        try:
            result = await coro_factory()
            job.result = result
            job.status = JobStatus.COMPLETED if result.get("success") else JobStatus.FAILED
        except asyncio.CancelledError:
            job.result = {"success": False, "exit_code": 130, "stderr": "Vorgang durch Benutzer abgebrochen", "duration_seconds": 0}
            job.status = JobStatus.FAILED
            await self.add_job_output(job, f"=== Job {job.id} ({label}) durch Benutzer abgebrochen ===")
        except Exception as e:
            job.result = {"success": False, "exit_code": -1, "stderr": str(e), "duration_seconds": 0}
            job.status = JobStatus.FAILED

        job.completed_at = datetime.now().isoformat()
        job.progress_phase = "Abgeschlossen" if job.status == JobStatus.COMPLETED else ("Abgebrochen" if "abgebrochen" in str(job.result.get("stderr", "")) else "Fehlgeschlagen")
        job.progress_percent = 100 if job.status == JobStatus.COMPLETED else -1

        status_text = "erfolgreich abgeschlossen" if job.status == JobStatus.COMPLETED else ("abgebrochen" if "abgebrochen" in str(job.result.get("stderr", "")) else "fehlgeschlagen")
        await self.add_job_output(job, f"=== Job {job.id} ({label}) {status_text} ===")

        await self._broadcast_json({
            "type": "status",
            "job_id": job.id,
            "job_type": job.type.value,
            "status": job.status.value,
            "completed_at": job.completed_at,
            "success": job.status == JobStatus.COMPLETED,
        })

        # Send ntfy completion notification
        duration = job.result.get("duration_seconds", 0) if job.result else 0
        if job.status == JobStatus.COMPLETED:
            asyncio.create_task(notify_job_completed(job.type.value, job.id, duration))
        else:
            error_msg = job.result.get("stderr", "") if job.result else ""
            asyncio.create_task(notify_job_failed(job.type.value, job.id, error_msg))

        # Store stdout/stderr lines in job log if not streamed
        if not job.log_lines:
            if job.result and job.result.get("stdout"):
                job.log_lines.extend(job.result["stdout"].splitlines())
            if job.result and job.result.get("stderr"):
                job.log_lines.extend([f"STDERR: {line}" for line in job.result["stderr"].splitlines()])

        # Save job log to disk so it shows up in log history
        if job.log_lines:
            write_job_log(job.id, job.log_lines)

        # Move to history
        self._history.append(job)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]
        self._current_job = None

    # --- WebSocket subscribers ---

    def subscribe(self) -> asyncio.Queue:
        """Create a new subscriber queue for live updates."""
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        """Remove a subscriber queue."""
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    async def _broadcast_json(self, data: dict):
        """Send a JSON message to all subscribers."""
        message = json.dumps(data, ensure_ascii=False)
        dead = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                dead.append(queue)
        for q in dead:
            self._subscribers.remove(q)

    async def _broadcast(self, message: str):
        """Send a plain-text message to all subscribers (legacy compat)."""
        await self._broadcast_json({
            "type": "log",
            "job_id": self._current_job.id if self._current_job else "",
            "line": message,
        })


# Global singleton
job_manager = JobManager()
