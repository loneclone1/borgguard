# 🛡️ RestiGuard by JB – Restic Backup Management Dashboard

Ein modernes Web-Dashboard zur Überwachung und Steuerung von Borg-Backups über borgmatic mit automatischer Synchronisation zu Google Drive (via `rclone`).

## Features

- 📊 **Dashboard** – Status aller Backups auf einen Blick
- ▶️ **Backup erstellen** – Manuell per Button auslösen
- 🔍 **Integritätsprüfung** – Borg `check` direkt aus dem Browser
- 🧹 **Archive bereinigen** – Alte Snapshots gemäß Retention-Policy entfernen
- 📋 **Archiv-Übersicht** – Liste aller Borg-Archive mit Größe und Datum
- 📂 **Archiv-Browser** – Den Dateiinhalt der erstellten Archive direkt im Browser einsehen
- ☁️ **Google Drive Sync** – Automatischer Abgleich der Borg-Archive mit Google Drive via `rclone`
- 💾 **Speicherverbrauch** – Deduplizierung und Platzersparnis im Blick
- 🐳 **Docker-Status & Steuerung** – Immich & Nextcloud überwachen sowie direkt bedienen (Start/Stop/Neustart)
- ⚙️ **Konfiguration** – Aktuelle Borgmatic-Konfiguration und Sicherungsintervalle anzeigen
- 📜 **Log-Viewer** – Job-Logs live verfolgen
- 🔔 **Benachrichtigungen** – Push-Notifications via ntfy bei Erfolg/Fehler
- 🔐 **Authentifizierung** – HTTP Basic Auth für sicheren Zugriff

## Voraussetzungen

- Debian 13 Server mit Docker & Docker Compose
- borgmatic & borgbackup installiert und konfiguriert
- rclone mit eingerichtetem Google Drive Remote (`gdrive:`)
- Docker-Containers: Immich, Nextcloud (für Status-Monitoring)

## Installation & Konfiguration

### 1. rclone für Google Drive auf dem Server einrichten

Erstelle auf deinem Host-Server einen Remote-Eintrag für Google Drive:

```bash
rclone config
# Erstelle ein neues Remote mit dem Namen 'gdrive' für Google Drive
```

### 2. Borgmatic-Konfiguration aktualisieren

Kopiere die Vorlage `gdrive.yaml`:

```bash
sudo cp borgmatic/gdrive.yaml /etc/borgmatic/d/gdrive.yaml
```

⚠️ **Wichtig**: Setze dein Verschlüsselungspasswort in der neuen Config-Datei:
```bash
sudo nano /etc/borgmatic/d/gdrive.yaml
# encryption_passphrase: "DEIN_PASSWORT"
```

Validiere die Konfiguration:
```bash
sudo borgmatic config validate -c /etc/borgmatic/d/gdrive.yaml
```

### 3. Dashboard-Passwort in `.env` setzen

Kopiere die Vorlage `.env.example` zu `.env` und passe dort deine Zugangsdaten und dein Restic-Passwort an:

```bash
cp .env.example .env
nano .env
```

Die `.env` Datei enthält:
```env
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=dein_sicheres_passwort
RESTIC_PASSWORD=dein_restic_passwort
```
### 4. Docker-Container starten

```bash
docker compose up -d --build
```

### 5. Dashboard aufrufen

Öffne im Browser:

```
http://<server-ip>:8443
```

Melde dich mit den konfigurierten Zugangsdaten an.

## Sicherungsorte (Multi-Repository)

BorgGuard unterstützt beliebig viele parallele Sicherungsorte. Ein Backup-Lauf (`borgmatic create`) sichert deine Daten automatisch lokal und synchronisiert sie nach Google Drive.

### Hinzufügen über das Dashboard (UI)

1. Klicke im BorgGuard Dashboard auf die Statuskarte **"Sicherungsorte"**.
2. Klicke oben rechts im Modal auf **"➕ Sicherungsort hinzufügen"**.
3. Wähle den Typ aus (z.B. **☁️ Google Drive (rclone / Local Sync)**).
4. Vergebe eine Bezeichnung, ein Label (z.B. `gdrive-backup`) und ein Speicher-Limit in GB.
5. Klicke auf **"Sicherungsort speichern"**.

## Umgebungsvariablen

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `DASHBOARD_USER` | `admin` | Benutzername für das Dashboard |
| `DASHBOARD_PASSWORD` | `borgguard` | Passwort für das Dashboard |
| `BORGMATIC_CONFIG` | `/etc/borgmatic/d/gdrive.yaml` | Pfad zur borgmatic-Config |
| `PORT` | `8443` | Port des Dashboards |
| `NTFY_ENABLED` | `true` | Push-Benachrichtigungen aktivieren (`true`/`false`) |
| `NTFY_URL` | `https://ntfy.sh` | ntfy-Server-URL |
| `NTFY_TOPIC` | `borgguard-backup` | ntfy-Topic für Benachrichtigungen |

## Architektur

```
┌─────────────────────────────────────────────────────┐
│  Browser (PC / Handy)                               │
│  http://<server-ip>:8443                            │
└────────────────┬────────────────────────────────────┘
                 │ HTTP / WebSocket
┌────────────────▼────────────────────────────────────┐
│  Server (BorgGuard Container)                       │
│                                                     │
│  ┌──────────────────────────────────┐               │
│  │  Docker: borgguard               │               │
│  │  ├── FastAPI Backend             │               │
│  │  ├── borgmatic CLI (Local Repo)  │               │
│  │  └── rclone sync ────────────────┼───────────────┼──▶ Google Drive (Cloud)
│  └──────────────────────────────────┘               │
│                                                     │
│  ┌──────────────┐  ┌───────────────┐               │
│  │  Immich       │  │  Nextcloud    │               │
│  │  (Docker)     │  │  (Docker)     │               │
│  └──────────────┘  └───────────────┘               │
└─────────────────────────────────────────────────────┘
```

## Fehlerbehebung

### Borgmatic & rclone manuell im Container testen

```bash
# rclone Verbindung zu Google Drive testen
docker exec borgguard rclone lsd gdrive:

# Borgmatic manuell testen
docker exec borgguard borgmatic list -c /etc/borgmatic/d/gdrive.yaml
```

## Lizenz

MIT
