"""BorgGuard – Docker Service

Queries Docker container status via the Docker SDK.
"""

import os
import subprocess
from typing import Optional

from . import config

try:
    import docker
    DOCKER_AVAILABLE = True
except ImportError:
    DOCKER_AVAILABLE = False

    class DummyNotFound(Exception):
        pass

    class DummyErrors:
        NotFound = DummyNotFound

    class DummyDocker:
        errors = DummyErrors

    docker = DummyDocker


def get_docker_client() -> Optional["docker.DockerClient"]:
    """Create a Docker client. Returns None if Docker is unavailable."""
    if not DOCKER_AVAILABLE:
        return None
    try:
        client = docker.from_env()
        client.ping()
        return client
    except Exception:
        return None


def get_container_status() -> list[dict]:
    """Get status of all monitored containers.

    Returns a list of dicts with keys: name, image, status, state, health, uptime
    """
    client = get_docker_client()
    if client is None:
        return [
            {
                "name": name,
                "image": "unknown",
                "status": "unknown",
                "state": "unknown",
                "health": "unknown",
                "uptime": "",
                "error": "Docker nicht erreichbar",
            }
            for name in config.MONITORED_CONTAINERS
        ]

    results = []
    try:
        containers = client.containers.list(all=True)
        # Sort containers alphabetically by name
        containers.sort(key=lambda c: c.name)
        
        for container in containers:
            # Skip the borgguard container itself to reduce noise
            if container.name == "borgguard":
                continue
                
            attrs = container.attrs
            state = attrs.get("State", {})
            health = state.get("Health", {}).get("Status", "none")
            image = attrs.get("Config", {}).get("Image", "unknown")
            labels = attrs.get("Config", {}).get("Labels", {})
            
            # Determine version
            version = "—"
            for label_key in ["org.opencontainers.image.version", "version", "immich.version", "nextcloud.version"]:
                if labels.get(label_key) and labels.get(label_key) != "release":
                    version = labels.get(label_key)
                    break
            
            if version == "—":
                tag = image.split(":")[-1] if ":" in image else ""
                if tag and tag not in ("latest", "release", "stable", "unknown"):
                    version = tag

            results.append({
                "name": container.name,
                "image": image,
                "version": version,
                "compose_project": labels.get("com.docker.compose.project", ""),
                "status": container.status,
                "state": state.get("Status", "unknown"),
                "health": health,
                "uptime": state.get("StartedAt", ""),
                "error": None,
            })
    except Exception as e:
        # Fallback if listing fails
        pass

    return results


def get_service_summary() -> dict:
    """Get a high-level summary of service status.

    Groups containers by service (immich, nextcloud) and returns overall health.
    Includes software versions.
    """
    containers = get_container_status()
    versions = get_service_versions()

    services = {}

    for c in containers:
        project_id = c.get("compose_project")
        
        if not project_id:
            # Fallback for manually started containers
            name_lower = c["name"].lower()
            if "immich" in name_lower:
                project_id = "immich"
            elif "next" in name_lower:
                project_id = "nextcloud"
            else:
                project_id = "other"

        if project_id not in services:
            # Format the name nicely for display
            display_name = project_id.capitalize()
            if project_id == "other":
                display_name = "Weitere"
                
            # If it's a known service, add the global version
            group_version = "—"
            if "immich" in project_id.lower() and versions.get("immich"):
                group_version = versions.get("immich")
            elif "nextcloud" in project_id.lower() and versions.get("nextcloud"):
                group_version = versions.get("nextcloud")

            services[project_id] = {
                "name": display_name,
                "project_id": c.get("compose_project") or None,
                "containers": [],
                "healthy": True,
                "version": group_version
            }

        services[project_id]["containers"].append(c)
        if c["state"] != "running":
            services[project_id]["healthy"] = False

    return services


# ─── Version Detection ────────────────────────────────────────────────────────

import json
import time

_version_cache: dict = {}  # cleared on container restart
_VERSION_CACHE_TTL = 300  # 5 minutes


def get_service_versions() -> dict:
    """Get software versions for Immich and Nextcloud.

    Uses Docker exec to query the running containers.
    Results are cached for 5 minutes to avoid overhead.
    """
    global _version_cache

    now = time.time()
    if _version_cache and (now - _version_cache.get("_ts", 0)) < _VERSION_CACHE_TTL:
        return _version_cache

    client = get_docker_client()
    if client is None:
        return {"immich": "—", "nextcloud": "—"}

    versions = {"_ts": now}

    # ── Nextcloud version ──
    versions["nextcloud"] = _get_nextcloud_version(client)

    # ── Immich version ──
    versions["immich"] = _get_immich_version(client)

    _version_cache = versions
    return versions


def _get_nextcloud_version(client) -> str:
    """Get Nextcloud version via 'php occ status'."""
    try:
        container = client.containers.get("nextcloud_app")
        result = container.exec_run(
            ["php", "occ", "status", "--output=json"],
            user="www-data",
        )
        if result.exit_code == 0:
            data = json.loads(result.output.decode("utf-8", errors="replace"))
            return data.get("versionstring", data.get("version", "unbekannt"))
    except Exception:
        pass

    # Fallback: try image tag
    try:
        container = client.containers.get("nextcloud_app")
        image = container.attrs.get("Config", {}).get("Image", "")
        tag = image.split(":")[-1] if ":" in image else ""
        if tag and tag != "latest":
            return tag
    except Exception:
        pass

    return "unbekannt"


def _get_immich_version(client) -> str:
    """Get Immich version via API, env vars, image labels, or build info.

    Immich's default image tag is 'release' which isn't informative,
    so we try multiple strategies to find the actual semver version.
    """
    try:
        container = client.containers.get("immich_server")

        # Method 1: Check IMMICH_VERSION or IMMICH_BUILD env vars
        env_list = container.attrs.get("Config", {}).get("Env", [])
        for env in env_list:
            key, _, val = env.partition("=")
            val = val.strip()
            if key in ("IMMICH_VERSION", "IMMICH_BUILD_VERSION") and val and val != "release":
                return val

        # Method 2: Try the Immich API (no auth needed for /api/server/about and /api/server/version)
        # Immich listens on port 2283 (default) or 3001 (older versions)
        for port in [2283, 3001]:
            # Try /api/server/about first (returns {"version": "v1.134.0", ...})
            for cmd_tool in [["curl", "-sf", "--max-time", "3"], ["wget", "-qO-", "--timeout=3"]]:
                try:
                    result = container.exec_run(cmd_tool + [f"http://localhost:{port}/api/server/about"])
                    if result.exit_code == 0:
                        output = result.output.decode("utf-8", errors="replace").strip()
                        data = json.loads(output)
                        version = data.get("version", "")
                        if version and version != "release":
                            return version
                except Exception:
                    continue

            # Try /api/server/version (returns {"major": 1, "minor": 134, "patch": 0})
            for cmd_tool in [["curl", "-sf", "--max-time", "3"], ["wget", "-qO-", "--timeout=3"]]:
                try:
                    result = container.exec_run(cmd_tool + [f"http://localhost:{port}/api/server/version"])
                    if result.exit_code == 0:
                        output = result.output.decode("utf-8", errors="replace").strip()
                        data = json.loads(output)
                        major = data.get("major", "")
                        minor = data.get("minor", "")
                        patch = data.get("patch", "")
                        if major != "":
                            return f"v{major}.{minor}.{patch}"
                except Exception:
                    continue

        # Method 3: Try reading build version file
        for path in ["/build_version.txt", "/app/build_version.txt"]:
            try:
                result = container.exec_run(["cat", path])
                if result.exit_code == 0:
                    version = result.output.decode("utf-8", errors="replace").strip()
                    if version and version != "release":
                        return version
            except Exception:
                continue

        # Method 4: Check Docker image labels
        try:
            labels = container.attrs.get("Config", {}).get("Labels", {})
            for label_key in ["org.opencontainers.image.version", "version", "immich.version"]:
                val = labels.get(label_key, "")
                if val and val != "release":
                    return val
        except Exception:
            pass

        # Method 5: Parse version from image RepoDigests or RepoTags
        try:
            image_obj = container.image
            # Check RepoTags first (e.g. "ghcr.io/immich-app/immich-server:v1.134.0")
            for tag in (image_obj.tags or []):
                parts = tag.rsplit(":", 1)
                if len(parts) == 2:
                    tag_val = parts[1]
                    if tag_val and tag_val != "release" and tag_val != "latest":
                        return tag_val
        except Exception:
            pass

    except Exception:
        pass

    # Fallback: image tag from Config
    try:
        container = client.containers.get("immich_server")
        image = container.attrs.get("Config", {}).get("Image", "")
        tag = image.split(":")[-1] if ":" in image else ""
        if tag and tag not in ("release", "latest"):
            return tag
    except Exception:
        pass

    return "unbekannt"


# ─── Container Control ────────────────────────────────────────────────────────

def perform_container_action(container_name: str, action: str) -> dict:
    """Perform start/stop/restart action on a container."""
    client = get_docker_client()
    if client is None:
        return {"success": False, "error": "Docker nicht erreichbar"}
        
    try:
        container = client.containers.get(container_name)
        if action == "start":
            container.start()
        elif action == "stop":
            container.stop()
        elif action == "restart":
            container.restart()
        else:
            return {"success": False, "error": f"Unbekannte Aktion: {action}"}
            
        return {"success": True, "message": f"Aktion '{action}' für Container {container_name} ausgeführt"}
    except docker.errors.NotFound:
        return {"success": False, "error": f"Container '{container_name}' nicht gefunden"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def update_compose_project(project_name: str) -> dict:
    """Finds a compose project by name, looks for its config file, and runs docker compose pull & up."""
    client = get_docker_client()
    if client is None:
        return {"success": False, "error": "Docker nicht erreichbar"}
        
    try:
        # Find any container belonging to this project to get the working_dir and config_files
        containers = client.containers.list(all=True, filters={"label": f"com.docker.compose.project={project_name}"})
        if not containers:
            return {"success": False, "error": f"Kein Container für Projekt '{project_name}' gefunden"}
            
        container = containers[0]
        config_files_str = container.labels.get("com.docker.compose.project.config_files", "")
        working_dir = container.labels.get("com.docker.compose.project.working_dir", "")
        
        if not config_files_str:
            return {"success": False, "error": f"Projekt '{project_name}' hat keine Compose-Konfigurationsdatei im Label hinterlegt."}
            
        # The label might contain multiple files separated by commas, we just take the first one
        config_file = config_files_str.split(",")[0].strip()
        
        if not os.path.isabs(config_file) and working_dir:
            config_file = os.path.join(working_dir, config_file)
            
        if not os.path.exists(config_file):
            return {
                "success": False, 
                "error": f"Zugriff verweigert oder Datei nicht gefunden: {config_file}. Stelle sicher, dass der Ordner gemountet ist."
            }
            
        from .job_manager import job_manager, JobType
        import asyncio

        async def _run_update():
            job = job_manager.current_job
            await job_manager.add_job_output(job, f"=== Update für Projekt '{project_name}' gestartet ===")
            await job_manager.add_job_output(job, f"> docker compose -f {config_file} pull")
            
            pull_process = await asyncio.create_subprocess_exec(
                "docker", "compose", "-f", config_file, "pull",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT
            )
            while True:
                line = await pull_process.stdout.readline()
                if not line:
                    break
                await job_manager.add_job_output(job, line.decode().rstrip('\r\n'))
                
            await pull_process.wait()
            
            if pull_process.returncode != 0:
                await job_manager.add_job_output(job, "❌ Update fehlgeschlagen beim Pull")
                raise RuntimeError("Pull failed")
                
            await job_manager.add_job_output(job, f"> docker compose -f {config_file} up -d")
            up_process = await asyncio.create_subprocess_exec(
                "docker", "compose", "-f", config_file, "up", "-d",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT
            )
            while True:
                line = await up_process.stdout.readline()
                if not line:
                    break
                await job_manager.add_job_output(job, line.decode().rstrip('\r\n'))
                
            await up_process.wait()
            
            if up_process.returncode != 0:
                await job_manager.add_job_output(job, "❌ Update fehlgeschlagen beim Starten")
                raise RuntimeError("Up failed")
                
            await job_manager.add_job_output(job, "✅ Update erfolgreich abgeschlossen")
            return {"success": True, "duration_seconds": 0}

        job = await job_manager.start_job(JobType.OTHER, _run_update)
        if not job:
            return {"success": False, "error": "Ein anderer Job läuft bereits."}
            
        return {"success": True, "message": f"Update für Projekt '{project_name}' gestartet."}
        
    except Exception as e:
        return {"success": False, "error": str(e)}
