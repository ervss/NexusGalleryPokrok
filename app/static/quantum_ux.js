/* ============================================
   QUANTUM UX ENHANCEMENTS - JAVASCRIPT MODULE
   10 Brutally Powerful UX Features
   ============================================ */

function createQuantumUXModule() {
    return {
        // ========== 1. INSTANT PREVIEW SCRUBBER ==========
        spriteScrubber: {
            currentVideo: null,
            spriteImage: null,
            frameWidth: 160,
            frameHeight: 90,
            cols: 10,
            rows: 10,
        },

        initSpriteScrubber(video) {
            if (!video.sprite_path) return;

            const card = document.querySelector(`[data-video-id="${video.id}"]`);
            if (!card) return;

            card.addEventListener('mousemove', (e) => {
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const progress = Math.max(0, Math.min(1, x / rect.width));

                this.updateSpriteFrame(video, progress, card);
            });
        },

        updateSpriteFrame(video, progress, card) {
            const totalFrames = this.spriteScrubber.cols * this.spriteScrubber.rows;
            const frameIndex = Math.floor(progress * (totalFrames - 1));

            const row = Math.floor(frameIndex / this.spriteScrubber.cols);
            const col = frameIndex % this.spriteScrubber.cols;

            // Update scrubber bar
            const scrubberFill = card.querySelector('.sprite-scrubber-fill');
            if (scrubberFill) {
                scrubberFill.style.width = `${progress * 100}%`;
            }

            // Update tooltip
            const tooltip = card.querySelector('.sprite-preview-tooltip');
            if (tooltip && video.duration) {
                const time = progress * video.duration;
                tooltip.textContent = this.formatTime(time);
            }

            // Update frame preview
            const preview = card.querySelector('.sprite-frame-preview canvas');
            if (preview && video.sprite_path) {
                const ctx = preview.getContext('2d');
                const img = new Image();
                img.src = video.sprite_path;
                img.onload = () => {
                    const sx = col * this.spriteScrubber.frameWidth;
                    const sy = row * this.spriteScrubber.frameHeight;
                    ctx.drawImage(img, sx, sy, this.spriteScrubber.frameWidth,
                                  this.spriteScrubber.frameHeight, 0, 0,
                                  preview.width, preview.height);
                };
            }
        },

        // ========== 2. SMART BATCH QUEUE SYSTEM ==========
        batchQueue: {
            download: [],
            favorite: [],
            delete: [],
            refresh: []
        },

        batchQueueOpen: false,

        toggleBatchQueue() {
            this.batchQueueOpen = !this.batchQueueOpen;
        },

        addToBatchQueue(video, action) {
            if (!this.batchQueue[action].find(v => v.id === video.id)) {
                this.batchQueue[action].push(video);
                this.showToast(`Added to ${action} queue`, 'success');
            }
        },

        removeFromBatchQueue(videoId, action) {
            this.batchQueue[action] = this.batchQueue[action].filter(v => v.id !== videoId);
        },

        getBatchQueueCount() {
            return Object.values(this.batchQueue).reduce((sum, queue) => sum + queue.length, 0);
        },

        clearBatchQueue() {
            this.batchQueue = { download: [], favorite: [], delete: [], refresh: [] };
        },

        async executeBatchQueue() {
            const totalItems = this.getBatchQueueCount();
            if (totalItems === 0) {
                this.showToast('Queue is empty', 'warning');
                return;
            }

            const confirmed = confirm(`Execute ${totalItems} queued actions?`);
            if (!confirmed) return;

            try {
                // Execute downloads
                for (const video of this.batchQueue.download) {
                    await this.downloadVideo(video.id);
                }

                // Execute favorites
                for (const video of this.batchQueue.favorite) {
                    await this.toggleFavorite(video.id);
                }

                // Execute deletes
                for (const video of this.batchQueue.delete) {
                    await this.deleteVideo(video.id);
                }

                // Execute refreshes
                for (const video of this.batchQueue.refresh) {
                    await this.refreshLink(video.id);
                }

                this.showToast(`Executed ${totalItems} actions successfully`, 'success');
                this.clearBatchQueue();
                this.batchQueueOpen = false;
                this.loadVideos(true);
            } catch (error) {
                console.error('Batch queue execution error:', error);
                this.showToast('Some actions failed', 'error');
            }
        },

        // Make video cards draggable
        makeCardDraggable(videoId) {
            const card = document.querySelector(`[data-video-id="${videoId}"]`);
            if (!card) return;

            card.setAttribute('draggable', 'true');

            card.addEventListener('dragstart', (e) => {
                card.classList.add('dragging');
                e.dataTransfer.setData('videoId', videoId);
                e.dataTransfer.effectAllowed = 'move';
            });

            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
            });
        },

        setupBatchQueueZones() {
            const zones = document.querySelectorAll('.batch-queue-zone');
            zones.forEach(zone => {
                zone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    zone.classList.add('drag-over');
                });

                zone.addEventListener('dragleave', () => {
                    zone.classList.remove('drag-over');
                });

                zone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    zone.classList.remove('drag-over');

                    const videoId = parseInt(e.dataTransfer.getData('videoId'));
                    const action = zone.dataset.action;
                    const video = this.videos.find(v => v.id === videoId);

                    if (video && action) {
                        this.addToBatchQueue(video, action);
                    }
                });
            });
        },

        // ========== 3. DISCOVERY PROFILE DASHBOARD ==========
        discoveryProfiles: [],
        discoveryStats: {},

        async loadDiscoveryDashboard() {
            try {
                const response = await fetch('/api/v1/discovery/profiles');
                const data = await response.json();
                this.discoveryProfiles = data.profiles || [];

                // Load stats for each profile
                for (const profile of this.discoveryProfiles) {
                    await this.updateDiscoveryProfileStats(profile.id);
                }
            } catch (error) {
                console.error('Failed to load discovery dashboard:', error);
            }
        },

        async updateDiscoveryProfileStats(profileId) {
            try {
                const response = await fetch(`/api/v1/discovery/profiles/${profileId}/stats`);
                const data = await response.json();
                this.$set(this.discoveryStats, profileId, data);
            } catch (error) {
                console.error(`Failed to load stats for profile ${profileId}:`, error);
            }
        },

        async runDiscoveryProfile(profileId) {
            try {
                const response = await fetch(`/api/v1/discovery/profiles/${profileId}/run`, {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.status === 'success') {
                    this.showToast('Discovery started', 'success');
                    setTimeout(() => this.updateDiscoveryProfileStats(profileId), 2000);
                }
            } catch (error) {
                console.error('Failed to run discovery profile:', error);
                this.showToast('Failed to start discovery', 'error');
            }
        },

        async reviewDiscoveryMatches(profileId) {
            try {
                const response = await fetch(`/api/v1/discovery/profiles/${profileId}/matches`);
                const data = await response.json();

                // Open review modal with matches
                this.openDiscoveryReviewModal(data.matches);
            } catch (error) {
                console.error('Failed to load matches:', error);
            }
        },

        // ========== 4. KEYBOARD-FIRST POWER USER MODE ==========
        commandPaletteOpen: false,
        commandPaletteQuery: '',
        commandPaletteSelected: 0,

        commands: [
            { id: 'search', title: 'Search Videos', desc: 'Find videos in library', icon: '🔍', shortcut: 'Ctrl+F', action: 'focusSearch' },
            { id: 'import', title: 'Quick Import', desc: 'Import from URL', icon: '📥', shortcut: 'Ctrl+I', action: 'openImport' },
            { id: 'favorite', title: 'Toggle Favorite', desc: 'Add/remove from favorites', icon: '⭐', shortcut: 'F', action: 'toggleFavoriteSelected' },
            { id: 'delete', title: 'Delete Selected', desc: 'Delete selected videos', icon: '🗑️', shortcut: 'DD', action: 'deleteSelected' },
            { id: 'refresh', title: 'Refresh Links', desc: 'Update broken links', icon: '🔄', shortcut: 'R', action: 'refreshAllLinks' },
            { id: 'discovery', title: 'Discovery Dashboard', desc: 'View auto-discovery status', icon: '🎯', shortcut: 'Ctrl+D', action: 'openDiscoveryDashboard' },
            { id: 'health', title: 'Health Monitor', desc: 'Check link health', icon: '💊', shortcut: 'Ctrl+H', action: 'openHealthDashboard' },
            { id: 'duplicates', title: 'Find Duplicates', desc: 'Scan for duplicate videos', icon: '👯', shortcut: 'Ctrl+Shift+D', action: 'scanDuplicates' },
            { id: 'grid', title: 'Grid View', desc: 'Switch to grid layout', icon: '▦', shortcut: 'G', action: 'setViewMode:grid' },
            { id: 'flow', title: 'Flow View', desc: 'Switch to flow layout', icon: '≋', shortcut: 'Q', action: 'setViewMode:flow' },
            { id: 'god', title: 'God Mode', desc: 'Mission control view', icon: '👁️', shortcut: 'Ctrl+G', action: 'setViewMode:god' },
        ],

        initKeyboardShortcuts() {
            let keySequence = '';
            let sequenceTimer = null;

            document.addEventListener('keydown', (e) => {
                // Command palette (/)
                if (e.key === '/' && !this.isInputFocused()) {
                    e.preventDefault();
                    this.openCommandPalette();
                    return;
                }

                // Close modals (Esc)
                if (e.key === 'Escape') {
                    this.closeAllModals();
                    return;
                }

                // Navigation (j/k)
                if (!this.isInputFocused()) {
                    if (e.key === 'j') {
                        e.preventDefault();
                        this.navigateGrid('down');
                    } else if (e.key === 'k') {
                        e.preventDefault();
                        this.navigateGrid('up');
                    } else if (e.key === 'h') {
                        e.preventDefault();
                        this.navigateGrid('left');
                    } else if (e.key === 'l') {
                        e.preventDefault();
                        this.navigateGrid('right');
                    }
                }

                // Selection (x)
                if (e.key === 'x' && !this.isInputFocused()) {
                    e.preventDefault();
                    this.toggleCurrentSelection();
                }

                // View modes
                if (e.key === 'g' && !this.isInputFocused()) {
                    if (keySequence === 'g') {
                        this.scrollToTop();
                        keySequence = '';
                    } else {
                        keySequence = 'g';
                        setTimeout(() => keySequence = '', 1000);
                    }
                }

                if (e.key === 'G' && e.shiftKey && !this.isInputFocused()) {
                    this.scrollToBottom();
                }

                // Delete sequence (dd)
                if (e.key === 'd' && !this.isInputFocused()) {
                    if (keySequence === 'd') {
                        this.deleteSelected();
                        keySequence = '';
                    } else {
                        keySequence = 'd';
                        setTimeout(() => keySequence = '', 1000);
                    }
                }

                // Favorite (ff)
                if (e.key === 'f' && !this.isInputFocused()) {
                    if (keySequence === 'f') {
                        this.toggleFavoriteSelected();
                        keySequence = '';
                    } else {
                        keySequence = 'f';
                        setTimeout(() => keySequence = '', 1000);
                    }
                }

                // Ctrl combinations
                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 'k') {
                        e.preventDefault();
                        this.openCommandPalette();
                    } else if (e.key === 'd') {
                        e.preventDefault();
                        this.openDiscoveryDashboard();
                    } else if (e.key === 'h') {
                        e.preventDefault();
                        this.openHealthDashboard();
                    }
                }
            });

            // Command palette navigation
            document.addEventListener('keydown', (e) => {
                if (!this.commandPaletteOpen) return;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.commandPaletteSelected = Math.min(this.commandPaletteSelected + 1, this.getFilteredCommands().length - 1);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.commandPaletteSelected = Math.max(this.commandPaletteSelected - 1, 0);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    this.executeCommand(this.getFilteredCommands()[this.commandPaletteSelected]);
                }
            });
        },

        openCommandPalette() {
            this.commandPaletteOpen = true;
            this.commandPaletteQuery = '';
            this.commandPaletteSelected = 0;
            this.$nextTick(() => {
                const input = document.querySelector('.command-palette-input');
                if (input) input.focus();
            });
        },

        closeCommandPalette() {
            this.commandPaletteOpen = false;
        },

        getFilteredCommands() {
            if (!this.commandPaletteQuery) return this.commands;
            const query = this.commandPaletteQuery.toLowerCase();
            return this.commands.filter(cmd =>
                cmd.title.toLowerCase().includes(query) ||
                cmd.desc.toLowerCase().includes(query)
            );
        },

        executeCommand(command) {
            if (!command) return;

            this.closeCommandPalette();

            const [action, param] = command.action.split(':');

            if (typeof this[action] === 'function') {
                this[action](param);
            }
        },

        isInputFocused() {
            const active = document.activeElement;
            return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
        },

        navigateGrid(direction) {
            // TODO: Implement grid navigation
            console.log('Navigate:', direction);
        },

        scrollToTop() {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        scrollToBottom() {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        },

        // ========== 5. SMART TAG AUTO-COMPLETE + TAG CLOUD ==========
        tagCloud: [],
        tagAutocomplete: [],
        showTagAutocomplete: false,

        async loadTagCloud() {
            try {
                const response = await fetch('/api/tags/cloud');
                const data = await response.json();
                this.tagCloud = data.tags || [];
            } catch (error) {
                console.error('Failed to load tag cloud:', error);
            }
        },

        async searchTags(query) {
            if (!query || query.length < 2) {
                this.showTagAutocomplete = false;
                return;
            }

            try {
                const response = await fetch(`/api/tags/search?q=${encodeURIComponent(query)}`);
                const data = await response.json();
                this.tagAutocomplete = data.tags || [];
                this.showTagAutocomplete = this.tagAutocomplete.length > 0;
            } catch (error) {
                console.error('Tag search error:', error);
            }
        },

        selectTag(tag) {
            // Add tag to current video or filter
            this.filters.search = tag;
            this.loadVideos(true);
            this.showTagAutocomplete = false;
        },

        getTagSize(count) {
            // Calculate font size based on tag frequency
            const maxCount = Math.max(...this.tagCloud.map(t => t.count));
            const minSize = 12;
            const maxSize = 28;
            return minSize + ((count / maxCount) * (maxSize - minSize));
        },

        // ========== 6. LINK HEALTH DASHBOARD ==========
        healthStats: null,
        healthSources: [],
        healthUnknownDomains: [],

        async loadHealthDashboard() {
            try {
                const response = await fetch('/api/health/stats');
                const data = await response.json();
                this.healthStats = data;

                // Load per-source stats (includes unknown_domains backlog for new sites)
                const sourcesResponse = await fetch('/api/health/sources');
                const sourcesData = await sourcesResponse.json();
                this.healthSources = sourcesData.sources || [];
                this.healthUnknownDomains = sourcesData.unknown_domains || [];
            } catch (error) {
                console.error('Failed to load health dashboard:', error);
            }
        },

        async refreshAllBrokenLinks() {
            const confirmed = confirm('Refresh all broken links? This may take a while.');
            if (!confirmed) return;

            try {
                const response = await fetch('/api/health/refresh-broken', {
                    method: 'POST'
                });
                const data = await response.json();

                this.showToast(`Refreshing ${data.count} broken links...`, 'info');

                // Reload dashboard after refresh
                setTimeout(() => this.loadHealthDashboard(), 5000);
            } catch (error) {
                console.error('Failed to refresh broken links:', error);
                this.showToast('Refresh failed', 'error');
            }
        },

        getHealthScoreClass(score) {
            if (score >= 95) return 'excellent';
            if (score >= 80) return 'good';
            if (score >= 60) return 'fair';
            return 'poor';
        },

        // ========== 7. ADAPTIVE QUALITY BADGING ==========
        getQualityBadgeClass(video) {
            const height = video.height || 0;
            const linkStatus = video.link_status || 'unknown';
            const lastChecked = video.last_checked;
            const daysSinceCheck = lastChecked ?
                Math.floor((Date.now() - new Date(lastChecked).getTime()) / (1000 * 60 * 60 * 24)) : 999;

            if (height <= 0) {
                return 'q-unknown';
            }

            if (height >= 2160) {
                return linkStatus === 'working' ? 'q-4k verified' : 'q-4k';
            } else if (height >= 1080) {
                return daysSinceCheck > 7 ? 'q-1080p needs-check' : 'q-1080p';
            } else if (height >= 720) {
                return 'q-720p';
            }
            return 'q-sd';
        },

        getQualityBadgeText(video) {
            const height = video.height || 0;
            if (height <= 0) return 'Unknown';
            if (height >= 2160) return '4K';
            if (height >= 1440) return '1440p';
            if (height >= 1080) return '1080p';
            if (height >= 720) return '720p';
            if (height >= 480) return '480p';
            return 'SD';
        },

        getDownloadSpeed(video) {
            if (!video.download_stats) return null;
            const stats = typeof video.download_stats === 'string' ?
                JSON.parse(video.download_stats) : video.download_stats;
            return stats.avg_speed_mb ? `${stats.avg_speed_mb.toFixed(1)} MB/s` : null;
        },

        // ========== 8. QUANTUM FLOW SEARCH-TO-PLAY ==========
        quantumFlowActive: false,
        quantumFlowQuery: '',
        quantumFlowResults: [],

        openQuantumFlow() {
            this.quantumFlowActive = true;
            this.$nextTick(() => {
                const input = document.querySelector('.quantum-flow-input');
                if (input) input.focus();
            });
        },

        closeQuantumFlow() {
            this.quantumFlowActive = false;
            this.quantumFlowQuery = '';
            this.quantumFlowResults = [];
        },

        async searchQuantumFlow() {
            if (!this.quantumFlowQuery || this.quantumFlowQuery.length < 2) {
                this.quantumFlowResults = [];
                return;
            }

            try {
                const response = await fetch(`/api/search?q=${encodeURIComponent(this.quantumFlowQuery)}&limit=20`);
                const data = await response.json();
                this.quantumFlowResults = data.videos || [];
            } catch (error) {
                console.error('Quantum flow search error:', error);
            }
        },

        playQuantumFlowVideo(video) {
            this.closeQuantumFlow();
            this.playVideo(video);
        },

        // ========== 9. SMART DUPLICATE RESOLVER ==========
        duplicateResolverOpen: false,
        currentDuplicatePair: null,

        async scanDuplicates() {
            try {
                this.showToast('Scanning for duplicates...', 'info');

                const response = await fetch('/api/duplicates/scan', {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.duplicates && data.duplicates.length > 0) {
                    this.showToast(`Found ${data.duplicates.length} duplicate pairs`, 'success');
                    this.openDuplicateResolver(data.duplicates[0]);
                } else {
                    this.showToast('No duplicates found', 'success');
                }
            } catch (error) {
                console.error('Duplicate scan error:', error);
                this.showToast('Scan failed', 'error');
            }
        },

        openDuplicateResolver(duplicatePair) {
            this.currentDuplicatePair = duplicatePair;
            this.duplicateResolverOpen = true;
        },

        closeDuplicateResolver() {
            this.duplicateResolverOpen = false;
            this.currentDuplicatePair = null;
        },

        async keepDuplicate(side) {
            if (!this.currentDuplicatePair) return;

            const keepId = side === 'left' ?
                this.currentDuplicatePair.original_id :
                this.currentDuplicatePair.duplicate_id;

            const deleteId = side === 'left' ?
                this.currentDuplicatePair.duplicate_id :
                this.currentDuplicatePair.original_id;

            try {
                await this.deleteVideo(deleteId);
                this.showToast('Duplicate resolved', 'success');
                this.closeDuplicateResolver();
                this.loadVideos(true);
            } catch (error) {
                console.error('Failed to resolve duplicate:', error);
                this.showToast('Resolution failed', 'error');
            }
        },

        async keepBothDuplicates() {
            this.showToast('Kept both videos', 'info');
            this.closeDuplicateResolver();
        },

        compareDuplicateField(field) {
            if (!this.currentDuplicatePair) return null;

            const original = this.currentDuplicatePair.original;
            const duplicate = this.currentDuplicatePair.duplicate;

            const ov = original[field];
            const dv = duplicate[field];
            if (ov === dv) return 'equal';
            if (ov > dv) return 'original-better';
            return 'duplicate-better';
        },

        // ========== 10. SESSION PERSISTENCE ==========
        sessionData: null,
        showSessionRestore: false,

        saveSession() {
            const session = {
                filters: { ...this.filters },
                scrollPosition: window.scrollY,
                viewMode: this.viewMode,
                selectedVideos: this.selectedVideos || [],
                batchQueue: { ...this.batchQueue },
                timestamp: Date.now()
            };

            localStorage.setItem('nexus_session', JSON.stringify(session));
        },

        loadSession() {
            const saved = localStorage.getItem('nexus_session');
            if (!saved) return;

            try {
                const session = JSON.parse(saved);
                const age = Date.now() - session.timestamp;

                // Only restore if less than 24 hours old
                if (age < 24 * 60 * 60 * 1000) {
                    this.sessionData = session;
                    this.showSessionRestore = true;
                }
            } catch (error) {
                console.error('Failed to load session:', error);
            }
        },

        restoreSession() {
            if (!this.sessionData) return;

            this.filters = { ...this.sessionData.filters };
            this.viewMode = this.sessionData.viewMode;
            this.selectedVideos = this.sessionData.selectedVideos || [];
            this.batchQueue = { ...this.sessionData.batchQueue };

            this.loadVideos(true);

            this.$nextTick(() => {
                window.scrollTo(0, this.sessionData.scrollPosition || 0);
            });

            this.showSessionRestore = false;
            this.showToast('Session restored', 'success');
        },

        dismissSessionRestore() {
            this.showSessionRestore = false;
            localStorage.removeItem('nexus_session');
        },

        updateVideoProgress(videoId, currentTime, duration) {
            const progress = (currentTime / duration) * 100;
            const progressData = JSON.parse(localStorage.getItem('nexus_video_progress') || '{}');
            progressData[videoId] = { currentTime, duration, progress, updated: Date.now() };
            localStorage.setItem('nexus_video_progress', JSON.stringify(progressData));
        },

        getVideoProgress(videoId) {
            const progressData = JSON.parse(localStorage.getItem('nexus_video_progress') || '{}');
            return progressData[videoId] || null;
        },

        // ========== UTILITY METHODS ==========
        formatTime(seconds) {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);

            if (h > 0) {
                return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            }
            return `${m}:${s.toString().padStart(2, '0')}`;
        },

        showToast(message, type = 'info') {
            // Simple toast notification
            console.log(`[${type.toUpperCase()}] ${message}`);
            // TODO: Implement actual toast UI
        },

        closeAllModals() {
            this.commandPaletteOpen = false;
            this.quantumFlowActive = false;
            this.duplicateResolverOpen = false;
            this.batchQueueOpen = false;
        },

        // Initialize all UX features
        initQuantumUX() {
            console.log('🚀 Initializing Quantum UX Features...');

            // Load session
            this.loadSession();

            // Init keyboard shortcuts
            this.initKeyboardShortcuts();

            // Load tag cloud
            this.loadTagCloud();

            // Setup batch queue zones
            this.$nextTick(() => {
                this.setupBatchQueueZones();
            });

            // Auto-save session every 30 seconds
            setInterval(() => this.saveSession(), 30000);

            // Save session before page unload
            window.addEventListener('beforeunload', () => this.saveSession());

            console.log('✅ Quantum UX initialized');
        }
    };
}
