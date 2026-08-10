# Server Deployment & Synchronization

When copying data between the local Windows workstation and the Linux server for this project, always use the following details:

- **Server IP:** `192.168.2.113`
- **SSH Username:** `jb`
- **Remote Project Directory:** `/home/jb/borgguard/`
- **Local Project Directory:** `d:\antigrav\borgguard\`

## Commands
**Deploy to server and restart Docker (PowerShell All-in-One):**
```powershell
scp -r d:\antigrav\borgguard\* jb@192.168.2.113:/home/jb/borgguard/ ; ssh jb@192.168.2.113 "cd /home/jb/borgguard && docker compose build --no-cache && docker compose up -d"
```
