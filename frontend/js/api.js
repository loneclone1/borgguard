// api.js - Frontend API wrapper for BorgGuard
const api = {
    async fetchJSON(url, options = {}) {
        const response = await fetch(url, options);
        if (!response.ok) {
            let errorMsg = 'Netzwerkfehler';
            try {
                const err = await response.json();
                errorMsg = err.error || errorMsg;
            } catch (e) {}
            throw new Error(errorMsg);
        }
        return response.json();
    },

    async getStatus() { return this.fetchJSON('/api/status'); },
    async getArchives() { return this.fetchJSON('/api/archives'); },
    async getConfig() { return this.fetchJSON('/api/config'); },
    async getSchedule() { return this.fetchJSON('/api/schedule'); },
    async getServices() { return this.fetchJSON('/api/services'); },
    async getLogs(type) { 
        if (type === 'system') return this.fetchJSON('/api/logs/system/borgmatic?lines=100');
        return { content: ['Job logs werden via WebSocket gestreamt...'] }; 
    },
    
    async triggerBackup() { return this.fetchJSON('/api/backup/create', { method: 'POST' }); },
    async triggerCheck() { return this.fetchJSON('/api/backup/check', { method: 'POST' }); },
    async triggerPrune() { return this.fetchJSON('/api/backup/prune', { method: 'POST' }); },
    async triggerBreakLock() { return this.fetchJSON('/api/backup/break-lock', { method: 'POST' }); },
    
    async serviceAction(containerName, action) {
        return this.fetchJSON(`/api/services/${containerName}/${action}`, { method: 'POST' });
    },
    
    async updateProject(projectName) {
        return this.fetchJSON(`/api/services/project/${projectName}/update`, { method: 'POST' });
    },
    
    // ─── Kiosk Config ───────────────────────────────────────────────────
    async getKioskConfig() {
        return this.fetchJSON('/api/kiosk/config');
    },
    
    async saveKioskConfig(content) {
        return this.fetchJSON('/api/kiosk/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
    },


    async getSnapshotStats(archiveName) {
        return this.fetchJSON(`/api/archives/${archiveName}/stats`);
    },

    // ─── Storage ────────────────────────────────────────────────────────
    async getStorageOverview() {
        return this.fetchJSON('/api/storage/overview');
    },

    // ─── Scheduler ──────────────────────────────────────────────────────
    async getScheduleConfig() {
        return this.fetchJSON('/api/schedule/config');
    },

    async setScheduleConfig(data) {
        return this.fetchJSON('/api/schedule/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },

    async enableSchedule() {
        return this.fetchJSON('/api/schedule/enable', { method: 'POST' });
    },

    async disableSchedule() {
        return this.fetchJSON('/api/schedule/disable', { method: 'POST' });
    },

    // ─── Progress ───────────────────────────────────────────────────────
    async getCurrentProgress() {
        return this.fetchJSON('/api/jobs/current/progress');
    },

    // ─── Repositories / Sicherungsorte ──────────────────────────────────
    async getRepositories() {
        return this.fetchJSON('/api/repositories');
    },

    async addRepository(data) {
        return this.fetchJSON('/api/repositories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },

    async updateRepository(label, data) {
        return this.fetchJSON(`/api/repositories/${encodeURIComponent(label)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },

    async deleteRepository(label) {
        return this.fetchJSON(`/api/repositories/${encodeURIComponent(label)}`, {
            method: 'DELETE',
        });
    },

    // ─── Snapshot Explorer & Restore ────────────────────────────────────
    async getSnapshotFiles(snapshotId) {
        return this.fetchJSON(`/api/snapshots/${encodeURIComponent(snapshotId)}/files`);
    },

    getDownloadFileUrl(snapshotId, filePath) {
        return `/api/snapshots/${encodeURIComponent(snapshotId)}/download?path=${encodeURIComponent(filePath)}`;
    },

    async restoreSnapshot(snapshotId, targetDir = '/restore', includePaths = null) {
        return this.fetchJSON(`/api/snapshots/${encodeURIComponent(snapshotId)}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_dir: targetDir, include_paths: includePaths }),
        });
    },

    // ─── Snapshot Tagging (Feature 4) ───────────────────────────────────
    async updateSnapshotTags(snapshotId, action, tags) {
        return this.fetchJSON(`/api/snapshots/${encodeURIComponent(snapshotId)}/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action, tags: tags }),
        });
    },

    async removeSnapshotTag(snapshotId, tag) {
        return this.fetchJSON(`/api/snapshots/${encodeURIComponent(snapshotId)}/tags/${encodeURIComponent(tag)}`, {
            method: 'DELETE',
        });
    },

    // ─── Snapshot Diff & Find (Feature 2) ───────────────────────────────
    async diffSnapshots(snap1, snap2) {
        return this.fetchJSON(`/api/snapshots/diff?snap1=${encodeURIComponent(snap1)}&snap2=${encodeURIComponent(snap2)}`);
    },

    async findFiles(query) {
        return this.fetchJSON(`/api/snapshots/find?q=${encodeURIComponent(query)}`);
    },
};

