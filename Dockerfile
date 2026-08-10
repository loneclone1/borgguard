FROM python:3.12-slim

LABEL maintainer="BorgGuard by JB"
LABEL description="BorgGuard by JB – Restic Backup Management Dashboard"

# Install restic, Docker CLI, and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    restic \
    openssh-client \
    docker.io \
    docker-cli \
    curl \
    rclone \
    && rm -rf /var/lib/apt/lists/*

# Install Docker Compose Plugin
RUN mkdir -p /usr/libexec/docker/cli-plugins/ \
    && curl -SL "https://github.com/docker/compose/releases/download/v2.29.1/docker-compose-linux-x86_64" -o /usr/libexec/docker/cli-plugins/docker-compose \
    && chmod +x /usr/libexec/docker/cli-plugins/docker-compose

# Working directory
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create log directory
RUN mkdir -p /app/logs

# Expose port
EXPOSE 8443

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8443/health || exit 1

# Run the application
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8443"]
