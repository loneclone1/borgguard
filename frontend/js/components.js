// frontend/js/components.js

const UI = {
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        if (!bytes || isNaN(bytes)) return '—';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },
    
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const span = document.createElement('span');
        span.innerText = message;
        toast.appendChild(span);
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },
    
    renderArchivesTable(archives) {
        const tbody = document.getElementById('snapshots-tbody');
        if (!tbody) return;
        
        if (!archives || archives.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>Keine Snapshots gefunden.</p></div></td></tr>`;
            return;
        }
        
        let html = '';
        archives.sort((a, b) => new Date(b.start) - new Date(a.start));
        
        for (const arch of archives) {
            const date = arch.start ? new Date(arch.start).toLocaleString('de-DE') : 'Unbekannt';
            
            html += `
            <tr>
                <td><strong>${arch.name}</strong></td>
                <td class="date-cell">${date}</td>
                <td class="size-cell" id="size-${arch.name}">—</td>
                <td style="text-align:right;">
                    <button class="action-btn-small" onclick="BorgGuard.openGoogleDrive()" title="In Google Drive öffnen">☁️ Google Drive</button>
                </td>
            </tr>`;
        }
        tbody.innerHTML = html;
    },
    
    renderServices(summary) {
        const container = document.getElementById('services-body');
        const statusEl = document.getElementById('services-status');
        let html = '';
        
        const renderGroup = (key, data) => {
            if (!data || !data.containers || data.containers.length === 0) return '';
            const statusIcon = data.healthy ? '<span class="status-dot online"></span>' : '<span class="status-dot offline"></span>';
            const version = data.version && data.version !== '—' ? `<span class="version-badge">${data.version}</span>` : '';
            
            let updateBtn = '';
            if (data.project_id && data.project_id !== 'other') {
                updateBtn = `<button onclick="event.stopPropagation(); BorgGuard.updateProject('${data.project_id}')" title="Ganzes Projekt '${data.name}' updaten (pull & up)" class="action-btn-small" style="background:var(--accent-cyan);color:var(--terminal-bg);border:none;margin-left:10px;">⬇️ Update</button>`;
            }
            
            let groupHtml = `<div class="service-group">
                <div class="service-group-header" style="display:flex; align-items:center;" onclick="UI.toggleServiceGroup(this)">
                    <span class="group-toggle-icon collapsed" style="margin-right: 6px;">▼</span>
                    ${statusIcon} ${data.name} ${version}
                    <div style="flex:1"></div>
                    ${updateBtn}
                </div>
                <ul class="service-list collapsed">`;
                
            for (const c of data.containers) {
                const stateClass = c.state === 'running' ? 'running' : (c.state === 'exited' ? 'stopped' : 'warning');
                const actions = `
                    <div class="service-actions" style="display:flex; gap: 5px;">
                        <button onclick="BorgGuard.serviceAction('${c.name}', 'start')" title="Starten" class="action-btn-small">▶️</button>
                        <button onclick="BorgGuard.serviceAction('${c.name}', 'stop')" title="Stoppen" class="action-btn-small">⏹️</button>
                        <button onclick="BorgGuard.serviceAction('${c.name}', 'restart')" title="Neustarten" class="action-btn-small">🔄</button>
                    </div>`;
                    
                const versionSpan = (c.version && c.version !== '—' && c.version !== 'unknown') ? `<span class="version-badge" style="font-size:0.7rem; padding: 2px 6px; margin-left: 8px; opacity: 0.8;">${c.version}</span>` : '';
                    
                groupHtml += `
                <li class="service-item">
                    <div class="service-name">${c.name} ${versionSpan}</div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span class="service-status ${stateClass}">${c.state}</span>
                        ${actions}
                    </div>
                </li>`;
            }
            groupHtml += `</ul></div>`;
            return groupHtml;
        };
        
        const keys = Object.keys(summary).filter(k => k !== 'other');
        keys.sort();
        if (summary.other) keys.push('other');
        
        let allHealthy = true;
        for (const k of keys) {
            html += renderGroup(k, summary[k]);
            if (!summary[k].healthy) allHealthy = false;
        }
        
        container.innerHTML = html || '<div class="empty-state"><p>Keine Container gefunden.</p></div>';
        
        if (statusEl) {
            statusEl.innerText = allHealthy ? 'Online' : 'Warnung';
            statusEl.style.color = allHealthy ? 'var(--accent-green)' : 'var(--accent-orange)';
        }
    },
    
    toggleServiceGroup(headerEl) {
        const icon = headerEl.querySelector('.group-toggle-icon');
        const list = headerEl.nextElementSibling;
        if (list && list.classList.contains('service-list')) {
            list.classList.toggle('collapsed');
            if (icon) icon.classList.toggle('collapsed');
        }
    },
    
    renderServerOverview(data) {
        const container = document.getElementById('server-body');
        if (!container) return;
        if (!data || !data.system || !data.hardware) {
            container.innerHTML = '<div class="empty-state"><p>Keine Serverdaten verfügbar.</p></div>';
            return;
        }

        const sys = data.system;
        const hw = data.hardware;

        const ramUsedGB = (hw.ram_used / 1024**3).toFixed(1);
        const ramTotalGB = (hw.ram_total / 1024**3).toFixed(1);
        const diskUsedGB = (hw.disk_used / 1024**3).toFixed(1);
        const diskTotalGB = (hw.disk_total / 1024**3).toFixed(1);
        const diskFreeGB = (hw.disk_free / 1024**3).toFixed(1);

        const cpuColor = hw.cpu_percent > 80 ? 'var(--accent-red)' : 'var(--accent-cyan)';
        const ramColor = hw.ram_percent > 80 ? 'var(--accent-red)' : 'var(--accent-cyan)';
        const diskColor = hw.disk_percent > 80 ? 'var(--accent-orange)' : 'var(--accent-green)';

        let html = `
            <div style="display:flex; flex-direction:column; gap:var(--space-md);">
                <div style="background:hsla(220, 20%, 12%, 0.4); padding:var(--space-sm) var(--space-md); border-radius:var(--radius-sm); border:1px solid var(--glass-border);">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.05em; font-weight: 600;">System</div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="color:var(--text-primary); font-size: 0.95rem;">${this.escapeHtml(sys.hostname)}</strong>
                        <span style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-muted);">${this.escapeHtml(sys.ip)}</span>
                    </div>
                    <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:2px;">${this.escapeHtml(sys.os)}</div>
                </div>

                <div style="display:flex; flex-direction:column; gap:14px; margin-top:8px;">
                    <!-- CPU -->
                    <div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.85rem;">
                            <span style="color:var(--text-secondary);">CPU (${hw.cpu_cores} Cores)</span>
                            <span style="color:${cpuColor}; font-weight:600; font-family:var(--font-mono);">${hw.cpu_percent.toFixed(1)}%</span>
                        </div>
                        <div style="width:100%; background:hsla(220, 20%, 20%, 0.3); height:6px; border-radius:3px; overflow:hidden;">
                            <div style="width:${hw.cpu_percent}%; background:${cpuColor}; height:100%; transition:width var(--transition-normal);"></div>
                        </div>
                    </div>

                    <!-- RAM -->
                    <div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.85rem;">
                            <span style="color:var(--text-secondary);">RAM (${ramUsedGB} / ${ramTotalGB} GB)</span>
                            <span style="color:${ramColor}; font-weight:600; font-family:var(--font-mono);">${hw.ram_percent.toFixed(1)}%</span>
                        </div>
                        <div style="width:100%; background:hsla(220, 20%, 20%, 0.3); height:6px; border-radius:3px; overflow:hidden;">
                            <div style="width:${hw.ram_percent}%; background:${ramColor}; height:100%; transition:width var(--transition-normal);"></div>
                        </div>
                    </div>

                    <!-- Disk -->
                    <div>
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.85rem;">
                            <span style="color:var(--text-secondary);">Festplatte (${diskUsedGB} / ${diskTotalGB} GB belegt)</span>
                            <span style="color:${diskColor}; font-weight:600; font-family:var(--font-mono);">${hw.disk_percent.toFixed(1)}%</span>
                        </div>
                        <div style="width:100%; background:hsla(220, 20%, 20%, 0.3); height:6px; border-radius:3px; overflow:hidden;">
                            <div style="width:${hw.disk_percent}%; background:${diskColor}; height:100%; transition:width var(--transition-normal);"></div>
                        </div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px; text-align:right;">Frei: ${diskFreeGB} GB</div>
                    </div>`;
                    
        if (hw.extra_mounts && hw.extra_mounts.length > 0) {
            for (const mount of hw.extra_mounts) {
                if (mount.mountpoint === '/') continue; // skip root, already shown
                if (mount.mountpoint === '/app/logs') continue; // hide /app/logs volume
                const mUsedGB = (mount.used / 1024**3).toFixed(1);
                const mTotalGB = (mount.total / 1024**3).toFixed(1);
                const mFreeGB = (mount.free / 1024**3).toFixed(1);
                const mColor = mount.percent > 80 ? 'var(--accent-orange)' : 'var(--accent-green)';
                
                html += `
                    <div style="margin-top:4px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.85rem;">
                            <span style="color:var(--text-secondary);"><span title="Mountpoint">📁</span> ${this.escapeHtml(mount.mountpoint)} (${mUsedGB} / ${mTotalGB} GB)</span>
                            <span style="color:${mColor}; font-weight:600; font-family:var(--font-mono);">${mount.percent.toFixed(1)}%</span>
                        </div>
                        <div style="width:100%; background:hsla(220, 20%, 20%, 0.3); height:6px; border-radius:3px; overflow:hidden;">
                            <div style="width:${mount.percent}%; background:${mColor}; height:100%; transition:width var(--transition-normal);"></div>
                        </div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px; text-align:right;">Frei: ${mFreeGB} GB</div>
                    </div>`;
            }
        }
        
        html += `
                </div>
            </div>
        `;
        
        container.innerHTML = html;
    },
    
    renderLogs(content, containerId) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = content.map(line => {
            let className = 'log-line';
            const l = line.toLowerCase();
            if (l.includes('error') || l.includes('failed') || l.includes('exception')) className += ' error';
            else if (l.includes('warn')) className += ' warning';
            else if (l.includes('success') || l.includes('completed') || l.includes('erfolgreich')) className += ' success';
            else if (l.includes('info') || l.includes('started') || l.includes('gestartet')) className += ' info';

            let lineHtml = this.escapeHtml(line);
            // Highlight timestamps e.g. [2026-07-29 16:06:12] or [16:06:12]
            lineHtml = lineHtml.replace(/^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]|\[\d{2}:\d{2}:\d{2}\])/, '<span class="log-timestamp">$1</span>');

            return `<div class="${className}">${lineHtml}</div>`;
        }).join('');
        el.scrollTop = el.scrollHeight;
    },
    
    renderArchiveFiles(files) {
        const table = document.getElementById('archive-files-table');
        const tbody = document.getElementById('archive-files-tbody');
        const loading = document.getElementById('archive-loading');
        
        if (!files || files.length === 0) {
            loading.style.display = 'block';
            loading.innerHTML = '<p>Der Snapshot ist leer oder konnte nicht gelesen werden.</p>';
            table.style.display = 'none';
            return;
        }
        
        loading.style.display = 'none';
        table.style.display = 'table';
        
        let html = '';
        for (const file of files) {
            const date = new Date(file.mtime).toLocaleString('de-DE');
            const size = this.formatBytes(file.size);
            const type = file.type === 'd' ? '📁' : '📄';
            
            html += `
            <tr>
                <td>${type}</td>
                <td style="font-family: var(--font-mono); font-size: 0.8rem;">${file.mode}</td>
                <td class="size-cell">${size}</td>
                <td class="date-cell">${date}</td>
                <td style="word-break: break-all;">${this.escapeHtml(file.path)}</td>
            </tr>`;
        }
        tbody.innerHTML = html;
    },

    // ─── Progress Panel ──────────────────────────────────────────────────

    renderProgress(data) {
        const panel = document.getElementById('progress-panel');
        if (!panel) return;

        if (!data || !data.active) {
            panel.classList.remove('active');
            return;
        }

        panel.classList.add('active');

        const phaseEl = document.getElementById('progress-phase');
        const percentEl = document.getElementById('progress-percent');
        const barEl = document.getElementById('progress-bar');
        const detailEl = document.getElementById('progress-detail');
        const logEl = document.getElementById('progress-log');
        const jobTypeEl = document.getElementById('progress-job-type');

        const typeLabels = {
            'backup': '🔒 Backup',
            'check': '🔍 Integritätsprüfung',
            'prune': '🧹 Bereinigung',
            'compact': '📦 Komprimierung',
        };

        if (jobTypeEl) {
            jobTypeEl.innerText = typeLabels[data.job_type] || data.job_type;
        }

        if (phaseEl) {
            phaseEl.innerText = data.phase || data.progress_phase || 'Wird ausgeführt…';
        }

        const percent = data.percent !== undefined ? data.percent : (data.progress_percent !== undefined ? data.progress_percent : -1);

        if (percentEl && barEl) {
            if (percent >= 0 && percent <= 100) {
                percentEl.innerText = `${percent}%`;
                barEl.style.width = `${percent}%`;
                barEl.classList.remove('indeterminate');
            } else {
                percentEl.innerText = '';
                barEl.style.width = '100%';
                barEl.classList.add('indeterminate');
            }
        }

        if (detailEl) {
            const detail = data.detail || data.progress_detail || '';
            detailEl.innerText = detail;
            detailEl.style.display = detail ? 'block' : 'none';
        }

        // Render last output lines
        if (logEl && data.output_lines && data.output_lines.length > 0) {
            const lines = data.output_lines.slice(-15);
            logEl.innerHTML = lines.map(l => `<div class="log-line">${this.escapeHtml(l)}</div>`).join('');
            logEl.scrollTop = logEl.scrollHeight;
            logEl.style.display = 'block';
        }
    },

    hideProgress() {
        const panel = document.getElementById('progress-panel');
        if (panel) panel.classList.remove('active');
    },

    // ─── Storage Overview ────────────────────────────────────────────────

    renderStorageOverview(data) {
        const content = document.getElementById('storage-modal-content');
        if (!content) return;

        if (!data || !data.success) {
            content.innerHTML = `<div class="empty-state"><p>Speicherinformationen konnten nicht geladen werden.</p><p style="color:var(--accent-red);font-size:0.85rem;">${this.escapeHtml(data?.error || '')}</p></div>`;
            return;
        }

        let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:var(--space-md);">
            <div>
                <strong style="color:var(--text-primary); font-size:1.05rem;">Konfigurierte Sicherungsorte (${data.repository_count || (data.repositories ? data.repositories.length : 1)})</strong>
            </div>
            <button class="action-btn primary" onclick="BorgGuard.openAddRepoModal()" style="padding:6px 12px; font-size:0.85rem;">
                <span class="btn-icon">➕</span> Sicherungsort hinzufügen
            </button>
        </div>`;

        const repos = data.repositories && data.repositories.length > 0 ? data.repositories : [{
            label: 'gdrive-backup',
            name: 'Google Drive (rclone)',
            type: 'gdrive',
            path: data.location || '/var/backups/borg_repo',
            limit_gb: data.limit_gb || 1000,
            used_bytes: data.used_bytes || 0,
            used_percent: data.used_percent || 0,
            free_bytes: data.free_bytes || 0,
            total_size: data.total_size || 0,
            archive_count: data.archive_count || 0,
        }];

        html += `<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:15px; margin-bottom:var(--space-lg);">`;

        for (const repo of repos) {
            const usedGB = (repo.used_bytes / 1024 / 1024 / 1024).toFixed(2);
            const freeGB = (repo.free_bytes / 1024 / 1024 / 1024).toFixed(2);
            const limitGB = repo.limit_gb;
            const usedPct = repo.used_percent;
            const typeIcon = repo.type === 'gdrive' ? '☁️' : (repo.type === 'hetzner' ? '🌩️' : (repo.type === 'ssh' ? '🔑' : '📁'));
            const pctColor = usedPct > 85 ? 'var(--accent-red)' : usedPct > 65 ? 'var(--accent-orange)' : 'var(--accent-cyan)';

            const radius = 35;
            const circumference = 2 * Math.PI * radius;
            const dashOffset = circumference - (usedPct / 100) * circumference;

            const repoDataStr = JSON.stringify(repo).replace(/'/g, "&apos;").replace(/"/g, "&quot;");

            html += `
            <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius-lg); padding:16px; display:flex; flex-direction:column; justify-between; position:relative;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                    <div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-size:1.2rem;">${typeIcon}</span>
                            <strong style="color:var(--text-primary); font-size:1rem;">${this.escapeHtml(repo.name)}</strong>
                        </div>
                        <span style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-secondary);">${this.escapeHtml(repo.label)}</span>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button onclick="BorgGuard.openEditRepoModal('${repoDataStr}')" title="Bearbeiten" class="action-btn-small" style="padding:4px 8px;">✏️</button>
                        ${repos.length > 1 ? `<button onclick="BorgGuard.deleteRepository('${this.escapeHtml(repo.label)}')" title="Löschen" class="action-btn-small" style="padding:4px 8px;">🗑️</button>` : ''}
                    </div>
                </div>

                <div style="display:flex; align-items:center; gap:15px; margin-top:5px; margin-bottom:10px;">
                    <div style="width:80px; height:80px; position:relative; flex-shrink:0;">
                        <svg viewBox="0 0 100 100" width="80" height="80">
                            <circle cx="50" cy="50" r="${radius}" fill="none" stroke="hsla(220,20%,20%,0.3)" stroke-width="9"/>
                            <circle cx="50" cy="50" r="${radius}" fill="none" stroke="${pctColor}" stroke-width="9"
                                stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
                                stroke-linecap="round" style="transform:rotate(-90deg);transform-origin:center;transition:stroke-dashoffset 1s ease;"/>
                        </svg>
                        <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column;">
                            <span style="font-size:1rem; font-weight:700; color:${pctColor}">${usedPct}%</span>
                        </div>
                    </div>
                    <div style="flex-grow:1; font-size:0.82rem; display:flex; flex-direction:column; gap:4px;">
                        <div style="display:flex; justify-content:space-between;">
                            <span style="color:var(--text-secondary)">Belegt:</span>
                            <strong style="color:${pctColor}">${usedGB} GB</strong>
                        </div>
                        <div style="display:flex; justify-content:space-between;">
                            <span style="color:var(--text-secondary)">Frei:</span>
                            <span style="color:var(--accent-green)">${freeGB} GB</span>
                        </div>
                        <div style="display:flex; justify-content:space-between;">
                            <span style="color:var(--text-secondary)">Limit:</span>
                            <span style="color:var(--text-primary)">${limitGB} GB</span>
                        </div>
                        <div style="display:flex; justify-content:space-between;">
                            <span style="color:var(--text-secondary)">Snapshots:</span>
                            <span style="color:var(--accent-purple)">${repo.archive_count || 0}</span>
                        </div>
                    </div>
                </div>

                <div style="background:rgba(0,0,0,0.2); padding:6px 10px; border-radius:var(--radius-md); font-family:var(--font-mono); font-size:0.75rem; color:var(--text-secondary); word-break:break-all;">
                    📍 ${this.escapeHtml(repo.path)}
                </div>
            </div>`;
        }

        html += `</div>`;

        // Archives section
        if (data.archives && data.archives.length > 0) {
            const sorted = [...data.archives].sort((a, b) => new Date(b.start) - new Date(a.start));
            html += `
            <div class="storage-archives-section">
                <h3 style="font-size:0.95rem; margin:var(--space-lg) 0 var(--space-md) 0; color:var(--text-primary);">📦 Snapshots (${data.archives.length})</h3>
                <table class="archive-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Datum</th>
                            <th>Original</th>
                            <th>Dedupliziert</th>
                            <th>Dateien</th>
                        </tr>
                    </thead>
                    <tbody>`;

            for (const arch of sorted) {
                const date = arch.start ? new Date(arch.start).toLocaleString('de-DE') : '—';
                const ogSize = arch.original_size ? this.formatBytes(arch.original_size, 1) : '—';
                const dedupSize = arch.deduplicated_size ? this.formatBytes(arch.deduplicated_size, 1) : '—';
                const nfiles = arch.nfiles || '—';

                html += `
                    <tr>
                        <td><a class="archive-link" onclick="BorgGuard.openArchive('${this.escapeHtml(arch.name)}')">${this.escapeHtml(arch.name)}</a></td>
                        <td class="date-cell">${date}</td>
                        <td class="size-cell">${ogSize}</td>
                        <td class="size-cell">${dedupSize}</td>
                        <td class="size-cell">${nfiles}</td>
                    </tr>`;
            }

            html += `</tbody></table></div>`;
        }

        content.innerHTML = html;
    },


    // ─── Schedule Modal ──────────────────────────────────────────────────

    renderScheduleConfig(cfg) {
        const enabled = cfg.enabled || false;
        const preset = cfg.preset || 'daily_03';
        const presets = cfg.presets || {};
        const useCustom = cfg.use_custom || false;
        const customCron = cfg.custom_cron || '';
        const options = cfg.options || {};
        const nextRun = cfg.next_run;
        const activeCron = cfg.active_cron || '';
        const activeLabel = cfg.active_label || '';

        // Toggle
        const toggleEl = document.getElementById('schedule-toggle');
        if (toggleEl) toggleEl.checked = enabled;

        // Info display
        const infoEl = document.getElementById('schedule-info');
        if (infoEl) {
            let infoHtml = '';
            if (enabled) {
                infoHtml += `<div class="schedule-info-row active"><span class="status-dot online"></span> Aktiv: ${this.escapeHtml(activeLabel)}</div>`;
                if (nextRun) {
                    const next = new Date(nextRun);
                    const now = new Date();
                    const diffMs = next - now;
                    let timeStr = next.toLocaleString('de-DE');
                    if (diffMs > 0) {
                        const diffH = Math.floor(diffMs / 1000 / 60 / 60);
                        const diffM = Math.floor((diffMs / 1000 / 60) % 60);
                        timeStr += diffH > 0 ? ` (in ${diffH}h ${diffM}m)` : ` (in ${diffM}m)`;
                    }
                    infoHtml += `<div class="schedule-info-row">⏭️ Nächstes Backup: ${timeStr}</div>`;
                }
            } else {
                infoHtml += `<div class="schedule-info-row"><span class="status-dot offline"></span> Automatische Backups sind deaktiviert</div>`;
            }
            if (cfg.last_scheduled_run) {
                infoHtml += `<div class="schedule-info-row" style="color:var(--text-secondary);font-size:0.82rem;">Letzter automatischer Lauf: ${new Date(cfg.last_scheduled_run).toLocaleString('de-DE')}</div>`;
            }
            infoEl.innerHTML = infoHtml;
        }

        // Preset buttons
        const presetsEl = document.getElementById('schedule-presets');
        if (presetsEl) {
            let presetsHtml = '';
            for (const [key, label] of Object.entries(presets)) {
                const isActive = !useCustom && preset === key;
                presetsHtml += `<button class="preset-btn${isActive ? ' active' : ''}" data-preset="${key}" onclick="BorgGuard.selectPreset('${key}')">${label}</button>`;
            }
            presetsEl.innerHTML = presetsHtml;
        }

        // Custom cron
        const customToggle = document.getElementById('schedule-custom-toggle');
        const customInput = document.getElementById('schedule-custom-cron');
        if (customToggle) customToggle.checked = useCustom;
        if (customInput) customInput.value = customCron;

        // Options
        const autoPruneEl = document.getElementById('schedule-auto-prune');
        const autoCheckEl = document.getElementById('schedule-auto-check');
        if (autoPruneEl) autoPruneEl.checked = options.auto_prune || false;
        if (autoCheckEl) autoCheckEl.checked = options.auto_check_weekly || false;
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.innerText = text;
        return div.innerHTML;
    }
};
