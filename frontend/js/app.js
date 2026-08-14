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

                // ─── Mini Diff inside Snapshot Card (Auto-Diff nach Backup) ───
                const diffContainer = document.getElementById('last-backup-diff');
                const diffAdded = document.getElementById('mini-diff-added');
                const diffMod = document.getElementById('mini-diff-modified');
                const diffRem = document.getElementById('mini-diff-removed');

                if (status.latest_diff && status.latest_diff.added !== undefined) {
                    this._latestBackupDiff = status.latest_diff;
                    if (diffAdded) diffAdded.innerText = `+${status.latest_diff.added} Neu`;
                    if (diffMod) diffMod.innerText = `~${status.latest_diff.modified} Geändert`;
                    if (diffRem) diffRem.innerText = `-${status.latest_diff.removed} Gelöscht`;
                    if (diffContainer) diffContainer.style.display = 'flex';
                } else {
                    if (diffContainer) diffContainer.style.display = 'none';
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

            // Refresh DR status badge
            this.loadDrStatus();

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
                    if (!isSuccess) {
                        const errMsg = data.error || 'Vorgang fehlgeschlagen';
                        UI.showToast(`❌ Fehlgeschlagen: ${errMsg}`, 'error');
                        this.switchLogTab('jobs');
                    } else {
                        UI.showToast('Job erfolgreich abgeschlossen ✅', 'success');
                    }
                    UI.hideProgress();
                    this._wsOutputLines = [];
                    this._stopProgressPoll();
                    setTimeout(() => {
                        this.refresh();
                        this.loadDrStatus();
                    }, 1500);
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

    async cancelCurrentJob() {
        if (!confirm('Möchtest du den aktuell laufenden Vorgang wirklich abbrechen?\n\nAlle laufenden Prozesse werden gestoppt und temporäre Daten sofort bereinigt.')) return;
        try {
            const res = await api.cancelJob();
            UI.showToast(res.message || 'Vorgang wurde abgebrochen und bereinigt.', 'info');
            setTimeout(() => this.refresh(), 1000);
        } catch (e) {
            UI.showToast('Fehler beim Abbrechen: ' + e.message, 'error');
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
    _snapshotsCache: [],
    _selectedTagFilter: '',

    async openSnapshotsModal() {
        document.getElementById('snapshots-modal').style.display = 'flex';
        const tbody = document.getElementById('snapshots-tbody');
        if (!tbody) return;

        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="spinner"></div><p>Lade Snapshots…</p></div></td></tr>`;

        try {
            const archives = await api.getArchives();
            if (archives.success && archives.archives) {
                this._snapshotsCache = archives.archives;
                UI.renderArchivesTable(this._snapshotsCache, this._selectedTagFilter);

                // Start calculating sizes sequentially in the background
                (async () => {
                    for (const arch of archives.archives) {
                        if (document.getElementById('snapshots-modal').style.display === 'none') {
                            break;
                        }
                        await this.calculateSnapshotSize(arch.name);
                    }
                })();
            }
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="color:red">Fehler: ${e.message}</div></td></tr>`;
        }
    },

    closeSnapshotsModal() {
        document.getElementById('snapshots-modal').style.display = 'none';
    },

    filterSnapshotsByTag(tag) {
        this._selectedTagFilter = tag || '';
        UI.renderArchivesTable(this._snapshotsCache, this._selectedTagFilter);
    },

    // ─── Tag Management (Feature 4) ─────────────────────────────────────
    _currentTagModalSnapId: null,
    _currentTagModalTags: [],

    openTagModal(snapshotId, tags = []) {
        this._currentTagModalSnapId = snapshotId;

        let currentTags = [];
        if (this._snapshotsCache && this._snapshotsCache.length > 0) {
            const snap = this._snapshotsCache.find(s => s.name === snapshotId || s.id === snapshotId || s.short_id === snapshotId);
            if (snap && Array.isArray(snap.tags)) {
                currentTags = snap.tags;
            }
        } else if (Array.isArray(tags)) {
            currentTags = tags;
        }
        this._currentTagModalTags = [...currentTags];

        const snapIdInput = document.getElementById('tag-snapshot-id');
        const snapIdLabel = document.getElementById('tag-modal-snap-id');
        const input = document.getElementById('tag-new-input');

        if (snapIdInput) snapIdInput.value = snapshotId;
        if (snapIdLabel) snapIdLabel.innerText = snapshotId;
        if (input) input.value = '';
        this.renderTagModalChips();

        document.getElementById('tag-modal').style.display = 'flex';
        setTimeout(() => {
            if (input) input.focus();
        }, 50);
    },

    closeTagModal() {
        document.getElementById('tag-modal').style.display = 'none';
        this._currentTagModalSnapId = null;
        this._currentTagModalTags = [];
    },

    renderTagModalChips() {
        const container = document.getElementById('tag-modal-current-tags');
        if (!container) return;

        if (this._currentTagModalTags.length === 0) {
            container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.82rem;">Keine Tags vorhanden</span>';
            return;
        }

        let html = '';
        for (const t of this._currentTagModalTags) {
            html += `
                <span class="tag-chip">
                    🏷️ ${UI.escapeHtml(t)}
                    <span class="chip-delete" onclick="BorgGuard.removeTagFromModal('${UI.escapeHtml(t)}')" title="Diesen Tag entfernen">×</span>
                </span>`;
        }
        container.innerHTML = html;
    },

    async addNewTag() {
        const input = document.getElementById('tag-new-input');
        if (!input) return;
        const tag = input.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (!tag) {
            UI.showToast('Bitte einen gültigen Tag-Namen eingeben.', 'error');
            return;
        }

        if (this._currentTagModalTags.includes(tag)) {
            UI.showToast(`Tag '${tag}' ist bereits vorhanden.`, 'info');
            input.value = '';
            return;
        }

        const snapshotId = this._currentTagModalSnapId;
        if (!snapshotId) {
            UI.showToast('Kein Snapshot ausgewählt.', 'error');
            return;
        }

        try {
            UI.showToast(`Füge Tag '${tag}' hinzu…`, 'info');
            const res = await api.updateSnapshotTags(snapshotId, 'add', [tag]);
            if (res.success) {
                this._currentTagModalTags.push(tag);
                input.value = '';
                this.renderTagModalChips();

                // Reload all snapshots to update IDs and tags
                const archivesRes = await api.getArchives();
                if (archivesRes.success && archivesRes.archives) {
                    this._snapshotsCache = archivesRes.archives;
                    UI.renderArchivesTable(this._snapshotsCache, this._selectedTagFilter);
                }
                UI.showToast(`Tag '${tag}' erfolgreich hinzugefügt ✅`, 'success');
            } else {
                UI.showToast(`Fehler: ${res.error || 'Konnte Tag nicht hinzufügen'}`, 'error');
            }
        } catch (e) {
            UI.showToast('Fehler beim Hinzufügen des Tags: ' + e.message, 'error');
        }
    },

    async addPresetTag(presetName) {
        document.getElementById('tag-new-input').value = presetName;
        await this.addNewTag();
    },

    async removeTagFromModal(tag) {
        const snapshotId = this._currentTagModalSnapId;
        await this.removeSnapshotTag(snapshotId, tag);
        this._currentTagModalTags = this._currentTagModalTags.filter(t => t !== tag);
        this.renderTagModalChips();
    },

    async removeSnapshotTag(snapshotId, tag) {
        try {
            UI.showToast(`Entferne Tag '${tag}'…`, 'info');
            const res = await api.removeSnapshotTag(snapshotId, tag);
            if (res.success) {
                const archivesRes = await api.getArchives();
                if (archivesRes.success && archivesRes.archives) {
                    this._snapshotsCache = archivesRes.archives;
                    UI.renderArchivesTable(this._snapshotsCache, this._selectedTagFilter);
                }
                UI.showToast(`Tag '${tag}' entfernt ✅`, 'success');
            } else {
                UI.showToast(`Fehler: ${res.error || 'Konnte Tag nicht entfernen'}`, 'error');
            }
        } catch (e) {
            UI.showToast('Fehler beim Entfernen des Tags: ' + e.message, 'error');
        }
    },

    // ─── Snapshot Diff (Feature 2) ──────────────────────────────────────
    _diffData: null,
    _latestBackupDiff: null,
    _currentDiffTab: 'all',

    async openLatestDiffModal() {
        await this.openDiffModal();
        if (this._latestBackupDiff) {
            const snap1Select = document.getElementById('diff-select-snap1');
            const snap2Select = document.getElementById('diff-select-snap2');
            if (snap1Select && this._latestBackupDiff.snap_prev) {
                snap1Select.value = this._latestBackupDiff.snap_prev;
            }
            if (snap2Select && this._latestBackupDiff.snap_new) {
                snap2Select.value = this._latestBackupDiff.snap_new;
            }
            await this.runSnapshotDiff();
        }
    },

    async openDiffModal() {
        const snap1Select = document.getElementById('diff-select-snap1');
        const snap2Select = document.getElementById('diff-select-snap2');
        const summaryRow = document.getElementById('diff-summary-row');
        const tabsBar = document.getElementById('diff-filter-tabs');
        const resultsContainer = document.getElementById('diff-results-container');
        const emptyPrompt = document.getElementById('diff-empty-prompt');

        if (summaryRow) summaryRow.style.display = 'none';
        if (tabsBar) tabsBar.style.display = 'none';
        if (resultsContainer) resultsContainer.style.display = 'none';
        if (emptyPrompt) emptyPrompt.style.display = 'block';

        // Populate selects with available snapshots
        let snapshots = this._snapshotsCache;
        if (!snapshots || snapshots.length === 0) {
            try {
                const archives = await api.getArchives();
                if (archives.success && archives.archives) {
                    snapshots = archives.archives;
                    this._snapshotsCache = snapshots;
                }
            } catch (e) {}
        }

        if (snapshots && snapshots.length > 0) {
            const sorted = [...snapshots].sort((a, b) => new Date(b.start) - new Date(a.start));
            let optionsHtml = '';
            for (const s of sorted) {
                const dateStr = s.start ? new Date(s.start).toLocaleString('de-DE') : '';
                const tagStr = Array.isArray(s.tags) && s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
                optionsHtml += `<option value="${UI.escapeHtml(s.name)}">${UI.escapeHtml(s.name)} (${dateStr})${UI.escapeHtml(tagStr)}</option>`;
            }
            if (snap1Select) {
                snap1Select.innerHTML = optionsHtml;
                if (sorted.length > 1) snap1Select.selectedIndex = 1;
            }
            if (snap2Select) {
                snap2Select.innerHTML = optionsHtml;
                if (sorted.length > 0) snap2Select.selectedIndex = 0;
            }
        }

        document.getElementById('diff-modal').style.display = 'flex';
    },

    closeDiffModal() {
        document.getElementById('diff-modal').style.display = 'none';
    },

    async runSnapshotDiff() {
        const snap1 = document.getElementById('diff-select-snap1').value;
        const snap2 = document.getElementById('diff-select-snap2').value;

        if (!snap1 || !snap2) {
            UI.showToast('Bitte zwei Snapshots auswählen.', 'error');
            return;
        }

        if (snap1 === snap2) {
            UI.showToast('Bitte zwei unterschiedliche Snapshots zum Vergleichen auswählen.', 'info');
            return;
        }

        const loading = document.getElementById('diff-loading');
        const emptyPrompt = document.getElementById('diff-empty-prompt');
        const summaryRow = document.getElementById('diff-summary-row');
        const tabsBar = document.getElementById('diff-filter-tabs');
        const resultsContainer = document.getElementById('diff-results-container');

        if (emptyPrompt) emptyPrompt.style.display = 'none';
        if (resultsContainer) resultsContainer.style.display = 'none';
        if (loading) loading.style.display = 'block';

        try {
            const res = await api.diffSnapshots(snap1, snap2);
            if (loading) loading.style.display = 'none';

            if (res.success) {
                this._diffData = res;
                this._currentDiffTab = 'all';

                const addedCount = (res.added || []).length;
                const modCount = (res.modified || []).length;
                const remCount = (res.removed || []).length;
                const totalCount = addedCount + modCount + remCount;

                document.getElementById('diff-count-added').innerText = addedCount;
                document.getElementById('diff-count-modified').innerText = modCount;
                document.getElementById('diff-count-removed').innerText = remCount;

                document.getElementById('diff-tab-count-all').innerText = totalCount;
                document.getElementById('diff-tab-count-added').innerText = addedCount;
                document.getElementById('diff-tab-count-modified').innerText = modCount;
                document.getElementById('diff-tab-count-removed').innerText = remCount;

                if (summaryRow) summaryRow.style.display = 'grid';
                if (tabsBar) tabsBar.style.display = 'flex';
                if (resultsContainer) resultsContainer.style.display = 'block';

                this.renderDiffResults();
            } else {
                UI.showToast('Fehler beim Vergleichen: ' + (res.error || 'Unbekannt'), 'error');
                if (emptyPrompt) {
                    emptyPrompt.style.display = 'block';
                    emptyPrompt.innerHTML = `<p style="color:var(--accent-red)">Fehler beim Vergleichen: ${UI.escapeHtml(res.error || '')}</p>`;
                }
            }
        } catch (e) {
            if (loading) loading.style.display = 'none';
            UI.showToast('Fehler beim Abrufen des Diffs: ' + e.message, 'error');
        }
    },

    switchDiffTab(tab) {
        this._currentDiffTab = tab;
        const tabBtns = document.querySelectorAll('#diff-filter-tabs .tab-btn');
        tabBtns.forEach(btn => {
            if (btn.getAttribute('data-diff-tab') === tab) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        this.renderDiffResults();
    },

    renderDiffResults() {
        const tbody = document.getElementById('diff-results-tbody');
        if (!tbody || !this._diffData) return;

        const { snap1, snap2, added, modified, removed } = this._diffData;
        let items = [];

        if (this._currentDiffTab === 'all' || this._currentDiffTab === 'added') {
            for (const p of (added || [])) items.push({ type: 'added', path: p });
        }
        if (this._currentDiffTab === 'all' || this._currentDiffTab === 'modified') {
            for (const p of (modified || [])) items.push({ type: 'modified', path: p });
        }
        if (this._currentDiffTab === 'all' || this._currentDiffTab === 'removed') {
            for (const p of (removed || [])) items.push({ type: 'removed', path: p });
        }

        if (items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:30px; color:var(--text-muted);">Keine Unterschiede in dieser Kategorie gefunden.</td></tr>`;
            return;
        }

        let html = '';
        for (const item of items) {
            const isAdded = item.type === 'added';
            const isMod = item.type === 'modified';
            const badgeClass = isAdded ? 'added' : (isMod ? 'modified' : 'removed');
            const badgeText = isAdded ? '➕ Neu' : (isMod ? '✏️ Geändert' : '🗑️ Gelöscht');
            const targetSnap = isAdded || isMod ? snap2 : snap1;

            html += `
            <tr class="explorer-row">
                <td style="text-align:center;"><span class="diff-badge ${badgeClass}">${badgeText}</span></td>
                <td class="explorer-name">${UI.escapeHtml(item.path)}</td>
                <td style="text-align:right;">
                    <button class="explorer-btn" onclick="BorgGuard.openArchive('${UI.escapeHtml(targetSnap)}')" title="Im Explorer ansehen">📂 Explorer</button>
                </td>
            </tr>`;
        }
        tbody.innerHTML = html;
    },

    // ─── Global File Search (Feature 2) ─────────────────────────────────
    openFindModal() {
        document.getElementById('global-find-input').value = '';
        document.getElementById('find-empty-prompt').style.display = 'block';
        document.getElementById('find-results-container').style.display = 'none';
        document.getElementById('find-loading').style.display = 'none';
        document.getElementById('find-footer').style.display = 'none';
        document.getElementById('find-modal').style.display = 'flex';
        setTimeout(() => document.getElementById('global-find-input').focus(), 50);
    },

    closeFindModal() {
        document.getElementById('find-modal').style.display = 'none';
    },

    async runGlobalFind() {
        const query = document.getElementById('global-find-input').value.trim();
        if (!query) {
            UI.showToast('Bitte einen Suchbegriff eingeben.', 'error');
            return;
        }

        const loading = document.getElementById('find-loading');
        const emptyPrompt = document.getElementById('find-empty-prompt');
        const resultsContainer = document.getElementById('find-results-container');
        const tbody = document.getElementById('find-results-tbody');
        const footer = document.getElementById('find-footer');
        const countEl = document.getElementById('find-results-count');

        if (emptyPrompt) emptyPrompt.style.display = 'none';
        if (resultsContainer) resultsContainer.style.display = 'none';
        if (loading) loading.style.display = 'block';
        if (footer) footer.style.display = 'none';

        try {
            const res = await api.findFiles(query);
            if (loading) loading.style.display = 'none';

            if (res.success) {
                const results = res.results || [];
                if (results.length === 0) {
                    if (emptyPrompt) {
                        emptyPrompt.style.display = 'block';
                        emptyPrompt.innerHTML = `<div class="empty-icon">🔍</div><p>Keine Dateien passend zu „<strong>${UI.escapeHtml(query)}</strong>“ in deinen Backups gefunden.</p>`;
                    }
                    return;
                }

                let html = '';
                for (const item of results) {
                    const dateStr = item.mtime ? new Date(item.mtime).toLocaleString('de-DE') : '—';
                    const sizeStr = item.size ? UI.formatBytes(item.size) : '—';
                    const icon = item.type === 'd' ? '📁' : BorgGuard.getFileIcon(item.name);

                    html += `
                    <tr class="explorer-row">
                        <td style="text-align:center;"><span class="explorer-icon">${icon}</span></td>
                        <td class="explorer-name" title="${UI.escapeHtml(item.path)}">
                            <strong>${UI.escapeHtml(item.name)}</strong>
                            <div style="font-size:0.75rem; color:var(--text-muted); word-break:break-all;">${UI.escapeHtml(item.path)}</div>
                        </td>
                        <td style="font-family:var(--font-mono); font-size:0.82rem; color:var(--accent-cyan);">
                            <a onclick="BorgGuard.openArchive('${UI.escapeHtml(item.snapshot)}')" style="cursor:pointer; text-decoration:underline;">${UI.escapeHtml(item.snapshot)}</a>
                        </td>
                        <td class="size-cell" style="font-family:var(--font-mono); font-size:0.8rem;">${sizeStr}</td>
                        <td class="date-cell" style="font-size:0.8rem;">${dateStr}</td>
                        <td style="text-align:right; white-space:nowrap;">
                            <button class="explorer-btn" onclick="BorgGuard.openArchive('${UI.escapeHtml(item.snapshot)}')" title="Im Explorer ansehen">📂 Explorer</button>
                            ${item.type !== 'd' ? `<button class="explorer-btn" onclick="BorgGuard.downloadFile('${UI.escapeHtml(item.snapshot)}', '${UI.escapeHtml(item.path)}')" title="Download">⬇️</button>` : ''}
                        </td>
                    </tr>`;
                }

                if (tbody) tbody.innerHTML = html;
                if (countEl) countEl.innerText = `${results.length} Fundstellen für „${query}“`;
                if (resultsContainer) resultsContainer.style.display = 'block';
                if (footer) footer.style.display = 'flex';
            } else {
                UI.showToast('Fehler bei der Suche: ' + (res.error || 'Unbekannt'), 'error');
            }
        } catch (e) {
            if (loading) loading.style.display = 'none';
            UI.showToast('Fehler beim Suchen: ' + e.message, 'error');
        }
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
            visibleItems = allFiles.filter(f => {
                const p = (f.path || '').toLowerCase();
                const n = (f.name || '').toLowerCase();
                return p.includes(filterQuery) || n.includes(filterQuery);
            });
        } else {
            // Folder view: direct children of currentPath
            const seen = new Set();
            for (const f of allFiles) {
                if (!f.path) continue;
                const p = f.path.startsWith('/') ? f.path : '/' + f.path;

                if (normCurrent === '/') {
                    const withoutLead = p.substring(1);
                    const slashIdx = withoutLead.indexOf('/');
                    if (slashIdx === -1) {
                        // Direct child of root
                        if (!seen.has(p)) {
                            seen.add(p);
                            visibleItems.push({
                                ...f,
                                path: p,
                                name: f.name || withoutLead || p
                            });
                        }
                    } else {
                        // In a subdirectory, ensure the top-level directory is visible
                        const dirName = withoutLead.substring(0, slashIdx);
                        const dirPath = '/' + dirName;
                        if (!seen.has(dirPath)) {
                            seen.add(dirPath);
                            visibleItems.push({
                                name: dirName,
                                path: dirPath,
                                type: 'd',
                                size: 0,
                                mode: 'drwxr-xr-x',
                                mtime: f.mtime || ''
                            });
                        }
                    }
                } else {
                    if (p.startsWith(normCurrent)) {
                        const relative = p.substring(normCurrent.length);
                        if (!relative) continue; // the directory itself
                        const slashIdx = relative.indexOf('/');
                        if (slashIdx === -1) {
                            // Direct child
                            if (!seen.has(p)) {
                                seen.add(p);
                                visibleItems.push({
                                    ...f,
                                    path: p,
                                    name: f.name || relative
                                });
                            }
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
                                    mtime: f.mtime || ''
                                });
                            }
                        }
                    }
                }
            }

            // Fallback: If folder view yields nothing at root, show flat items
            if (visibleItems.length === 0 && currentPath === '/' && allFiles.length > 0) {
                visibleItems = allFiles.slice(0, 100);
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

    // ─── Disaster Recovery Dry-Run (Feature 6) ──────────────────────────
    async loadDrStatus() {
        const valueEl = document.getElementById('dr-status-value');
        const detailEl = document.getElementById('dr-status-detail');
        if (!valueEl) return;

        try {
            const res = await api.getDrReport();
            if (res.success && res.report) {
                const r = res.report;
                if (r.status === 'PASSED') {
                    valueEl.innerHTML = `<span class="dr-badge passed">✅ PASSED</span>`;
                    const dateStr = r.last_tested ? new Date(r.last_tested).toLocaleDateString('de-DE') : '';
                    const mbStr = r.bytes_verified ? `${(r.bytes_verified / (1024*1024)).toFixed(1)} MB` : '';
                    detailEl.innerText = `${dateStr} · ${r.files_verified || 0} Dateien (${mbStr})`;
                } else if (r.status === 'FAILED') {
                    valueEl.innerHTML = `<span class="dr-badge failed">❌ FEHLER</span>`;
                    detailEl.innerText = r.message || 'DR-Test fehlgeschlagen';
                } else {
                    valueEl.innerHTML = `<span class="dr-badge none">Kein Test</span>`;
                    detailEl.innerText = 'Sandbox-Test ausführen ↗';
                }
            }
        } catch (e) {
            // ignore
        }
    },

    async openDrModal() {
        const select = document.getElementById('dr-select-snapshot');
        const badgeEl = document.getElementById('dr-report-badge');
        const dateEl = document.getElementById('dr-report-date');
        const msgEl = document.getElementById('dr-report-message');
        const detailsEl = document.getElementById('dr-report-details');

        // Populate select with snapshots
        let snapshots = this._snapshotsCache;
        if (!snapshots || snapshots.length === 0) {
            try {
                const archives = await api.getArchives();
                if (archives.success && archives.archives) {
                    snapshots = archives.archives;
                    this._snapshotsCache = snapshots;
                }
            } catch (e) {}
        }

        if (select && snapshots && snapshots.length > 0) {
            const sorted = [...snapshots].sort((a, b) => new Date(b.start) - new Date(a.start));
            let html = '<option value="">Neuester Snapshot (Automatisch)</option>';
            for (const s of sorted) {
                const dateStr = s.start ? new Date(s.start).toLocaleString('de-DE') : '';
                const snapIdentifier = s.short_id || (s.id ? s.id.substring(0, 8) : 'Snapshot');
                html += `<option value="${UI.escapeHtml(s.id)}">${UI.escapeHtml(snapIdentifier)} (${dateStr})</option>`;
            }
            select.innerHTML = html;
        }

        // Load latest report details
        try {
            const res = await api.getDrReport();
            if (res.success && res.report) {
                const r = res.report;
                if (r.status === 'PASSED') {
                    badgeEl.className = 'dr-badge passed';
                    badgeEl.innerText = '✅ PASSED';
                    dateEl.innerText = r.last_tested ? new Date(r.last_tested).toLocaleString('de-DE') : '';
                    msgEl.innerText = r.message || 'Erfolgreich';
                    const mb = r.bytes_verified ? (r.bytes_verified / (1024*1024)).toFixed(2) : 0;
                    detailsEl.innerText = `Snapshot: ${r.short_id || r.snapshot_id} · ${r.files_verified} Dateien · ${mb} MB · Dauer: ${r.duration_seconds}s`;
                } else if (r.status === 'FAILED') {
                    badgeEl.className = 'dr-badge failed';
                    badgeEl.innerText = '❌ FAILED';
                    dateEl.innerText = r.last_tested ? new Date(r.last_tested).toLocaleString('de-DE') : '';
                    msgEl.innerHTML = `<div style="color: var(--accent-red); font-weight: 600; margin-bottom: 6px;">❌ ${UI.escapeHtml(r.message || 'Fehlgeschlagen')}</div>`;
                    detailsEl.innerHTML = `<div>Snapshot: <code>${UI.escapeHtml(r.short_id || r.snapshot_id || '—')}</code> · Dauer: ${r.duration_seconds || 0}s</div><div style="margin-top: 10px;"><button class="action-btn-small" onclick="BorgGuard.showJobLogs()" style="border: 1px solid var(--terminal-border); background: var(--terminal-surface); color: var(--text-primary); cursor: pointer; padding: 4px 10px; border-radius: 4px;">📜 Zum Job-Log springen</button></div>`;
                } else {
                    badgeEl.className = 'dr-badge none';
                    badgeEl.innerText = 'Noch kein Test';
                    dateEl.innerText = '—';
                    msgEl.innerText = 'Noch kein automatisierter DR-Wiederherstellungstest durchgeführt.';
                    detailsEl.innerText = '';
                }
            }
        } catch (e) {}

        document.getElementById('dr-test-modal').style.display = 'flex';
    },

    showJobLogs() {
        this.closeDrModal();
        this.switchLogTab('jobs');
        const panel = document.getElementById('panel-logs');
        if (panel) {
            panel.scrollIntoView({ behavior: 'smooth' });
        }
    },

    closeDrModal() {
        document.getElementById('dr-test-modal').style.display = 'none';
    },

    async runDrTestFromModal() {
        const select = document.getElementById('dr-select-snapshot');
        const snapId = select ? select.value : null;

        this.closeDrModal();
        try {
            UI.showToast('Starte Disaster Recovery Dry-Run Test…', 'info');
            const res = await api.startDrTest(snapId || null);
            if (res.job) {
                UI.renderProgress({
                    active: true,
                    job_type: 'dr_test',
                    phase: 'DR-Sandbox-Test wird gestartet…',
                    percent: 5,
                    output_lines: []
                });
                this._startProgressPoll();
            }
        } catch (e) {
            UI.showToast('Fehler beim Starten des DR-Tests: ' + e.message, 'error');
        }
    },

    // ─── Help & Manual Modal ─────────────────────────────────────────────
    openHelpModal(tab = 'overview') {
        this.switchHelpTab(tab);
        document.getElementById('help-modal').style.display = 'flex';
    },

    closeHelpModal() {
        document.getElementById('help-modal').style.display = 'none';
    },

    switchHelpTab(tabName) {
        const buttons = document.querySelectorAll('.help-tab-btn');
        buttons.forEach(btn => {
            if (btn.getAttribute('data-help-tab') === tabName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        const sections = document.querySelectorAll('.help-section');
        sections.forEach(sec => {
            if (sec.id === `help-sec-${tabName}`) {
                sec.classList.add('active');
            } else {
                sec.classList.remove('active');
            }
        });
    },

    // ─── Backup Source Paths Management (Feature) ────────────────────────
    async openPathsModal() {
        document.getElementById('paths-modal').style.display = 'flex';
        await this.loadBackupPaths();
    },

    closePathsModal() {
        document.getElementById('paths-modal').style.display = 'none';
        const drawer = document.getElementById('path-browser-drawer');
        if (drawer) drawer.style.display = 'none';
    },

    async loadBackupPaths() {
        const container = document.getElementById('paths-list-container');
        const countBadge = document.getElementById('paths-count-badge');
        if (!container) return;

        container.innerHTML = `
            <div class="empty-state">
                <div class="spinner" style="margin: 0 auto 10px auto;"></div>
                <p>Lade Pfade…</p>
            </div>
        `;

        try {
            const res = await api.getBackupPaths();
            if (res.success && Array.isArray(res.paths)) {
                if (countBadge) {
                    countBadge.innerText = `${res.paths.length} Pfad${res.paths.length === 1 ? '' : 'e'} konfiguriert`;
                }

                if (res.paths.length === 0) {
                    container.innerHTML = `
                        <div class="empty-state">
                            <p>Keine Sicherungspfade konfiguriert. Füge unten einen Pfad hinzu.</p>
                        </div>
                    `;
                    return;
                }

                let html = '';
                for (const item of res.paths) {
                    const statusBadge = item.exists 
                        ? `<span class="badge online" style="font-size: 0.72rem;">✅ Gemountet</span>`
                        : `<span class="badge offline" style="font-size: 0.72rem;">⚠️ Nicht gemountet</span>`;
                    
                    html += `
                        <div class="path-item-card">
                            <div class="path-item-info">
                                <div class="path-item-text">${UI.escapeHtml(item.path)}</div>
                                <div class="path-item-meta">
                                    ${statusBadge}
                                    <span>${UI.escapeHtml(item.size_info || '')}</span>
                                </div>
                            </div>
                            <button class="action-btn-small danger" onclick="BorgGuard.removeBackupPath('${UI.escapeHtml(item.path)}')" title="Diesen Pfad aus den Backups entfernen" style="padding: 4px 8px; font-size: 0.78rem;">
                                🗑️ Entfernen
                            </button>
                        </div>
                    `;
                }
                container.innerHTML = html;
            } else {
                container.innerHTML = `<div class="empty-state"><p style="color: var(--accent-red);">Fehler beim Laden der Pfade.</p></div>`;
            }
        } catch (e) {
            container.innerHTML = `<div class="empty-state"><p style="color: var(--accent-red);">Fehler: ${UI.escapeHtml(e.message)}</p></div>`;
        }
    },

    setNewPathInput(path) {
        const input = document.getElementById('new-path-input');
        if (input) {
            input.value = path;
            input.focus();
        }
    },

    async addNewPath() {
        const input = document.getElementById('new-path-input');
        if (!input) return;
        const val = input.value.trim();
        if (!val) {
            UI.showToast('Bitte gib einen gültigen Pfad an.', 'error');
            return;
        }

        try {
            const res = await api.addBackupPath(val);
            if (res.success) {
                UI.showToast(`Pfad '${val}' erfolgreich hinzugefügt ✅`, 'success');
                input.value = '';
                await this.loadBackupPaths();
            } else {
                UI.showToast(`Fehler: ${res.error || 'Konnte Pfad nicht hinzufügen'}`, 'error');
            }
        } catch (e) {
            UI.showToast(`Fehler beim Hinzufügen: ${e.message}`, 'error');
        }
    },

    async removeBackupPath(path) {
        if (!confirm(`Möchtest du den Pfad '${path}' wirklich aus den Backups entfernen?`)) {
            return;
        }

        try {
            const res = await api.removeBackupPath(path);
            if (res.success) {
                UI.showToast(`Pfad '${path}' entfernt ✅`, 'success');
                await this.loadBackupPaths();
            } else {
                UI.showToast(`Fehler: ${res.error || 'Konnte Pfad nicht entfernen'}`, 'error');
            }
        } catch (e) {
            UI.showToast(`Fehler beim Entfernen: ${e.message}`, 'error');
        }
    },

    // ── Server Path Browser ──
    _currentBrowserDir: '/',

    async togglePathBrowser() {
        const drawer = document.getElementById('path-browser-drawer');
        if (!drawer) return;
        if (drawer.style.display === 'none' || !drawer.style.display) {
            drawer.style.display = 'block';
            await this.loadServerBrowser(this._currentBrowserDir || '/');
        } else {
            drawer.style.display = 'none';
        }
    },

    async loadServerBrowser(dir = '/') {
        this._currentBrowserDir = dir;
        const pathEl = document.getElementById('browser-current-path');
        const container = document.getElementById('browser-entries-container');
        const upBtn = document.getElementById('btn-browser-up');

        if (pathEl) pathEl.innerText = dir;
        if (upBtn) upBtn.disabled = (dir === '/');

        if (!container) return;
        container.innerHTML = '<div style="font-size: 0.78rem; color: var(--text-muted); padding: 8px;">Lade Ordner…</div>';

        try {
            const res = await api.browsePaths(dir);
            if (res.success && Array.isArray(res.entries)) {
                this._browserParentDir = res.parent_dir;
                if (res.entries.length === 0) {
                    container.innerHTML = '<div style="font-size: 0.78rem; color: var(--text-muted); padding: 8px;">Keine Unterordner oder Dateien vorhanden.</div>';
                    return;
                }

                let html = '';
                for (const entry of res.entries) {
                    const icon = entry.is_dir ? '📁' : '📄';
                    const onclickAction = entry.is_dir 
                        ? `onclick="BorgGuard.loadServerBrowser('${UI.escapeHtml(entry.path)}')"`
                        : `onclick="BorgGuard.setNewPathInput('${UI.escapeHtml(entry.path)}')"`
                    
                    html += `
                        <div class="browser-entry-row" ${onclickAction}>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span>${icon}</span>
                                <span>${UI.escapeHtml(entry.name)}</span>
                            </div>
                            <button class="action-btn-small" onclick="event.stopPropagation(); BorgGuard.setNewPathInput('${UI.escapeHtml(entry.path)}')" style="font-size: 0.7rem; padding: 2px 6px;">
                                Übernehmen
                            </button>
                        </div>
                    `;
                }
                container.innerHTML = html;
            } else {
                container.innerHTML = `<div style="font-size: 0.78rem; color: var(--accent-red); padding: 8px;">Fehler: ${UI.escapeHtml(res.error || 'Konnte Ordner nicht lesen')}</div>`;
            }
        } catch (e) {
            container.innerHTML = `<div style="font-size: 0.78rem; color: var(--accent-red); padding: 8px;">Fehler: ${UI.escapeHtml(e.message)}</div>`;
        }
    },

    browseParentDir() {
        if (this._browserParentDir) {
            this.loadServerBrowser(this._browserParentDir);
        } else if (this._currentBrowserDir !== '/') {
            const parts = this._currentBrowserDir.split('/').filter(Boolean);
            parts.pop();
            const parent = '/' + parts.join('/');
            this.loadServerBrowser(parent || '/');
        }
    },

    selectCurrentBrowserPath() {
        if (this._currentBrowserDir) {
            this.setNewPathInput(this._currentBrowserDir);
        }
    },
};


window.onload = () => BorgGuard.init();
