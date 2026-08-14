// frontend/js/app.js

const BorgGuard = {
    // Cache for last known backup (survives borg-lock situations)
    _lastBackupCache: null,
    _archiveCountCache: null,
    _wsOutputLines: [],
    _progressPollTimer: null,

    async init() {
        this.refresh();
        setInterval(() => this.refresh(), 30000); // 30s auto refresh
        this.startLogStream();
    },
    
    async refresh() {
        const btn = document.getElementById('refresh-btn');
        if (btn) btn.classList.add('loading');
        
        try {
            const status = await api.getStatus();
            if (status.status === 'ok') {

                
                // Fetch storage overview for Google Drive storage card
                try {
                    const storageOverview = await api.getStorageOverview();
                    if (storageOverview) {
                        if (storageOverview.gdrive_url) {
                            this._gdriveUrl = storageOverview.gdrive_url;
                        }
                        const el = document.getElementById('storage-size');
                        const detailEl = document.getElementById('storage-detail');
                        const usedBytes = storageOverview.total_used_bytes !== undefined ? storageOverview.total_used_bytes : storageOverview.used_bytes;
                        if (usedBytes !== undefined && usedBytes > 0) {
                            const usedGB = (usedBytes / 1024 / 1024 / 1024).toFixed(1);
                            const totalLimitGB = storageOverview.total_limit_gb || storageOverview.limit_gb || 1000;
                            const pct = storageOverview.total_used_percent !== undefined ? storageOverview.total_used_percent : storageOverview.used_percent;
                            if (el) el.innerText = `${usedGB} GB`;
                            if (detailEl) detailEl.innerText = `${pct}% belegt · Google Drive ↗`;
                        } else {
                            if (el) el.innerText = `Google Drive`;
                            if (detailEl) detailEl.innerText = `In Google Drive öffnen ↗`;
                        }
                    }
                } catch (e) { /* fallback */ }
                
                if (status.archive_count !== undefined) {
                    if (status.archive_count === null) {
                        document.getElementById('archive-count').innerHTML = '<div class="spinner" style="width:20px;height:20px;margin:auto;"></div>';
                    } else {
                        document.getElementById('archive-count').innerHTML = status.archive_count > 0 ? status.archive_count : '<span class="text-gray-400">Keine Snapshots</span>';
                        this._archiveCountCache = status.archive_count;
                    }
                }
                
                // ─── Last Backup display (with cache fix) ───
                const lastEl = document.getElementById('last-backup-time');
                const lastBackupDetailEl = document.getElementById('last-backup-detail');

                if (status.last_backup && status.last_backup.start) {
                    // Update cache
                    this._lastBackupCache = status.last_backup;
                    
                    const diff = Math.floor((new Date() - new Date(status.last_backup.start)) / 1000 / 60 / 60);
                    let diffStr = diff < 1 ? 'Kürzlich' : (diff < 24 ? `Vor ${diff} Stunden` : `Vor ${Math.floor(diff/24)} Tagen`);
                    if (lastEl) lastEl.innerText = diffStr;
                    
                    if (lastBackupDetailEl) {
                        if (status.last_backup_cached) {
                            lastBackupDetailEl.innerText = '(gecacht – Backup läuft)';
                        } else {
                            lastBackupDetailEl.innerText = new Date(status.last_backup.start).toLocaleString('de-DE');
                        }
                    }
                } else if (status.current_job) {
                    // A job is running and we can't read archives – use cache or show "Backup läuft"
                    if (this._lastBackupCache && this._lastBackupCache.start) {
                        const diff = Math.floor((new Date() - new Date(this._lastBackupCache.start)) / 1000 / 60 / 60);
                        let diffStr = diff < 1 ? 'Kürzlich' : (diff < 24 ? `Vor ${diff}h` : `Vor ${Math.floor(diff/24)}d`);
                        if (lastEl) lastEl.innerText = diffStr;
                        if (lastBackupDetailEl) lastBackupDetailEl.innerText = 'Backup läuft…';
                    } else {
                        if (lastEl) lastEl.innerText = 'Backup läuft…';
                        if (lastBackupDetailEl) lastBackupDetailEl.innerText = 'Erster Durchlauf';
                    }
                } else if (status.last_backup === null && !status.current_job) {
                    if (this._lastBackupCache && this._lastBackupCache.start) {
                        const diff = Math.floor((new Date() - new Date(this._lastBackupCache.start)) / 1000 / 60 / 60);
                        let diffStr = diff < 1 ? 'Kürzlich' : (diff < 24 ? `Vor ${diff}h` : `Vor ${Math.floor(diff/24)}d`);
                        if (lastEl) lastEl.innerText = diffStr;
                        if (lastBackupDetailEl) lastBackupDetailEl.innerText = new Date(this._lastBackupCache.start).toLocaleString('de-DE');
                    } else if (status.archive_count === null) {
                        if (lastEl) lastEl.innerHTML = '<div class="spinner" style="width:20px;height:20px;margin:auto;"></div>';
                        if (lastBackupDetailEl) lastBackupDetailEl.innerText = 'Daten werden geladen…';
                    } else {
                        if (lastEl) lastEl.innerText = 'Nie';
                        if (lastBackupDetailEl) lastBackupDetailEl.innerText = 'Noch kein Backup erstellt';
                    }
                }

                // ─── Current Job → Progress Panel ───
                if (status.current_job) {
                    UI.renderProgress({
                        active: true,
                        job_type: status.current_job.type,
                        phase: status.current_job.progress_phase,
                        detail: status.current_job.progress_detail,
                        percent: status.current_job.progress_percent,
                        output_lines: this._wsOutputLines,
                    });
                    this._startProgressPoll();
                } else {
                    UI.hideProgress();
                    this._stopProgressPoll();
                }
                
                if (status.services) {
                    UI.renderServices(status.services);
                }
                
                if (status.system_info) {
                    UI.renderServerOverview(status.system_info);
                }
                
                const d = new Date();
                const updateEl = document.getElementById('last-update');
                if(updateEl) updateEl.innerText = `Letztes Update: ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
            }

            const logs = await api.getLogs('system');
            if (logs.content) {
                UI.renderLogs(logs.content, 'log-system');
            }
            
        } catch (e) {
            UI.showToast('Fehler beim Aktualisieren: ' + e.message, 'error');
        } finally {
            if (btn) btn.classList.remove('loading');
        }
    },

    // ─── Progress Polling (fallback for when WebSocket misses updates) ───

    _startProgressPoll() {
        if (this._progressPollTimer) return;
        this._progressPollTimer = setInterval(async () => {
            try {
                const progress = await api.getCurrentProgress();
                if (progress.active) {
                    UI.renderProgress({
                        active: true,
                        job_type: progress.job_type,
                        phase: progress.progress_phase,
                        detail: progress.progress_detail,
                        percent: progress.progress_percent,
                        output_lines: progress.output_lines || this._wsOutputLines,
                    });
                } else {
                    UI.hideProgress();
                    this._stopProgressPoll();
                    // Job finished – refresh data
                    setTimeout(() => this.refresh(), 1000);
                }
            } catch (e) { /* ignore polling errors */ }
        }, 3000);
    },

    _stopProgressPoll() {
        if (this._progressPollTimer) {
            clearInterval(this._progressPollTimer);
            this._progressPollTimer = null;
        }
    },

    
    // ─── WebSocket ───────────────────────────────────────────────────────

    startLogStream() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Build auth token from stored credentials (Basic Auth is sent by browser automatically
        // for page loads, but WebSocket needs it as a query param since browsers don't support
        // custom headers for WebSocket connections).
        let wsUrl = `${wsProtocol}//${window.location.host}/ws/logs`;
        try {
            // First check if BORGGUARD_WS_TOKEN is defined as a global variable
            let token = null;
            if (typeof BORGGUARD_WS_TOKEN !== 'undefined' && BORGGUARD_WS_TOKEN && BORGGUARD_WS_TOKEN !== '__BORGGUARD_WS_TOKEN__') {
                token = BORGGUARD_WS_TOKEN;
            } else {
                token = sessionStorage.getItem('borgguard_ws_token');
            }
            if (token) {
                wsUrl += `?token=${encodeURIComponent(token)}`;
            }
        } catch (e) { /* sessionStorage or window access error */ }

        const ws = new WebSocket(wsUrl);
        const logContent = [];

        ws.onmessage = (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch (e) {
                // Legacy plain-text format
                data = { type: 'log', line: event.data };
            }

            if (data.type === 'progress') {
                // Real-time progress update
                UI.renderProgress({
                    active: true,
                    job_type: data.job_type,
                    phase: data.phase,
                    detail: data.detail,
                    percent: data.percent,
                    output_lines: this._wsOutputLines,
                });
            } else if (data.type === 'log') {
                // Log line
                const line = data.line || '';
                logContent.push(line);
                if (logContent.length > 200) logContent.shift();
                UI.renderLogs(logContent, 'log-jobs');

                // Keep output lines for progress display
                this._wsOutputLines.push(line);
                if (this._wsOutputLines.length > 80) this._wsOutputLines.shift();
            } else if (data.type === 'status') {
                // Job status change
                if (data.status === 'completed' || data.status === 'failed') {
                    const isSuccess = data.status === 'completed';
                    UI.showToast(
                        isSuccess ? 'Job erfolgreich abgeschlossen ✅' : 'Job fehlgeschlagen ❌',
                        isSuccess ? 'success' : 'error'
                    );
                    UI.hideProgress();
                    this._wsOutputLines = [];
                    this._stopProgressPoll();
                    setTimeout(() => this.refresh(), 2000);
                } else if (data.status === 'running') {
                    this._wsOutputLines = [];
                    this._startProgressPoll();
                }
            }
        };

        ws.onerror = () => { console.error("WebSocket Error"); };
        ws.onclose = () => {
            // Exponential backoff with jitter (5s → 10s → 20s → max 60s)
            this._wsReconnectDelay = Math.min((this._wsReconnectDelay || 5000) * 2, 60000);
            const jitter = Math.random() * 2000;
            setTimeout(() => this.startLogStream(), this._wsReconnectDelay + jitter);
        };
        ws.onopen = () => { this._wsReconnectDelay = 5000; };
    },
    
    switchLogTab(tab) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector(`button[data-tab="${tab}"]`).classList.add('active');
        document.getElementById(`tab-${tab}`).classList.add('active');
    },
    
    // ─── Backup Actions ──────────────────────────────────────────────────

    async triggerBackup() {
        try {
            await api.triggerBackup();
            UI.showToast('Backup wurde gestartet.', 'success');
            this.switchLogTab('jobs');
            this._startProgressPoll();
            setTimeout(() => this.refresh(), 2000);
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    },
    
    async triggerCheck() {
        try {
            await api.triggerCheck();
            UI.showToast('Integritätsprüfung gestartet.', 'success');
            this.switchLogTab('jobs');
            this._startProgressPoll();
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    },
    
    async triggerPrune() {
        try {
            await api.triggerPrune();
            UI.showToast('Bereinigung gestartet.', 'success');
            this.switchLogTab('jobs');
            this._startProgressPoll();
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    },

    async triggerBreakLock() {
        if (!confirm('Möchtest du wirklich die Sperre (Lock) des Repositories aufheben? Dies sollte nur gemacht werden, wenn kein anderes Backup läuft!')) return;
        try {
            await api.triggerBreakLock();
            UI.showToast('Sperre erfolgreich aufgehoben.', 'success');
            setTimeout(() => this.refresh(), 1000);
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    },
    
    // ─── Service Actions ─────────────────────────────────────────────────

    async serviceAction(containerName, action) {
        try {
            UI.showToast(`Aktion ${action} auf ${containerName} wird ausgeführt...`, 'info');
            await api.serviceAction(containerName, action);
            UI.showToast(`Container ${containerName} ${action} ausgeführt.`, 'success');
            setTimeout(() => this.refresh(), 2000);
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    },
    
    // ─── Snapshots Modal ─────────────────────────────────────────────────

    async openSnapshotsModal() {
        document.getElementById('snapshots-modal').style.display = 'flex';
        // We re-render the archives into the new table
        const tbody = document.getElementById('snapshots-tbody');
        if (!tbody) return;
        
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="spinner"></div><p>Lade Snapshots…</p></div></td></tr>`;
        
        try {
            const archives = await api.getArchives();
            if (archives.success && archives.archives) {
                // components.js should have a function to render these, or we do it here
                UI.renderArchivesTable(archives.archives);
                
                // Start calculating sizes sequentially in the background
                (async () => {
                    for (const arch of archives.archives) {
                        // If user closed the modal, stop calculating to save resources
                        if (document.getElementById('snapshots-modal').style.display === 'none') {
                            break;
                        }
                        await this.calculateSnapshotSize(arch.name);
                    }
                })();
            }
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state" style="color:red">Fehler: ${e.message}</div></td></tr>`;
        }
    },
    
    closeSnapshotsModal() {
        document.getElementById('snapshots-modal').style.display = 'none';
    },



    async calculateSnapshotSize(snapshotId) {
        const sizeCell = document.getElementById(`size-${snapshotId}`);
        
        if (sizeCell) sizeCell.innerHTML = '<div class="spinner" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"></div>';

        try {
            const res = await api.getSnapshotStats(snapshotId);
            if (res.stats && sizeCell) {
                const gb = (res.stats.total_size / (1024*1024*1024)).toFixed(2);
                sizeCell.innerText = `${gb} GB`;
            }
        } catch (e) {
            if (sizeCell) sizeCell.innerText = 'Fehler';
        }
    },

    async openConfig() {
        document.getElementById('config-modal').style.display = 'flex';
        const scheduleEl = document.getElementById('config-schedule');
        const contentEl = document.getElementById('config-content');

        // Load schedule info
        try {
            const schedule = await api.getSchedule();
            let scheduleHtml = `<strong>📅 Sicherungsintervall:</strong> ${UI.escapeHtml(schedule.description || 'Unbekannt')}`;
            if (schedule.next_expected) {
                const next = new Date(schedule.next_expected);
                const now = new Date();
                const diffMs = next - now;
                let nextStr = next.toLocaleString('de-DE');
                if (diffMs > 0) {
                    const diffH = Math.floor(diffMs / 1000 / 60 / 60);
                    const diffM = Math.floor((diffMs / 1000 / 60) % 60);
                    nextStr += diffH > 0 ? ` (in ${diffH}h ${diffM}m)` : ` (in ${diffM}m)`;
                } else {
                    nextStr += ' (überfällig)';
                }
                scheduleHtml += `<br><strong>⏭️ Nächstes Backup erwartet:</strong> ${nextStr}`;
            }
            if (schedule.last_backup) {
                scheduleHtml += `<br><strong>🕐 Letztes Backup:</strong> ${new Date(schedule.last_backup).toLocaleString('de-DE')}`;
            }
            scheduleEl.innerHTML = scheduleHtml;
        } catch (e) {
            scheduleEl.innerHTML = '<strong>Sicherungsintervall:</strong> Konnte nicht ermittelt werden.';
        }

        // Load config table
        try {
            const cfg = await api.getConfig();
            if (cfg.success) {
                if (cfg.config_table && cfg.config_table.length > 0) {
                    let html = '<table class="archive-table" style="width:100%; text-align:left;"><thead><tr><th>Einstellung</th><th>Wert</th></tr></thead><tbody>';
                    for (const row of cfg.config_table) {
                        html += `<tr>
                            <td style="font-family: var(--font-mono); color: var(--accent-cyan); width: 40%; word-break: break-word;">${UI.escapeHtml(row.key)}</td>
                            <td style="font-family: var(--font-mono); word-break: break-word;">${UI.escapeHtml(row.value)}</td>
                        </tr>`;
                    }
                    html += '</tbody></table>';
                    contentEl.innerHTML = html;
                    contentEl.style.padding = '0';
                    contentEl.style.background = 'transparent';
                } else {
                    contentEl.innerText = cfg.config || 'Konfiguration ist leer.';
                }
            } else {
                contentEl.innerText = 'Fehler beim Laden der Konfiguration:\n' + (cfg.error || 'Unbekannter Fehler.');
            }
        } catch (e) {
            contentEl.innerText = 'Netzwerkfehler: ' + e.message;
        }
    },
    
    closeConfig() {
        document.getElementById('config-modal').style.display = 'none';
    },
    


    // ─── Schedule Modal ──────────────────────────────────────────────────

    async openSchedule() {
        document.getElementById('schedule-modal').style.display = 'flex';
        const contentEl = document.getElementById('schedule-modal-content');
        if (contentEl) contentEl.style.opacity = '0.5';

        try {
            const cfg = await api.getScheduleConfig();
            UI.renderScheduleConfig(cfg);
            if (contentEl) contentEl.style.opacity = '1';
        } catch (e) {
            UI.showToast('Scheduler-Konfiguration konnte nicht geladen werden: ' + e.message, 'error');
            if (contentEl) contentEl.style.opacity = '1';
        }
    },

    closeSchedule() {
        document.getElementById('schedule-modal').style.display = 'none';
    },

    async toggleSchedule() {
        const toggle = document.getElementById('schedule-toggle');
        try {
            if (toggle.checked) {
                await api.enableSchedule();
                UI.showToast('Automatische Backups aktiviert ✅', 'success');
            } else {
                await api.disableSchedule();
                UI.showToast('Automatische Backups deaktiviert', 'info');
            }
            // Reload config to update UI
            const cfg = await api.getScheduleConfig();
            UI.renderScheduleConfig(cfg);
        } catch (e) {
            UI.showToast('Fehler: ' + e.message, 'error');
            toggle.checked = !toggle.checked; // revert
        }
    },

    selectPreset(presetKey) {
        // Update UI
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.preset-btn[data-preset="${presetKey}"]`);
        if (btn) btn.classList.add('active');

        // Uncheck custom
        const customToggle = document.getElementById('schedule-custom-toggle');
        if (customToggle) customToggle.checked = false;
    },

    async saveSchedule() {
        const toggle = document.getElementById('schedule-toggle');
        const customToggle = document.getElementById('schedule-custom-toggle');
        const customCron = document.getElementById('schedule-custom-cron');
        const autoPrune = document.getElementById('schedule-auto-prune');
        const autoCheck = document.getElementById('schedule-auto-check');

        // Find active preset
        const activePresetBtn = document.querySelector('.preset-btn.active');
        const preset = activePresetBtn ? activePresetBtn.dataset.preset : 'daily_03';

        const data = {
            enabled: toggle ? toggle.checked : false,
            preset: preset,
            use_custom: customToggle ? customToggle.checked : false,
            custom_cron: customCron ? customCron.value.trim() : '',
            options: {
                auto_prune: autoPrune ? autoPrune.checked : false,
                auto_check_weekly: autoCheck ? autoCheck.checked : false,
                verbosity: 1,
            },
        };

        try {
            const result = await api.setScheduleConfig(data);
            UI.renderScheduleConfig(result);
            UI.showToast('Zeitplan gespeichert ✅', 'success');
        } catch (e) {
            UI.showToast('Fehler beim Speichern: ' + e.message, 'error');
        }
    },

    // ─── Storage / Google Drive Link ─────────────────────────────────────

    openGoogleDrive() {
        const url = this._gdriveUrl || 'https://drive.google.com';
        window.open(url, '_blank');
    },

    async openStorage() {
        this.openGoogleDrive();
    },

    closeStorage() {
        const modal = document.getElementById('storage-modal');
        if (modal) modal.style.display = 'none';
    },

    // ─── Repository Management ───────────────────────────────────────────

    openAddRepoModal() {
        document.getElementById('repo-modal-title').innerText = '➕ Sicherungsort hinzufügen';
        document.getElementById('repo-original-label').value = '';
        document.getElementById('repo-name-input').value = '';
        document.getElementById('repo-label-input').value = '';
        document.getElementById('repo-label-input').readOnly = false;
        document.getElementById('repo-path-input').value = '';
        document.getElementById('repo-type-select').value = 'local';
        document.getElementById('repo-limit-input').value = '1000';
        this.onRepoTypeChange();
        document.getElementById('repo-modal').style.display = 'flex';
    },

    openEditRepoModal(repoObj) {
        if (typeof repoObj === 'string') {
            try { repoObj = JSON.parse(repoObj); } catch (e) {}
        }
        document.getElementById('repo-modal-title').innerText = '✏️ Sicherungsort bearbeiten';
        document.getElementById('repo-original-label').value = repoObj.label || '';
        document.getElementById('repo-name-input').value = repoObj.name || '';
        document.getElementById('repo-label-input').value = repoObj.label || '';
        document.getElementById('repo-path-input').value = repoObj.path || '';
        document.getElementById('repo-type-select').value = repoObj.type || 'local';
        document.getElementById('repo-limit-input').value = repoObj.limit_gb || 1000;
        this.onRepoTypeChange();
        document.getElementById('repo-modal').style.display = 'flex';
    },

    closeRepoModal() {
        document.getElementById('repo-modal').style.display = 'none';
    },

    onRepoTypeChange() {
        const type = document.getElementById('repo-type-select').value;
        const helpEl = document.getElementById('repo-path-help');
        const pathInput = document.getElementById('repo-path-input');

        if (type === 'gdrive') {
            if (helpEl) helpEl.innerText = 'Lokales Repository, das nach dem Backup via rclone nach Google Drive synchronisiert wird.';
            if (!pathInput.value) pathInput.placeholder = '/var/backups/borg_repo';
        } else if (type === 'hetzner') {
            if (helpEl) helpEl.innerText = 'Format: ssh://<user>@<user>.your-storagebox.de:23/./backup';
            if (!pathInput.value) pathInput.placeholder = 'ssh://u12345@u12345.your-storagebox.de:23/./backup';
        } else if (type === 'ssh') {
            if (helpEl) helpEl.innerText = 'Format: ssh://user@hostname:22/./backup';
            if (!pathInput.value) pathInput.placeholder = 'ssh://user@remote-nas:22/./backup';
        } else {
            if (helpEl) helpEl.innerText = 'Wichtig: Stelle sicher, dass der Pfad in docker-compose.yml in den Container gemountet ist (z.B. - /mnt/usb:/mnt/usb:rw).';
            if (!pathInput.value) pathInput.placeholder = '/mnt/usb_backup/repo';
        }
    },

    async saveRepository() {
        const originalLabel = document.getElementById('repo-original-label').value.trim();
        const name = document.getElementById('repo-name-input').value.trim();
        let label = document.getElementById('repo-label-input').value.trim();
        const path = document.getElementById('repo-path-input').value.trim();
        const type = document.getElementById('repo-type-select').value;
        const limitGb = parseFloat(document.getElementById('repo-limit-input').value) || 1000;

        if (!path) {
            UI.showToast('Bitte einen Pfad / Repository-URL eingeben.', 'error');
            return;
        }

        if (!label) {
            label = (name || 'repo').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        }

        const data = {
            name: name || label,
            label: label,
            path: path,
            type: type,
            limit_gb: limitGb,
        };

        try {
            if (originalLabel) {
                await api.updateRepository(originalLabel, data);
                UI.showToast(`Sicherungsort '${data.name}' aktualisiert ✅`, 'success');
            } else {
                await api.addRepository(data);
                UI.showToast(`Sicherungsort '${data.name}' hinzugefügt ✅`, 'success');
            }
            this.closeRepoModal();
            this.openStorage(); // refresh storage modal
            this.refresh(); // refresh dashboard status card
        } catch (e) {
            UI.showToast('Fehler beim Speichern: ' + e.message, 'error');
        }
    },

    async deleteRepository(label) {
        if (!confirm(`Möchtest du den Sicherungsort '${label}' wirklich aus der Konfiguration entfernen?`)) return;
        try {
            await api.deleteRepository(label);
            UI.showToast(`Sicherungsort '${label}' entfernt`, 'info');
            this.openStorage();
            this.refresh();
        } catch (e) {
            UI.showToast('Fehler beim Entfernen: ' + e.message, 'error');
        }
    },

    async updateProject(projectName) {
        if (!confirm(`Möchtest du das Compose-Projekt '${projectName}' wirklich updaten (Images herunterladen und Container neu starten)?\nDas kann je nach Internetverbindung einige Minuten dauern. Die Logs werden im Hintergrund angezeigt.`)) return;
        try {
            UI.showToast(`Update für '${projectName}' gestartet...`, 'info');
            const res = await api.updateProject(projectName);
            UI.showToast(res.message, 'success');
        } catch (e) {
            UI.showToast('Fehler beim Update: ' + e.message, 'error');
        }
    },
    
    // ─── Kiosk Config ───────────────────────────────────────────────────
    async openKioskModal() {
        try {
            const res = await api.getKioskConfig();
            document.getElementById('kiosk-config-editor').value = res.content;
            document.getElementById('kiosk-config-path').innerText = res.path;
            document.getElementById('kiosk-modal').style.display = 'flex';
        } catch (e) {
            UI.showToast('Fehler beim Laden der Kiosk-Konfiguration: ' + e.message, 'error');
        }
    },
    
    closeKioskModal() {
        document.getElementById('kiosk-modal').style.display = 'none';
        document.getElementById('kiosk-config-editor').value = '';
    },
    
    async saveKioskConfig() {
        const content = document.getElementById('kiosk-config-editor').value;
        try {
            const res = await api.saveKioskConfig(content);
            UI.showToast(res.message, 'success');
            this.closeKioskModal();
        } catch (e) {
            UI.showToast('Fehler beim Speichern: ' + e.message, 'error');
        }
    },

    // ─── Snapshot Explorer & Restore (Feature 1) ────────────────────────
    _explorer: {
        snapshotId: null,
        allFiles: [],
        currentPath: '/',
        filterQuery: '',
    },

    async openArchive(snapshotId) {
        this._explorer.snapshotId = snapshotId;
        this._explorer.currentPath = '/';
        this._explorer.filterQuery = '';
        this._explorer.allFiles = [];

        const modal = document.getElementById('archive-modal');
        const titleEl = document.getElementById('archive-modal-title');
        const subtitleEl = document.getElementById('archive-modal-subtitle');
        const filterInput = document.getElementById('archive-filter-input');
        const table = document.getElementById('archive-files-table');
        const loading = document.getElementById('archive-loading');

        if (titleEl) titleEl.innerText = `Snapshot Explorer: ${snapshotId}`;
        if (subtitleEl) subtitleEl.innerText = 'Lade Dateibaum…';
        if (filterInput) filterInput.value = '';
        if (loading) {
            loading.style.display = 'block';
            loading.innerHTML = '<div class="spinner" style="margin: 0 auto 15px auto;"></div><p>Lade Dateiindex des Snapshots…</p>';
        }
        if (table) table.style.display = 'none';
        if (modal) modal.style.display = 'flex';

        try {
            const res = await api.getSnapshotFiles(snapshotId);
            if (res.success && res.files) {
                this._explorer.allFiles = res.files;
                if (subtitleEl) subtitleEl.innerText = `${res.files.length.toLocaleString('de-DE')} indexierte Dateien & Ordner`;
                this.renderExplorerView();
            } else {
                if (loading) loading.innerHTML = `<p style="color:var(--accent-red)">Fehler beim Lesen des Snapshots: ${UI.escapeHtml(res.error || 'Unbekannt')}</p>`;
            }
        } catch (e) {
            if (loading) loading.innerHTML = `<p style="color:var(--accent-red)">Fehler beim Laden: ${UI.escapeHtml(e.message)}</p>`;
        }
    },

    closeArchiveModal() {
        const modal = document.getElementById('archive-modal');
        if (modal) modal.style.display = 'none';
    },

    navigateToExplorerPath(path) {
        this._explorer.currentPath = path || '/';
        this._explorer.filterQuery = '';
        const filterInput = document.getElementById('archive-filter-input');
        if (filterInput) filterInput.value = '';
        this.renderExplorerView();
    },

    filterExplorerFiles(query) {
        this._explorer.filterQuery = (query || '').trim().toLowerCase();
        this.renderExplorerView();
    },

    renderExplorerView() {
        const { snapshotId, allFiles, currentPath, filterQuery } = this._explorer;
        const breadcrumbsEl = document.getElementById('archive-breadcrumbs');
        const table = document.getElementById('archive-files-table');
        const tbody = document.getElementById('archive-files-tbody');
        const loading = document.getElementById('archive-loading');
        const countEl = document.getElementById('explorer-item-count');
        const sizeEl = document.getElementById('explorer-selected-size');

        if (!allFiles || allFiles.length === 0) {
            if (loading) {
                loading.style.display = 'block';
                loading.innerHTML = '<p>Dieser Snapshot enthält keine Dateien oder ist leer.</p>';
            }
            if (table) table.style.display = 'none';
            return;
        }

        // Render Breadcrumbs
        if (breadcrumbsEl) {
            const parts = currentPath.split('/').filter(Boolean);
            let crumbHtml = `<span class="crumb ${parts.length === 0 ? 'active' : ''}" onclick="BorgGuard.navigateToExplorerPath('/')">root</span>`;
            let accumulated = '';
            for (let i = 0; i < parts.length; i++) {
                accumulated += '/' + parts[i];
                const isLast = (i === parts.length - 1 && !filterQuery);
                crumbHtml += `<span class="separator">/</span><span class="crumb ${isLast ? 'active' : ''}" onclick="BorgGuard.navigateToExplorerPath('${UI.escapeHtml(accumulated)}')">${UI.escapeHtml(parts[i])}</span>`;
            }
            if (filterQuery) {
                crumbHtml += `<span class="separator">/</span><span class="crumb active">🔍 Suche: "${UI.escapeHtml(filterQuery)}"</span>`;
            }
            breadcrumbsEl.innerHTML = crumbHtml;
        }

        // Filter items
        let visibleItems = [];
        const normCurrent = currentPath === '/' ? '/' : (currentPath.endsWith('/') ? currentPath : currentPath + '/');

        if (filterQuery) {
            // Global search in this snapshot
            visibleItems = allFiles.filter(f => f.path.toLowerCase().includes(filterQuery) || f.name.toLowerCase().includes(filterQuery));
        } else {
            // Folder view: direct children of currentPath
            const seen = new Set();
            for (const f of allFiles) {
                const p = f.path.startsWith('/') ? f.path : '/' + f.path;
                if (normCurrent === '/') {
                    // Top level items
                    const trimmed = p.substring(1);
                    const slashIdx = trimmed.indexOf('/');
                    if (slashIdx === -1) {
                        // Directly in root
                        visibleItems.push(f);
                    } else {
                        // Virtual folder or directory in root
                        const dirName = trimmed.substring(0, slashIdx);
                        const dirPath = '/' + dirName;
                        if (!seen.has(dirPath)) {
                            seen.add(dirPath);
                            visibleItems.push({
                                name: dirName,
                                path: dirPath,
                                type: 'd',
                                size: 0,
                                mode: 'drwxr-xr-x',
                                mtime: f.mtime
                            });
                        }
                    }
                } else if (p.startsWith(normCurrent) && p !== normCurrent.slice(0, -1)) {
                    const relative = p.substring(normCurrent.length);
                    const slashIdx = relative.indexOf('/');
                    if (slashIdx === -1) {
                        // Direct child
                        visibleItems.push(f);
                    } else {
                        // Subdirectory entry
                        const dirName = relative.substring(0, slashIdx);
                        const dirPath = normCurrent + dirName;
                        if (!seen.has(dirPath)) {
                            seen.add(dirPath);
                            visibleItems.push({
                                name: dirName,
                                path: dirPath,
                                type: 'd',
                                size: 0,
                                mode: 'drwxr-xr-x',
                                mtime: f.mtime
                            });
                        }
                    }
                }
            }
        }

        // Sort: directories first, then alphabetically
        visibleItems.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'd' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        if (loading) loading.style.display = 'none';
        if (table) table.style.display = 'table';

        let html = '';

        // Add parent directory row ("..") if inside a subfolder
        if (!filterQuery && currentPath !== '/') {
            const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
            html += `
            <tr class="explorer-row is-dir" onclick="BorgGuard.navigateToExplorerPath('${UI.escapeHtml(parentPath)}')">
                <td style="text-align:center;"><span class="explorer-icon">📁</span></td>
                <td class="explorer-name" style="font-weight:600; color:var(--accent-cyan);">..</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td style="text-align:right;"></td>
            </tr>`;
        }

        let totalSize = 0;
        for (const item of visibleItems) {
            totalSize += item.size || 0;
            const isDir = item.type === 'd';
            const icon = isDir ? '📁' : this.getFileIcon(item.name);
            const sizeStr = isDir ? '—' : UI.formatBytes(item.size);
            const dateStr = item.mtime ? new Date(item.mtime).toLocaleString('de-DE') : '—';
            const displayPath = filterQuery ? item.path : item.name;

            const clickAction = isDir
                ? `BorgGuard.navigateToExplorerPath('${UI.escapeHtml(item.path)}')`
                : `BorgGuard.downloadFile('${UI.escapeHtml(snapshotId)}', '${UI.escapeHtml(item.path)}')`;

            const actionsHtml = isDir
                ? `<button class="explorer-btn" onclick="event.stopPropagation(); BorgGuard.openRestoreModal('${UI.escapeHtml(snapshotId)}', '${UI.escapeHtml(item.path)}')" title="Diesen Ordner wiederherstellen">🔄 Restore</button>`
                : `
                    <button class="explorer-btn" onclick="event.stopPropagation(); BorgGuard.downloadFile('${UI.escapeHtml(snapshotId)}', '${UI.escapeHtml(item.path)}')" title="Datei herunterladen">⬇️ Download</button>
                    <button class="explorer-btn" onclick="event.stopPropagation(); BorgGuard.openRestoreModal('${UI.escapeHtml(snapshotId)}', '${UI.escapeHtml(item.path)}')" title="Diese Datei wiederherstellen">🔄</button>
                `;

            html += `
            <tr class="explorer-row ${isDir ? 'is-dir' : ''}" onclick="${clickAction}">
                <td style="text-align:center;"><span class="explorer-icon">${icon}</span></td>
                <td class="explorer-name" title="${UI.escapeHtml(item.path)}">${UI.escapeHtml(displayPath)}</td>
                <td class="size-cell" style="font-family:var(--font-mono); font-size:0.8rem;">${sizeStr}</td>
                <td style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-secondary);">${UI.escapeHtml(item.mode || '')}</td>
                <td class="date-cell" style="font-size:0.8rem;">${dateStr}</td>
                <td style="text-align:right; white-space:nowrap;">${actionsHtml}</td>
            </tr>`;
        }

        if (visibleItems.length === 0) {
            html += `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">Keine Dateien in diesem Verzeichnis gefunden.</td></tr>`;
        }

        if (tbody) tbody.innerHTML = html;
        if (countEl) countEl.innerText = `${visibleItems.length} Elemente`;
        if (sizeEl) sizeEl.innerText = totalSize > 0 ? `Gesamt: ${UI.formatBytes(totalSize)}` : '';
    },

    getFileIcon(filename) {
        if (!filename) return '📄';
        const ext = filename.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return '🖼️';
        if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return '🎬';
        if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return '🎵';
        if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'].includes(ext)) return '📦';
        if (['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'conf', 'config'].includes(ext)) return '⚙️';
        if (['py', 'js', 'html', 'css', 'ts', 'sh', 'php', 'sql', 'cpp', 'c', 'go', 'rs'].includes(ext)) return '📜';
        if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'].includes(ext)) return '📝';
        return '📄';
    },

    downloadFile(snapshotId, filePath) {
        const url = api.getDownloadFileUrl(snapshotId, filePath);
        window.open(url, '_blank');
        UI.showToast(`Download gestartet: ${filePath.split('/').pop()}`, 'info');
    },

    openRestoreModal(snapshotId = null, includePath = '') {
        const targetSnapId = snapshotId || this._explorer.snapshotId;
        if (!targetSnapId) {
            UI.showToast('Kein Snapshot ausgewählt.', 'error');
            return;
        }
        document.getElementById('restore-snapshot-id').value = targetSnapId;
        document.getElementById('restore-include-path').value = includePath || '';
        document.getElementById('restore-modal').style.display = 'flex';
    },

    closeRestoreModal() {
        document.getElementById('restore-modal').style.display = 'none';
    },

    async confirmRestore() {
        const snapshotId = document.getElementById('restore-snapshot-id').value.trim();
        const includePath = document.getElementById('restore-include-path').value.trim();
        const targetDir = document.getElementById('restore-target-dir').value.trim() || '/restore';

        if (!snapshotId) {
            UI.showToast('Ungültige Snapshot-ID.', 'error');
            return;
        }

        const includePaths = includePath ? [includePath] : null;
        const confirmMsg = includePath
            ? `Möchtest du den Pfad '${includePath}' aus Snapshot '${snapshotId}' wirklich nach '${targetDir}' auf dem Server wiederherstellen?`
            : `Möchtest du das GESAMTE Backup aus Snapshot '${snapshotId}' nach '${targetDir}' auf dem Server wiederherstellen?`;

        if (!confirm(confirmMsg)) return;

        try {
            UI.showToast('Wiederherstellung wird gestartet…', 'info');
            const res = await api.restoreSnapshot(snapshotId, targetDir, includePaths);
            this.closeRestoreModal();
            this.closeArchiveModal();
            UI.showToast(res.message || 'Wiederherstellung läuft!', 'success');
            setTimeout(() => this.refresh(), 1000);
        } catch (e) {
            UI.showToast('Fehler beim Starten der Wiederherstellung: ' + e.message, 'error');
        }
    },
};


window.onload = () => BorgGuard.init();
