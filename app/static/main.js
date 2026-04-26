function composeDashboard(modules) {
    return modules.reduce((state, factory) => {
        const fragment = factory();
        if (fragment && typeof fragment === 'object') {
            const descriptors = Object.getOwnPropertyDescriptors(fragment);
            Object.defineProperties(state, descriptors);
        }
        return state;
    }, {});
}

function createCollectionModule() {
    return {
        videos: [],
        batches: [],
        batchesDetailed: [], // Detailed batch info with size and import date
        batchSort: 'name', // Batch sorting: 'name', 'newest', 'biggest'
        tags: [],
        recommendations: [],
        godModeVideos: [],
        liveWallVideos: [],
        currentTime: '00:00:00',
        godInterval: null,
        logs: [],
        filters: { search: '', batch: 'All', favoritesOnly: false, quality: 'All', durationMin: 0, durationMax: 3600, sort: 'date_desc', dateMin: null, dateMax: null },
        page: 1,
        hasMore: true,
        isLoading: false,
        hoverVideoId: null,
        previewTimeout: null,
        previewIndex: 0,
        showFilters: false,
        viewMode: 'grid', // grid, flow, nexus
        gridSize: localStorage.getItem('galleryGridSize') || 'md', // xs, sm, md, lg, xl
        showLabels: localStorage.getItem('galleryShowLabels') !== 'false',
        nexusdata: null,
        polling: null,

        // Formatting Helpers
        formatDuration(sec) {
            if (!sec) return '0:00';
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = Math.floor(sec % 60);
            if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            return `${m}:${s.toString().padStart(2, '0')}`;
        },

        formatImportDate(dateStr) {
            if (!dateStr) return '';
            try {
                const date = new Date(dateStr);
                const d = date.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const t = date.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
                return `${d}  ${t}`;
            } catch (e) {
                return dateStr;
            }
        },

        formatVideoSize(stats) {
            if (!stats) return '';
            try {
                const s = typeof stats === 'string' ? JSON.parse(stats) : stats;
                if (!s) return '';
                
                let mb = 0;
                if (s.size_mb) {
                    mb = parseFloat(s.size_mb);
                } else if (s.reported_size_bytes) {
                    mb = parseFloat(s.reported_size_bytes) / (1024 * 1024);
                }

                if (mb > 0) {
                    if (mb > 1024) return (mb / 1024).toFixed(1) + ' GB';
                    return Math.round(mb) + ' MB';
                }
            } catch(e) {}
            return '';
        },

        getQuality(h) {
            if (!h) return 'SD';
            if (h >= 2160) return '4K';
            if (h >= 1440) return '2K';
            if (h >= 1080) return 'FHD';
            if (h >= 720) return 'HD';
            return 'SD';
        },

        getQualityClass(h) {
            if (!h) return 'q-sd';
            if (h >= 2160) return 'q-4k';
            if (h >= 1440) return 'q-2k';
            if (h >= 1080) return 'q-1080p';
            if (h >= 720) return 'q-720p';
            return 'q-sd';
        },

        getQualityTitle(w, h) {
            if (!w || !h) return 'Unknown Resolution';
            return `${w} x ${h}`;
        },

        getStatusClass(status) {
            if (status === 'ready' || status === 'ready_to_stream') return 'status-ready';
            if (status === 'error') return 'status-error';
            return 'status-pending';
        },

        isNew(ts) {
            if (!ts) return false;
            const created = new Date(ts);
            const now = new Date();
            const diffDays = (now - created) / (1000 * 60 * 60 * 24);
            return diffDays < 2; // New if added in last 48 hours
        },

        // CORS Proxy helper - routes external URLs through backend proxy
        proxifyUrl(url) {
            if (!url || url.startsWith('/') || url.startsWith('blob:')) {
                return url; // Local URLs don't need proxy
            }
            // Avoid proxy-on-proxy loops for already proxied local URLs.
            if (url.includes('/api/v1/proxy?url=')) {
                return url;
            }
            if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
                return url;
            }

            // Whitelist: Eporner and Webshare don't need proxy
            if (url.includes('eporner.com') || url.includes('webshare')) {
                return url;
            }

            // All other external URLs go through image proxy
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return `/api/v1/proxy?url=${encodeURIComponent(url)}`;
            }

            return url;
        },

        getSourceName(url) {
            if (!url) return 'Unknown';
            const u = url.toLowerCase();
            if (u.includes('pixeldrain.com')) return 'Pixeldrain';
            if (u.includes('eporner.com')) return 'Eporner';
            if (u.includes('spankbang.com')) return 'Spankbang';
            if (u.includes('xvideos.com')) return 'XVideos';
            if (u.includes('bunkr')) return 'Bunkr';
            if (u.includes('gofile.io')) return 'Gofile';
            if (u.includes('erome.com')) return 'Erome';
            if (u.includes('hqporner.com')) return 'HQPorner';
            if (u.includes('rec-ur-bate.com') || u.includes('recurbate.com')) return 'Recurbate';
            if (u.includes('webshare.cz') || u.includes('wsfiles.cz') || u.startsWith('webshare:')) return 'Webshare';
            if (u.includes('reddit.com')) return 'Reddit';
            if (u.includes('pornone.com')) return 'PornOne';
            try {
                const domain = new URL(url).hostname.replace('www.', '');
                let s = domain.split('.')[0];
                return s.charAt(0).toUpperCase() + s.slice(1);
            } catch (e) {
                return 'External';
            }
        },

        setGridSize(size) {
            this.gridSize = size;
            localStorage.setItem('galleryGridSize', size);
        },

        toggleLabels() {
            this.showLabels = !this.showLabels;
            localStorage.setItem('galleryShowLabels', this.showLabels);
        },

        setViewMode(mode) {
            if (mode !== 'nexus' && this._nexusRaf) {
                cancelAnimationFrame(this._nexusRaf);
                this._nexusRaf = null;
            }
            this.viewMode = mode;
            if (mode === 'nexus') {
                this.$nextTick(() => this.initNexusGraph());
            } else if (mode === 'flow') {
                this.$nextTick(() => this.initFlowObserver());
            } else if (mode === 'god') {
                this.initGodMode();
            }
        },

        initGodMode() {
            // Populate Hex Grid (use current video list)
            this.godModeVideos = this.videos.slice(0, 50);

            // Populate Live Wall (random 4)
            if (this.videos.length > 0) {
                this.liveWallVideos = [...this.videos].sort(() => 0.5 - Math.random()).slice(0, 4);
            }

            if (this.godInterval) clearInterval(this.godInterval);
            this.godInterval = setInterval(() => {
                this.currentTime = new Date().toLocaleTimeString('en-GB', { hour12: false });

                // Randomly refresh one cam periodically
                if (Math.random() > 0.8 && this.videos.length > 4) {
                    const randIdx = Math.floor(Math.random() * 4);
                    const randVid = this.videos[Math.floor(Math.random() * this.videos.length)];
                    // ensure reactivity (Alpine sometimes needs help with array index setting)
                    let newArr = [...this.liveWallVideos];
                    newArr[randIdx] = randVid;
                    this.liveWallVideos = newArr;
                }
            }, 1000);
        },

        initFlowObserver() {
            // Observer for Query Flow auto-play
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const videoId = entry.target.dataset.id;
                        const video = this.videos.find(v => v.id == videoId);
                        if (video) {
                            // Auto play preview in flow mode
                            this.startPreview(video);
                        }
                    } else {
                        const videoId = entry.target.dataset.id;
                        // Stop preview if scrolled away
                        if (this.hoverVideoId == videoId) {
                            this.stopPreview();
                        }
                    }
                });
            }, { threshold: 0.6 });

            document.querySelectorAll('.flow-card').forEach(el => observer.observe(el));
        },

        initNexusGraph() {
            const canvas = document.getElementById('nexus-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;

            // Simple nodes
            const nodes = this.videos.slice(0, 50).map(v => ({
                id: v.id, x: Math.random() * canvas.width, y: Math.random() * canvas.height,
                vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
                title: v.title, color: this.settings.accentColor === 'green' ? '#4ade80' : '#a855f7'
            }));

            // Animation Loop
            const animate = () => {
                if (this.viewMode !== 'nexus') { this._nexusRaf = null; return; }
                ctx.fillStyle = 'rgba(15, 23, 42, 0.2)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Move nodes
                nodes.forEach(node => {
                    node.x += node.vx;
                    node.y += node.vy;
                    if (node.x < 0 || node.x > canvas.width) node.vx *= -1;
                    if (node.y < 0 || node.y > canvas.height) node.vy *= -1;
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, 4, 0, Math.PI * 2);
                    ctx.fillStyle = node.color;
                    ctx.fill();
                });

                // Connect close nodes — check each pair once (O(n²/2) not O(n²))
                for (let i = 0; i < nodes.length; i++) {
                    for (let j = i + 1; j < nodes.length; j++) {
                        const dx = nodes[i].x - nodes[j].x;
                        const dy = nodes[i].y - nodes[j].y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < 150) {
                            ctx.beginPath();
                            ctx.moveTo(nodes[i].x, nodes[i].y);
                            ctx.lineTo(nodes[j].x, nodes[j].y);
                            ctx.strokeStyle = `rgba(148, 163, 184, ${1 - dist / 150})`;
                            ctx.lineWidth = 0.5;
                            ctx.stroke();
                        }
                    }
                }
                this._nexusRaf = requestAnimationFrame(animate);
            };
            if (this._nexusRaf) cancelAnimationFrame(this._nexusRaf);
            this._nexusRaf = requestAnimationFrame(animate);
        },

        setTagFilter(tag) {
            this.filters.search = tag;
            this.loadVideos(true);
        },

        async loadVideos(reset = false) {
            if (reset) { this.videos = []; this.page = 1; this.hasMore = true; }
            if (this.isLoading && !reset) return;
            this.isLoading = true;

            const params = new URLSearchParams({ ...this.filters, page: this.page, limit: 10 });
            try {
                const res = await fetch(`/api/v1/videos?${params}`);
                const data = await res.json();
                if (data.length === 0) {
                    this.hasMore = false;
                } else {
                    // Filter out any null/undefined videos or videos missing critical properties
                    const validVideos = data.filter(v => v && v.id && v.title);
                    const newItems = validVideos.filter(n => !this.videos.some(e => e.id === n.id));
                    this.videos = reset ? validVideos : [...this.videos, ...newItems];
                    this.page++;
                }
            } catch (e) {
                console.error('Error loading videos:', e);
            } finally {
                this.isLoading = false;
            }
        },

        async loadBatches() {
            try {
                // Load simple batch names for dropdown (backwards compatible)
                this.batches = await (await fetch(`/api/v1/batches?sort=${this.batchSort}`)).json();
                // Load detailed batch info for display
                this.batchesDetailed = await (await fetch(`/api/v1/batches?sort=${this.batchSort}&detailed=true`)).json();
            } catch (e) {
                console.error('Error loading batches:', e);
            }
        },

        cycleBatchSort() {
            // Cycle through: name -> newest -> biggest -> name
            const sortOrder = ['name', 'newest', 'biggest'];
            const currentIndex = sortOrder.indexOf(this.batchSort);
            this.batchSort = sortOrder[(currentIndex + 1) % sortOrder.length];
            this.loadBatches();
        },

        async handleFlowAction(action, video) {
            if (action === 'regenerate') {
                this.showToast('Regenerating preview...', 'refresh');
                try {
                    // Force regeneration of preview with specific 5s duration if needed, 
                    // or just trigger standard regeneration
                    await fetch(`/api/v1/videos/${video.id}/regenerate?mode=preview`, { method: 'POST' });
                    this.showToast('Preview regeneration queued', 'check_circle');
                } catch (e) {
                    this.showToast('Failed to regenerate', 'error', 'error');
                }
            }
        },

        async loadTags() {
            try {
                const res = await fetch('/api/v1/tags');
                this.tags = await res.json();
            } catch (e) {
                console.error('Failed to load tags', e);
            }
        },

        async loadRecommendations() {
            try {
                const res = await fetch('/api/v1/videos/recommendations');
                this.recommendations = await res.json();
            } catch (e) {
                console.error('Failed to load neural recommendations', e);
            }
        },

        async manualDownload(video) {
            this.showToast(`Starting download: ${video.title}...`, 'cloud_download');
            try {
                const res = await fetch(`/api/v1/videos/${video.id}/download`, { method: 'POST' });
                const data = await res.json();
                if (data.status === 'download_queued') {
                    this.showToast('Download queued!', 'check_circle', 'success');
                    video.status = 'downloading';
                } else if (data.status === 'already_local') {
                    this.showToast('Video is already local', 'info');
                    video.storage_type = 'local';
                }
            } catch (e) {
                this.showToast('Download request failed', 'error', 'error');
            }
        },

        handleCardClick(video) {
            if (this.batchMode) {
                if (this.selectedIds.includes(video.id)) this.selectedIds = this.selectedIds.filter(id => id !== video.id);
                else this.selectedIds.push(video.id);
            } else if (this.viewMode === 'flow' || this.duoPickMode) {
                // Flow Mode: Use Duo Player
                if (this.duoPickMode) {
                    // We're in pick mode - load video into the target slot
                    this.setDuoVideo(this.duoPickTarget, video);
                    this.duoPickMode = false;
                    this.duoPlayerMode = true; // Show the player again
                    this.showToast(`Video ${this.duoPickTarget} loaded!`, 'check_circle');
                } else if (this.duoPlayerMode) {
                    // Duo Player is open - load into empty slot or replace focused
                    if (!this.duoVideo1) {
                        this.setDuoVideo(1, video);
                    } else if (!this.duoVideo2) {
                        this.setDuoVideo(2, video);
                    } else {
                        // Both slots full - replace the focused one
                        this.setDuoVideo(this.duoFocused, video);
                    }
                } else {
                    // Open Duo Player with this video
                    this.openDuoPlayer(video, null);
                }
            } else {
                if (this.secondPickMode && this.splitScreenMode && this.primaryForSplit) {
                    // We armed second-pick by clicking the right panel; now this gallery click completes it
                    this.activeVideo = this.primaryForSplit;
                    this.activeVideo2 = video;
                    this.secondPickMode = false;
                    this.showPlayer = true;
                    this.$nextTick(() => {
                        this.initPlayer(this.activeVideo, 0);
                        this.initPlayer(this.activeVideo2, 1);
                    });
                } else {
                    // normal behavior
                    this.playVideo(video);
                }
            }
        },

        connectWebSocket() {
            const wsUrl = `ws://${window.location.host}/ws/status`;
            const socket = new WebSocket(wsUrl);

            socket.onmessage = (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error, 'Raw data:', event.data);
                    return;
                }

                if (data.type === 'log') {
                    this.logs.push(data);
                    if (this.logs.length > 50) this.logs.shift();
                } else if (data.type === 'new_video') {
                    const video = data.video;
                    // Validate video object has required properties
                    if (!video || !video.id || !video.title) {
                        console.warn('Received invalid video object from WebSocket:', video);
                        return;
                    }
                    const matchesBatch = this.filters.batch === 'All' || this.filters.batch === video.batch_name;
                    const matchesFavorites = !this.filters.favoritesOnly;

                    if (matchesBatch && matchesFavorites && !this.videos.find(v => v.id === video.id)) {
                        this.videos.unshift(video);
                        if (this.videos.length > 100) this.videos.pop();
                    }
                } else if (data.type === 'status_update') {
                    const video = this.videos.find(v => v.id === data.video_id);
                    if (video) {
                        video.status = data.status;
                        if (data.status === 'ready' || data.status === 'ready_to_stream') {
                            if (data.storage_type) video.storage_type = data.storage_type;
                            if (data.title) video.title = data.title;
                            if (data.thumbnail_path) video.thumbnail_path = data.thumbnail_path + '?t=' + new Date().getTime();
                            if (data.download_stats) video.download_stats = data.download_stats;
                            if (data.duration) video.duration = data.duration;
                            if (data.height) video.height = data.height;
                            this.showToast(`Ready: ${video.title}`, 'check_circle', 'success');
                        } else if (data.status === 'error') {
                            this.showToast(`Error: ${video.id}`, 'error', 'error');
                        }
                    }
                } else if (data.type === 'import_summary') {
                    // Show a rich toast or modal with import results
                    const s = data.stats;


                    let rejectedHtml = '';
                    if (s.rejected_samples && s.rejected_samples.length > 0) {
                        rejectedHtml = `
                            <div style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.1); padding-top:8px;">
                                <div style="font-size:12px; color:#ef4444; margin-bottom:4px;">Top Rejections:</div>
                                ${s.rejected_samples.slice(0, 5).map(r => `
                                    <div style="font-size:11px; opacity:0.8; margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                        ❌ [${r.reason}] ${r.title}
                                    </div>
                                `).join('')}
                            </div>
                        `;
                    }

                    const html = `
                        <div class="import-summary-modal">
                            <h3 style="margin-top:0; color:var(--primary); font-size:16px;">
                                <span class="material-icons-round" style="vertical-align:middle;">analytics</span> 
                                Batch Complete: ${data.batch}
                            </h3>
                            <div class="summary-stat total"><span>Scanned:</span> <span>${s.scanned}</span></div>
                            <div class="summary-stat success"><span>Imported:</span> <span>${s.imported}</span></div>
                            <div class="summary-stat" style="color:#94a3b8;"><span>Duplicates:</span> <span>${s.skipped_exists || 0}</span></div>
                            <div class="summary-stat"><span>Too Short:</span> <span>${s.skipped_short}</span></div>
                            <div class="summary-stat"><span>Low Res:</span> <span>${s.skipped_low_res}</span></div>
                            <div class="summary-stat"><span>Keyword Blocks:</span> <span>${s.skipped_keywords}</span></div>
                            <div class="summary-stat fail"><span>Errors:</span> <span>${s.error}</span></div>
                            ${rejectedHtml}
                            <button class="btn-primary w-100" style="margin-top:15px;" onclick="this.parentElement.parentElement.remove()">Dismiss</button>
                        </div>
                    `;
                    this.showToast(html, 'analytics', 'info', 15000, true); // 15s duration for summary, true for HTML
                    this.loadBatches();
                    this.loadVideos(true);
                }
            };

            socket.onclose = () => {
                if (socket.readyState === WebSocket.CLOSED) {
                    setTimeout(() => {
                        this.connectWebSocket();
                    }, 3000);
                }
            };

            socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                socket.close();
            };
        },

        startPolling() {
            // Polling handled via WebSocket updates
        },

        async deleteCurrentBatch() {
            if (this.filters.batch === 'All' || !confirm('Delete ALL videos in batch?')) return;
            await fetch('/api/v1/batch/delete-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_name: this.filters.batch })
            });
            this.showToast('Batch deleted', 'delete');
            this.filters.batch = 'All';
            this.loadBatches();
            this.loadVideos(true);
        },

        async refreshCurrentBatch() {
            if (this.filters.batch === 'All') {
                this.showToast('Cannot refresh \'All\' videos. Please select a specific batch.', 'warning');
                return;
            }
            if (!confirm(`Refresh all links for batch "${this.filters.batch}"? This can take a while.`)) return;

            this.showToast(`Starting refresh for batch: ${this.filters.batch}...`, 'sync', 'info');
            try {
                const resp = await fetch('/api/v1/batch/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ batch_name: this.filters.batch })
                });
                const data = await resp.json();
                if (resp.ok) {
                    this.showToast(data.message || 'Batch refresh started in background.', 'check_circle', 'success');
                } else {
                    throw new Error(data.detail || 'Failed to start batch refresh.');
                }
            } catch (e) {
                this.showToast(e.message || 'An error occurred.', 'error', 'error');
            }
        },

        async searchVideos(query) {
            if (!query || query.length < 2) return [];
            const params = new URLSearchParams({ query: query });
            try {
                const res = await fetch(`/api/v1/search/subtitles?${params}`);
                return await res.json();
            } catch (e) {
                this.showToast('Video search failed', 'error', 'error');
                return [];
            }
        },

        highlight(text, query) {
            if (!text || !query) return (text || '').substring(0, 200);
            const index = text.toLowerCase().indexOf(query.toLowerCase());
            if (index === -1) return text.substring(0, 200) + '...';

            const start = Math.max(0, index - 50);
            const end = Math.min(text.length, index + query.length + 50);
            const snippet = text.substring(start, end);

            const highlighted = snippet.replace(new RegExp(query, 'gi'), (match) => `<mark>${match}</mark>`);
            return `...${highlighted}...`;
        },

        get exportUrl() {
            const params = new URLSearchParams();
            Object.entries(this.filters).forEach(([key, value]) => {
                if (value !== null && value !== '' && value.toString() !== 'All') {
                    params.append(key, value);
                }
            });
            return `/api/v1/export?${params.toString()}`;
        }
    };
}

function createSettingsModule() {
    return {
        showSettings: false,
        settings: { genSpeed: 'fast', autoplay: true, loop: false, theme: 'dark', accentColor: 'purple', playbackSpeed: 1.0, useHls: false, uiMode: 'default' },

        loadSettings() {
            const s = localStorage.getItem('vipSettings');
            if (s) {
                this.settings = { ...this.settings, ...JSON.parse(s) };
            }
        },

        saveSettings() {
            localStorage.setItem('vipSettings', JSON.stringify(this.settings));
            this.showToast('Settings saved', 'check_circle', 'success');
        }
    };
}

function createImportModule() {
    return {
        importProgress: { active: false, percent: 0, total: 0, done: 0 },
        showImportModal: false,
        showAddToBatchModal: false,
        importTextContent: '',
        addToBatchContent: '',
        newBatchName: '',
        selectedParser: 'yt-dlp',
        showHQPornerModal: false,
        showEpornerModal: false,
        epornerUrl: '',
        epornerQuery: '',
        epornerCount: 50,
        epornerMinQuality: 1080,
        showCSVModal: false,
        showSpankBangModal: false,
        showRedGifsModal: false,
        redGifsForm: { keywords: '', count: 20, hd_only: false, min_duration: 30, min_resolution: 1080, only_vertical: false, disable_rejection: false, batch_name: '' },
        showRedditModal: false,
        redditForm: { subreddits: '', count: 20, hd_only: false, min_duration: 30, min_resolution: 1080, only_vertical: false, disable_rejection: false, batch_name: '' },
        showPornOneModal: false,
        pornOneForm: { keywords: '', count: 20, min_duration: 30, min_resolution: 1080, only_vertical: false, batch_name: '', debug: false },
        hqpornerForm: { keywords: '', min_quality: '1080p', added_within: 'any', count: 5, batch_name: '' },
        showBeegModal: false,
        beegForm: { query: '', count: 10, batch_name: '' },
        spankBangUrl: '',
        fastImportUrl: '',
        fastImportFilterEnabled: false,
        showXVideosPlaylistModal: false,
        xvideosPlaylistUrl: '',
        xvideosPlaylistBatch: '',
        showTnaflixModal: false,
        tnaflixForm: { url: '', count: 20, min_duration: 0, min_quality: 0, batch_name: '' },
        showLocalFolderModal: false,
        localFolderPath: '',
        localFolderRecursive: true,
        quickImportUrls: '',
        dragCounter: 0,
        showVKImportModal: false,
        vkUrl: '',

        // Eporner Smart Discovery
        showEpornerDiscoveryModal: false,
        epornerDiscovery: {
            keyword: '',
            minQuality: 1080,
            pages: 1,
            autoSkipLowQuality: true,
            loading: false,
            results: [],
            selected: [],
            total: 0,
            matched: 0
        },

        // Porntrex Smart Discovery
        showPorntrexDiscoveryModal: false,
        porntrexDiscovery: {
            keyword: '',
            category: '',
            minQuality: 1080,
            pages: 1,
            uploadType: 'all',
            autoSkipLowQuality: true,
            loading: false,
            results: [],
            selected: [],
            total: 0,
            matched: 0
        },

        // WhoresHub Smart Discovery
        showWhoresHubDiscoveryModal: false,
        whoreshubDiscovery: {
            keyword: '',
            tag: '',
            minQuality: 720,
            minDuration: 300,
            pages: 1,
            uploadType: 'all',
            autoSkipLowQuality: true,
            loading: false,
            results: [],
            selected: [],
            total: 0,
            matched: 0
        },


        async fastImport() {
            if (!this.fastImportUrl || !this.fastImportUrl.trim()) return;
            const url = this.fastImportUrl.trim();

            this.showToast('Fast Import started...', 'bolt', 'info');
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                // Determine parser based on URL
                let parser = 'yt-dlp';
                if (url.includes('bunkr') || url.includes('gofile') || url.includes('cyberdrop') || url.includes('pixeldrain')) {
                    parser = 'cyberdrop-dl-patched';
                }

                const payload = {
                    urls: [url],
                    batch_name: 'Fast Import ' + new Date().toLocaleTimeString(),
                    parser: parser
                };

                // Add filters if enabled
                if (this.fastImportFilterEnabled) {
                    payload.min_quality = 1080;
                    payload.min_duration = 600; // 10 minutes in seconds
                }

                const resp = await fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast('Import queued successfully!', 'check_circle', 'success');
                    this.fastImportUrl = ''; // Clear input on success
                    this.loadVideos(true);
                    this.loadBatches();
                    this.importProgress.percent = 100;
                } else {
                    this.showToast('Import failed: ' + (data.detail || 'Unknown error'), 'error', 'error');
                }
            } catch (e) {
                console.error(e);
                this.showToast('Network error during import', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        openAddToBatchModal() {
            if (this.filters.batch === 'All') {
                this.showToast('Vyberte konkrétny batch, do ktorého chcete pridať videá.', 'warning');
                return;
            }
            this.addToBatchContent = '';
            this.showAddToBatchModal = true;
        },

        async importToCurrentBatch() {
            if (!this.addToBatchContent.trim()) return;
            const batch = this.filters.batch;
            try {
                this.importProgress.active = true;
                this.importProgress.percent = 0;
                const resp = await fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        urls: this.addToBatchContent.split('\n').filter(u => u.trim()),
                        batch_name: batch,
                        parser: this.selectedParser
                    })
                });
                const data = await resp.json();
                this.showAddToBatchModal = false;
                if (data && data.count !== undefined) {
                    this.showToast(`Pridaných ${data.count} videí do batchu '${batch}'`, 'check_circle', 'success');
                    this.importProgress.percent = 100;
                }
                setTimeout(() => { this.importProgress.active = false; }, 800);
                this.loadVideos(true);
            } catch (e) {
                this.showToast('Import zlyhal', 'error');
            }
        },

        async importVK() {
            if (!this.vkUrl || !this.vkUrl.trim()) return;
            const url = this.vkUrl.trim();
            this.showVKImportModal = false;
            this.showToast('VK Import started...', 'bolt', 'info');
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const payload = {
                    urls: [url],
                    batch_name: 'VK Import ' + new Date().toLocaleTimeString(),
                    parser: 'yt-dlp'
                };

                const resp = await fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast('VK Video queued!', 'check_circle', 'success');
                    this.vkUrl = '';
                    this.loadVideos(true);
                    this.loadBatches();
                    this.importProgress.percent = 100;
                } else {
                    this.showToast('VK Import failed: ' + (data.detail || 'Unknown error'), 'error', 'error');
                }
            } catch (e) {
                console.error(e);
                this.showToast('Network error during VK import', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async handleFileSelect(e) {
            const files = e.target.files;
            if (files && files.length > 0) {
                // Try to check if files have local paths (Electron apps)
                const filePaths = [];
                let hasLocalPaths = false;

                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (file.path) {
                        hasLocalPaths = true;
                        filePaths.push(file.path);
                    }
                }

                // Use fast indexing if available, otherwise upload
                if (hasLocalPaths && filePaths.length > 0) {
                    await this.indexLocalFiles(filePaths);
                } else {
                    await this.uploadFiles(files);
                }
            }
        },

        async handleDrop(e) {
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                // Check if we can get file paths (local files)
                const items = e.dataTransfer.items;
                let hasLocalPaths = false;
                const filePaths = [];

                // Try to extract local file paths
                if (items) {
                    for (let i = 0; i < items.length; i++) {
                        const item = items[i];
                        if (item.kind === 'file') {
                            const file = item.getAsFile();
                            // Check if file has a path property (Electron, local file system)
                            if (file && file.path) {
                                hasLocalPaths = true;
                                filePaths.push(file.path);
                            }
                        }
                    }
                }

                // Use fast local indexing if we have paths, otherwise upload
                if (hasLocalPaths && filePaths.length > 0) {
                    await this.indexLocalFiles(filePaths);
                } else {
                    await this.uploadFiles(files);
                }
            }
        },

        async indexLocalFiles(filePaths) {
            const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v'];
            const videoFiles = filePaths.filter(path => {
                const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
                return videoExtensions.includes(ext);
            });

            if (videoFiles.length === 0) {
                this.showToast('No video files found', 'warning', 'warning');
                return;
            }

            this.importProgress.active = true;
            this.importProgress.total = videoFiles.length;
            this.importProgress.done = 0;
            this.importProgress.percent = 0;

            try {
                this.showToast(`Indexing ${videoFiles.length} local videos...`, 'folder_open', 'info');

                const batch = this.newBatchName || `Local_${new Date().toLocaleTimeString().replace(/:/g, '-')}`;

                const resp = await fetch('/api/v1/import/local-index', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_paths: videoFiles,
                        batch_name: batch
                    })
                });

                const data = await resp.json();

                if (resp.ok && data.count > 0) {
                    this.showToast(`✨ Indexed ${data.count} videos instantly! No upload needed.`, 'lightning_bolt', 'success');
                    this.importProgress.percent = 100;
                    this.importProgress.done = data.count;

                    // Reload to show new videos
                    setTimeout(() => {
                        this.loadBatches();
                        this.loadVideos(true);
                    }, 500);
                } else {
                    this.showToast('Fast indexing failed, falling back to upload...', 'warning', 'warning');
                    // Fallback to regular upload if indexing fails
                    const fileObjects = await Promise.all(
                        videoFiles.map(async path => {
                            try {
                                const response = await fetch(`file:///${path}`);
                                const blob = await response.blob();
                                const fileName = path.split(/[\\/]/).pop();
                                return new File([blob], fileName, { type: blob.type });
                            } catch {
                                return null;
                            }
                        })
                    );
                    const validFiles = fileObjects.filter(f => f !== null);
                    if (validFiles.length > 0) {
                        await this.uploadFiles(validFiles);
                    }
                }
            } catch (e) {
                console.error('Local indexing error:', e);
                this.showToast('Local indexing failed: ' + e.message, 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async uploadFiles(files) {
            const allowedExt = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.txt', '.json', '.csv'];
            let anyUploaded = false;
            this.importProgress.active = true;
            this.importProgress.total = files.length;
            this.importProgress.done = 0;
            this.importProgress.percent = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
                if (!allowedExt.includes(ext)) {
                    this.showToast(`Nepodporovaný typ: ${file.name}`, 'error', 'error');
                    continue;
                }
                anyUploaded = true;
                const fd = new FormData();
                fd.append('file', file);
                this.showToast(`Uploading ${file.name}...`, 'cloud_upload');
                try {
                    await fetch('/api/v1/import/file', { method: 'POST', body: fd });
                    this.showToast(`Import ${file.name} started`, 'check_circle');
                    this.importProgress.done++;
                    this.importProgress.percent = Math.round((this.importProgress.done / this.importProgress.total) * 100);
                } catch (e) {
                    this.showToast(`Failed: ${file.name}`, 'error', 'error');
                    this.importProgress.done++;
                    this.importProgress.percent = Math.round((this.importProgress.done / this.importProgress.total) * 100);
                }
            }
            setTimeout(() => { this.importProgress.active = false; }, 800);
            if (anyUploaded) setTimeout(() => { this.loadBatches(); this.loadVideos(true); }, 1000);
        },

        async handleCSVSelect(e) {
            const files = e.target.files;
            if (files && files.length > 0) await this.uploadFiles(files);
            this.showCSVModal = false;
        },

        async browseLocalFolder() {
            try {
                // Use modern File System Access API (works in Chrome/Edge)
                if ('showDirectoryPicker' in window) {
                    const dirHandle = await window.showDirectoryPicker();
                    const filePaths = [];

                    // Recursively scan directory
                    async function scanDirectory(dirHandle, basePath = '') {
                        for await (const entry of dirHandle.values()) {
                            if (entry.kind === 'file') {
                                const file = await entry.getFile();
                                const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
                                const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v'];

                                if (videoExtensions.includes(ext)) {
                                    // For File System Access API, we need to construct the full path
                                    // Note: We can't get the actual file system path for security reasons
                                    // So we'll store the file handle or use a different approach
                                    filePaths.push({
                                        name: file.name,
                                        path: basePath + '/' + file.name,
                                        file: file
                                    });
                                }
                            } else if (entry.kind === 'directory') {
                                await scanDirectory(entry, basePath + '/' + entry.name);
                            }
                        }
                    }

                    this.showToast('Scanning folder for videos...', 'folder_open', 'info');
                    await scanDirectory(dirHandle);

                    if (filePaths.length === 0) {
                        this.showToast('No video files found in folder', 'warning', 'warning');
                        return;
                    }

                    this.showToast(`Found ${filePaths.length} videos, uploading to server...`, 'upload', 'info');

                    // Since we can't get real paths in browser, we need to upload these files
                    const files = filePaths.map(fp => fp.file);
                    await this.uploadFiles(files);

                } else {
                    this.showToast('Folder browsing not supported in this browser. Use Chrome/Edge or drag & drop files.', 'warning', 'warning');
                }
            } catch (e) {
                if (e.name !== 'AbortError') {
                    console.error('Folder browse error:', e);
                    this.showToast('Failed to browse folder: ' + e.message, 'error', 'error');
                }
            }
        },

        async importFromText() {
            const batch = this.newBatchName || 'Import ' + new Date().toLocaleTimeString();
            try {
                this.importProgress.active = true;
                this.importProgress.percent = 0;
                const resp = await fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        urls: this.importTextContent.split('\n'),
                        batch_name: batch,
                        parser: this.selectedParser
                    })
                });
                const data = await resp.json();
                this.showImportModal = false;
                if (data && data.count !== undefined) {
                    this.showToast(`Pridaných ${data.count} videí do batchu '${data.batch}'`, 'check_circle');
                    this.importProgress.percent = 100;
                } else {
                    this.showToast('Import spustený', 'cloud_queue');
                    this.importProgress.percent = 100;
                }
                this.loadBatches();
                this.loadVideos(true);
            } catch (e) {
                this.showToast('Chyba pri importe', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 800);
            }
        },

        importEporner() {
            if (this.epornerUrl && this.epornerUrl.trim().length > 0) {
                this.showToast('Spúšťam import z URL...', 'cloud_download');
                this.importProgress.active = true;
                this.importProgress.percent = 0;
                this.showEpornerModal = false;

                const batchName = 'Eporner Import ' + new Date().toLocaleTimeString();

                fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        urls: [this.epornerUrl.trim()],
                        batch_name: batchName,
                        parser: 'yt-dlp'
                    })
                }).then(r => r.json()).then(data => {
                    this.showToast(`Import spustený. Batch: ${batchName}`, 'check_circle', 'success');
                    this.importProgress.percent = 100;
                    setTimeout(() => { this.importProgress.active = false; }, 1500);
                    this.loadBatches();
                    this.loadVideos(true);
                    this.epornerUrl = '';
                }).catch(e => {
                    this.showToast('Chyba pri importe', 'error', 'error');
                    this.importProgress.active = false;
                });
                return;
            }

            if (!this.epornerQuery || this.epornerQuery.trim().length < 2) {
                this.showToast('Zadaj vyhľadávací výraz pre Eporner!', 'error');
                return;
            }
            this.importProgress.active = true;
            this.importProgress.percent = 0;
            this.showEpornerModal = false;
            this.showToast('Importujem Eporner videá...');
            fetch('/api/v1/import/eporner_search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: this.epornerQuery,
                    count: this.epornerCount,
                    min_quality: this.epornerMinQuality,
                    batch_name: ''
                })
            })
                .then(r => r.json())
                .then(res => {
                    this.showToast(`Pridaných ${res.count} videí z Eporner!`, 'success');
                    this.loadBatches();
                    this.loadVideos(true);
                    this.importProgress.percent = 100;
                    setTimeout(() => { this.importProgress.active = false; }, 800);
                })
                .catch(e => {
                    this.showToast('Chyba pri importe z Eporner!', 'error');
                    this.importProgress.percent = 100;
                    setTimeout(() => { this.importProgress.active = false; }, 800);
                });
        },

        async handleXVideosFileSelect(e) {
            const file = e.target.files[0];
            if (!file) return;

            if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
                this.showToast('Only .txt files allowed', 'error', 'error');
                return;
            }

            const text = await file.text();
            const urls = text.split(/\r?\n/).filter(line => line.trim().length > 0 && line.includes('xvideos.com'));

            if (urls.length === 0) {
                this.showToast('No valid XVideos URLs found', 'warning', 'warning');
                return;
            }

            this.showToast(`Importing ${urls.length} videos...`, 'cloud_download');
            this.importProgress.active = true;
            this.importProgress.total = urls.length;
            this.importProgress.done = 0;
            this.importProgress.percent = 0;

            for (const url of urls) {
                try {
                    const res = await fetch('/api/v1/import/xvideos', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: url.trim() })
                    });

                    if (res.ok) {
                        const meta = await res.json();
                        const newVideo = {
                            id: meta.db_id || meta.id,
                            title: meta.title,
                            thumbnail_path: meta.thumbnail,
                            duration: meta.duration,
                            height: meta.stream.height,
                            width: 0,
                            status: 'ready',
                            url: meta.stream.url,
                            source_url: meta.source_url || url.trim(),
                            created_at: new Date().toISOString(),
                            tags: '',
                            ai_tags: ''
                        };

                        if (!this.videos.find(v => v.id === newVideo.id)) {
                            this.videos.unshift(newVideo);
                        }
                    } else {
                        console.error(`Failed to import ${url}`);
                    }
                } catch (err) {
                    console.error(`Error importing ${url}:`, err);
                }

                this.importProgress.done++;
                this.importProgress.percent = Math.round((this.importProgress.done / this.importProgress.total) * 100);
            }

            this.showToast('Import completed', 'check_circle', 'success');
            setTimeout(() => { this.importProgress.active = false; }, 1000);

            e.target.value = '';
        },

        async importSpankBang() {
            if (!this.spankBangUrl.trim()) return;
            const url = this.spankBangUrl.trim();
            this.showSpankBangModal = false;
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            this.showToast('Spracúvam SpankBang...', 'cloud_download');

            try {
                if (url.includes('/playlist/')) {
                    const resp = await fetch('/api/v1/import/text', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            urls: [url],
                            batch_name: 'SpankBang Playlist ' + new Date().toLocaleTimeString(),
                            parser: 'yt-dlp'
                        })
                    });
                    const data = await resp.json();
                    this.showToast('Playlist import spustený v pozadí', 'check_circle', 'success');
                    this.importProgress.percent = 100;
                } else {
                    const res = await fetch('/api/v1/import/spankbang', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: url })
                    });

                    if (res.ok) {
                        const meta = await res.json();
                        const newVideo = {
                            id: meta.db_id || meta.id,
                            title: meta.title,
                            thumbnail_path: meta.thumbnail,
                            duration: meta.duration,
                            height: meta.stream.height,
                            width: 0,
                            status: 'ready',
                            url: meta.stream.url,
                            source_url: url,
                            created_at: new Date().toISOString(),
                            tags: (meta.tags || []).join(','),
                            ai_tags: ''
                        };

                        if (!this.videos.find(v => v.id === newVideo.id)) {
                            this.videos.unshift(newVideo);
                        }
                        this.showToast('Import úspešný', 'check_circle', 'success');
                        this.importProgress.percent = 100;
                    } else {
                        throw new Error('EXTRACTION_FAILED');
                    }
                }
            } catch (err) {
                console.error('SpankBang import error:', err);
                this.showToast('Import zlyhal', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
                this.spankBangUrl = '';
                this.loadBatches();
                this.loadVideos(true);
            }
        },

        async importRedGifs() {
            if (!this.redGifsForm.keywords.trim()) {
                this.showToast('Zadaj kľúčové slová!', 'warning');
                return;
            }

            this.showRedGifsModal = false;
            this.importProgress.active = true;
            this.importProgress.percent = 0;
            this.showToast('Importujem z RedGIFs...', 'cloud_download');

            try {
                const resp = await fetch('/api/v1/import/redgifs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.redGifsForm)
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast(`Import úspešný: ${data.count} kandidátov v pozadí`, 'check_circle', 'success');
                    this.importProgress.percent = 100;
                    this.loadBatches();
                    this.loadVideos(true);
                } else {
                    throw new Error(data.detail || 'Import failed');
                }
            } catch (err) {
                console.error('RedGIFs import error:', err);
                this.showToast('RedGIFs import zlyhal', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async importReddit() {
            if (!this.redditForm.subreddits.trim()) {
                this.showToast('Zadaj subreddity (napr. NSFW_GIF, Amateur)!', 'warning');
                return;
            }

            this.showRedditModal = false;
            this.importProgress.active = true;
            this.importProgress.percent = 0;
            this.showToast('Hľadám na Reddite...', 'cloud_download');

            try {
                const resp = await fetch('/api/v1/import/reddit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.redditForm)
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast(`Import úspešný: ${data.count} kandidátov v pozadí`, 'check_circle', 'success');
                    this.importProgress.percent = 100;
                    this.loadBatches();
                    this.loadVideos(true);
                } else {
                    throw new Error(data.detail || 'Import failed');
                }
            } catch (err) {
                console.error('Reddit import error:', err);
                this.showToast('Reddit import zlyhal', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async importPornOne() {
            if (!this.pornOneForm.keywords.trim()) {
                this.showToast('Zadajte kľúčové slová!', 'warning');
                return;
            }

            this.showPornOneModal = false;
            this.importProgress.active = true;
            this.importProgress.percent = 0;
            this.showToast('Scanning PornOne...', 'movie');

            try {
                const resp = await fetch('/api/v1/import/pornone', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.pornOneForm)
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast(`PornOne import: Found ${data.count} candidates`, 'check_circle', 'success');
                    this.importProgress.percent = 100;
                } else {
                    throw new Error(data.detail || 'Import failed');
                }
            } catch (err) {
                console.error('PornOne import error:', err);
                this.showToast('PornOne import failed', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async importXVideosPlaylist() {
            if (!this.xvideosPlaylistUrl || !this.xvideosPlaylistUrl.trim()) return;
            const url = this.xvideosPlaylistUrl.trim();

            this.showXVideosPlaylistModal = false;
            this.showToast('XVideos Playlist expansion started...', 'bolt', 'info');
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const resp = await fetch('/api/v1/import/xvideos_playlist', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: url,
                        batch_name: this.xvideosPlaylistBatch || null
                    })
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast('XVideos Playlist expansion queued!', 'check_circle', 'success');
                    this.xvideosPlaylistUrl = '';
                    this.xvideosPlaylistBatch = '';
                    this.loadBatches();
                    this.loadVideos(true);
                } else {
                    this.showToast('Expansion failed: ' + (data.message || data.detail || 'Unknown error'), 'error', 'error');
                }
            } catch (e) {
                console.error(e);
                this.showToast('Network error during expansion', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async importHQPorner() {
            if (!this.hqpornerForm.keywords.trim()) {
                this.showToast('Please enter search keywords', 'warning', 'warning');
                return;
            }

            this.showHQPornerModal = false;
            this.showToast('Importing from HQPorner...', 'hd', 'info');
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const resp = await fetch('/api/import/hqporner', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.hqpornerForm)
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast(`✓ Queued ${data.count} HQPorner videos`, 'check_circle', 'success');
                    this.hqpornerForm = { keywords: '', min_quality: '1080p', added_within: 'any', count: 5, batch_name: '' };
                    this.loadBatches();
                    this.loadVideos(true);
                    this.importProgress.percent = 100;
                } else {
                    this.showToast(`Import failed: ${data.detail || 'Unknown error'}`, 'error', 'error');
                }
            } catch (e) {
                console.error('HQPorner import error:', e);
                this.showToast('Failed to import from HQPorner', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async importBeeg() {
            if (!this.beegForm.query.trim()) {
                this.showToast('Please enter search query', 'warning', 'warning');
                return;
            }

            this.showBeegModal = false;
            this.showToast('Starting Beeg crawl...', 'search', 'info');
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const resp = await fetch('/api/v1/import/beeg', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.beegForm)
                });

                const data = await resp.json();
                if (resp.ok) {
                    this.showToast(`✓ Queued ${data.count} Beeg videos`, 'check_circle', 'success');
                    this.beegForm = { query: '', count: 10, batch_name: '' };
                    this.loadBatches();
                    this.loadVideos(true);
                    this.importProgress.percent = 100;
                } else {
                    this.showToast(`Crawl failed: ${data.detail || 'Unknown error'}`, 'error', 'error');
                }
            } catch (e) {
                console.error('Beeg import error:', e);
                this.showToast('Failed to start Beeg crawl', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        registerDragAndDrop() {
            window.addEventListener('dragenter', (e) => {
                e.preventDefault();
                this.dragCounter++;
            });
            window.addEventListener('dragleave', (e) => {
                e.preventDefault();
                this.dragCounter = Math.max(0, this.dragCounter - 1);
            });
            window.addEventListener('dragover', (e) => {
                e.preventDefault();
            });
            window.addEventListener('drop', (e) => {
                e.preventDefault();
                this.dragCounter = 0;
                this.handleDrop(e);
            });
        },

        async importLocalFolder() {
            if (!this.localFolderPath.trim()) {
                this.showToast('Please enter a folder path', 'warning', 'warning');
                return;
            }

            this.showLocalFolderModal = false;
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                this.showToast('⚡ Scanning folder for videos...', 'folder_open', 'info');

                const resp = await fetch('/api/v1/import/local-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        folder_path: this.localFolderPath,
                        batch_name: this.newBatchName || `Local_${new Date().toLocaleTimeString().replace(/:/g, '-')}`,
                        recursive: this.localFolderRecursive
                    })
                });

                const data = await resp.json();

                if (resp.ok && data.count > 0) {
                    this.showToast(`✨ Indexed ${data.count} local videos instantly!`, 'lightning_bolt', 'success');
                    this.importProgress.percent = 100;

                    setTimeout(() => {
                        this.loadBatches();
                        this.loadVideos(true);
                    }, 500);
                } else if (resp.ok) {
                    this.showToast('No video files found in folder', 'warning', 'warning');
                } else {
                    this.showToast('Failed to index folder: ' + (data.detail || 'Unknown error'), 'error', 'error');
                }
            } catch (e) {
                console.error('Local folder import error:', e);
                this.showToast('Failed to index folder: ' + e.message, 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async importTnaflix() {
            if (!this.tnaflixForm.url && !this.tnaflixForm.batch_name) {
                this.showToast('Please provide a URL or batch name', 'warning');
                return;
            }
            this.showTnaflixModal = false;
            this.showToast('Starting Tnaflix import...', 'movie', 'info');
            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const resp = await fetch('/api/v1/import/tnaflix', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.tnaflixForm)
                });
                const data = await resp.json();
                if (resp.ok) {
                    this.showToast(`Queued ${data.count} videos from Tnaflix`, 'check_circle', 'success');
                    this.importProgress.percent = 100;
                    this.loadBatches();
                    this.loadVideos(true);
                } else {
                    this.showToast('Import failed: ' + (data.detail || 'Unknown error'), 'error', 'error');
                }
            } catch (e) {
                console.error(e);
                this.showToast('Network error during Tnaflix import', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        async quickImportVideos() {
            if (!this.quickImportUrls || this.quickImportUrls.trim().length === 0) {
                this.showToast('Please paste some URLs first', 'warning');
                return;
            }

            const urls = this.quickImportUrls.split('\n').filter(u => u.trim().length > 0);

            if (urls.length === 0) {
                this.showToast('No valid URLs found', 'warning');
                return;
            }

            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const resp = await fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        urls: urls,
                        batch_name: `Quick Import ${new Date().toLocaleTimeString()}`,
                        parser: 'auto'
                    })
                });

                const data = await resp.json();

                if (resp.ok) {
                    this.showToast(`Queued ${data.count || urls.length} videos`, 'check_circle', 'success');
                    this.importProgress.percent = 100;
                    this.quickImportUrls = ''; // Clear textarea
                    this.loadBatches();
                    this.loadVideos(true);
                } else {
                    this.showToast('Import failed: ' + (data.detail || 'Unknown error'), 'error', 'error');
                }
            } catch (e) {
                console.error(e);
                this.showToast('Network error during import', 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        // Eporner Smart Discovery Functions
        async searchEpornerDiscovery() {
            if (!this.epornerDiscovery.keyword.trim()) {
                this.showToast('Please enter a keyword or tag', 'warning');
                return;
            }

            this.epornerDiscovery.loading = true;
            this.epornerDiscovery.results = [];
            this.epornerDiscovery.selected = [];

            try {
                const response = await fetch('/api/v1/import/eporner_discovery', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        keyword: this.epornerDiscovery.keyword,
                        min_quality: this.epornerDiscovery.minQuality,
                        pages: this.epornerDiscovery.pages,
                        auto_skip_low_quality: this.epornerDiscovery.autoSkipLowQuality
                    })
                });

                const data = await response.json();

                if (data.status === 'success') {
                    this.epornerDiscovery.results = data.results;
                    this.epornerDiscovery.total = data.total;
                    this.epornerDiscovery.matched = data.matched;
                    this.showToast(`Found ${data.matched}/${data.total} videos`, 'check_circle', 'success');
                    console.log(`[EPORNER_DISCOVERY] Found ${data.matched}/${data.total} videos`);
                } else {
                    this.showToast('Search failed: ' + (data.message || 'Unknown error'), 'error', 'error');
                }
            } catch (error) {
                console.error('[EPORNER_DISCOVERY] Error:', error);
                this.showToast('Search failed: ' + error.message, 'error', 'error');
            } finally {
                this.epornerDiscovery.loading = false;
            }
        },

        toggleEpornerSelection(url) {
            const index = this.epornerDiscovery.selected.indexOf(url);
            if (index > -1) {
                this.epornerDiscovery.selected.splice(index, 1);
            } else {
                this.epornerDiscovery.selected.push(url);
            }
        },

        selectAllMatching() {
            this.epornerDiscovery.selected = this.epornerDiscovery.results
                .filter(v => v.matched)
                .map(v => v.url);
            this.showToast(`Selected ${this.epornerDiscovery.selected.length} videos`, 'check_circle');
        },

        async importSelectedEporner() {
            if (this.epornerDiscovery.selected.length === 0) {
                this.showToast('Please select at least one video', 'warning');
                return;
            }

            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const response = await fetch('/api/v1/import/eporner_discovery/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selected_urls: this.epornerDiscovery.selected,
                        batch_name: `Eporner Discovery - ${this.epornerDiscovery.keyword}`
                    })
                });

                const data = await response.json();

                if (data.status === 'success') {
                    this.showToast(`✅ Importing ${data.count} videos!`, 'check_circle', 'success');
                    this.showEpornerDiscoveryModal = false;
                    this.epornerDiscovery.results = [];
                    this.epornerDiscovery.selected = [];
                    this.importProgress.percent = 100;
                    this.loadVideos(true);
                    this.loadBatches();
                } else {
                    this.showToast('Import failed: ' + (data.message || 'Unknown error'), 'error', 'error');
                }
            } catch (error) {
                console.error('[EPORNER_DISCOVERY_IMPORT] Error:', error);
                this.showToast('Import failed: ' + error.message, 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        // Porntrex Smart Discovery Functions
        async searchPorntrexDiscovery() {
            if (!this.porntrexDiscovery.keyword.trim() && !this.porntrexDiscovery.category.trim()) {
                this.showToast('Please enter a keyword or category', 'warning');
                return;
            }

            this.porntrexDiscovery.loading = true;
            this.porntrexDiscovery.results = [];
            this.porntrexDiscovery.selected = [];

            try {
                const response = await fetch('/api/v1/import/porntrex_discovery', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        keyword: this.porntrexDiscovery.keyword,
                        category: this.porntrexDiscovery.category,
                        min_quality: this.porntrexDiscovery.minQuality,
                        pages: this.porntrexDiscovery.pages,
                        upload_type: this.porntrexDiscovery.uploadType,
                        auto_skip_low_quality: this.porntrexDiscovery.autoSkipLowQuality
                    })
                });

                const data = await response.json();

                if (data.status === 'success') {
                    this.porntrexDiscovery.results = data.results;
                    this.porntrexDiscovery.total = data.total;
                    this.porntrexDiscovery.matched = data.matched;
                    this.showToast(`Found ${data.matched} videos`, 'check_circle', 'success');
                    console.log(`[PORNTREX_DISCOVERY] Found ${data.matched} videos`);
                } else {
                    this.showToast('Search failed: ' + (data.message || 'Unknown error'), 'error', 'error');
                }
            } catch (error) {
                console.error('[PORNTREX_DISCOVERY] Error:', error);
                this.showToast('Search failed: ' + error.message, 'error', 'error');
            } finally {
                this.porntrexDiscovery.loading = false;
            }
        },

        togglePorntrexSelection(url) {
            const index = this.porntrexDiscovery.selected.indexOf(url);
            if (index > -1) {
                this.porntrexDiscovery.selected.splice(index, 1);
            } else {
                this.porntrexDiscovery.selected.push(url);
            }
        },

        selectAllPorntrex() {
            this.porntrexDiscovery.selected = this.porntrexDiscovery.results.map(v => v.url);
            this.showToast(`Selected ${this.porntrexDiscovery.selected.length} videos`, 'check_circle');
        },

        async importSelectedPorntrex() {
            if (this.porntrexDiscovery.selected.length === 0) {
                this.showToast('Please select at least one video', 'warning');
                return;
            }

            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const response = await fetch('/api/v1/import/porntrex_discovery/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selected_urls: this.porntrexDiscovery.selected,
                        batch_name: `Porntrex Discovery - ${this.porntrexDiscovery.keyword || this.porntrexDiscovery.category}`
                    })
                });

                const data = await response.json();

                if (data.status === 'success') {
                    this.showToast(`✅ Importing ${data.count} videos!`, 'check_circle', 'success');
                    this.showPorntrexDiscoveryModal = false;
                    this.porntrexDiscovery.results = [];
                    this.porntrexDiscovery.selected = [];
                    this.importProgress.percent = 100;
                    this.loadVideos(true);
                    this.loadBatches();
                } else {
                    this.showToast('Import failed: ' + (data.message || 'Unknown error'), 'error', 'error');
                }
            } catch (error) {
                console.error('[PORNTREX_DISCOVERY_IMPORT] Error:', error);
                this.showToast('Import failed: ' + error.message, 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        // WhoresHub Smart Discovery Functions
        async searchWhoresHubDiscovery() {
            this.whoreshubDiscovery.loading = true;
            this.whoreshubDiscovery.results = [];
            this.whoreshubDiscovery.selected = [];

            try {
                const response = await fetch('/api/v1/import/whoreshub_discovery', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        keyword: this.whoreshubDiscovery.keyword,
                        tag: this.whoreshubDiscovery.tag,
                        min_quality: this.whoreshubDiscovery.minQuality,
                        min_duration: this.whoreshubDiscovery.minDuration,
                        pages: this.whoreshubDiscovery.pages,
                        upload_type: this.whoreshubDiscovery.uploadType,
                        auto_skip_low_quality: this.whoreshubDiscovery.autoSkipLowQuality
                    })
                });

                const data = await response.json();

                if (data.status === 'success') {
                    this.whoreshubDiscovery.results = data.results;
                    this.whoreshubDiscovery.total = data.total;
                    this.whoreshubDiscovery.matched = data.matched;
                    this.showToast(`Found ${data.matched} videos`, 'check_circle', 'success');
                    console.log(`[WHORESHUB_DISCOVERY] Found ${data.matched} videos`);
                } else {
                    this.showToast('Search failed: ' + (data.message || 'Unknown error'), 'error', 'error');
                }
            } catch (error) {
                console.error('[WHORESHUB_DISCOVERY] Error:', error);
                this.showToast('Search failed: ' + error.message, 'error', 'error');
            } finally {
                this.whoreshubDiscovery.loading = false;
            }
        },

        toggleWhoresHubSelection(url) {
            const index = this.whoreshubDiscovery.selected.indexOf(url);
            if (index > -1) {
                this.whoreshubDiscovery.selected.splice(index, 1);
            } else {
                this.whoreshubDiscovery.selected.push(url);
            }
        },

        selectAllWhoresHub() {
            this.whoreshubDiscovery.selected = this.whoreshubDiscovery.results.map(v => v.url);
            this.showToast(`Selected ${this.whoreshubDiscovery.selected.length} videos`, 'check_circle');
        },

        async importSelectedWhoresHub() {
            if (this.whoreshubDiscovery.selected.length === 0) {
                this.showToast('Please select at least one video', 'warning');
                return;
            }

            this.importProgress.active = true;
            this.importProgress.percent = 0;

            try {
                const response = await fetch('/api/v1/import/whoreshub_discovery/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selected_urls: this.whoreshubDiscovery.selected,
                        batch_name: `WhoresHub Discovery - ${this.whoreshubDiscovery.keyword || this.whoreshubDiscovery.tag || 'Latest'}`
                    })
                });

                const data = await response.json();

                if (data.status === 'success') {
                    this.showToast(`✅ Importing ${data.count} videos!`, 'check_circle', 'success');
                    this.showWhoresHubDiscoveryModal = false;
                    this.whoreshubDiscovery.results = [];
                    this.whoreshubDiscovery.selected = [];
                    this.importProgress.percent = 100;
                    this.loadVideos(true);
                    this.loadBatches();
                } else {
                    this.showToast('Import failed: ' + (data.message || 'Unknown error'), 'error', 'error');
                }
            } catch (error) {
                console.error('[WHORESHUB_DISCOVERY_IMPORT] Error:', error);
                this.showToast('Import failed: ' + error.message, 'error', 'error');
            } finally {
                setTimeout(() => { this.importProgress.active = false; }, 1000);
            }
        },

        formatViews(views) {
            if (!views) return '';
            if (views >= 1000000) return (views / 1000000).toFixed(1) + 'M';
            if (views >= 1000) return (views / 1000).toFixed(1) + 'K';
            return views.toString();
        }
    };
}

function createExternalDiscoveryModule() {
    return {
        showExternalSearchModal: false,
        externalQuery: '',
        externalResults: [],
        isExternalSearching: false,
        showWebshareModal: false,
        wsQuery: '',
        wsResults: [],
        wsLoading: false,
        hasSearchedWs: false,
        wsSort: 'recent',
        wsMinSize: '',
        wsMaxSize: '',

        async searchExternal() {
            if (!this.externalQuery || this.externalQuery.length < 2) return;
            this.isExternalSearching = true;
            this.externalResults = [];
            try {
                const res = await fetch(`/api/v1/search_external?query=${encodeURIComponent(this.externalQuery)}`);
                this.externalResults = await res.json();
            } catch (e) {
                this.showToast('External search failed', 'error');
            } finally {
                this.isExternalSearching = false;
            }
        },

        importExternalResult(result) {
            this.showToast(`Importing ${result.title}...`, 'cloud_download');
            let parser = 'yt-dlp';
            if (result.source === 'Bunkr' || result.url.includes('bunkr') || result.url.includes('gofile') || result.url.includes('pixeldrain')) {
                parser = 'cyberdrop-dl-patched';
            }

            fetch('/api/import/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    urls: [result.url],
                    batch_name: `External Search ${new Date().toLocaleDateString()}`,
                    parser: parser
                })
            }).then(r => r.json()).then(d => {
                this.showToast('Import started', 'check_circle');
                this.loadVideos(true);
            }).catch(e => this.showToast('Import failed', 'error'));
        },

        wsLoading: false,
        hasSearchedWs: false,
        wsSort: 'recent',
        wsMinSize: '',
        wsMaxSize: '',
        wsOffset: 0,
        wsTotal: 0,

        async searchWebshare(newSearch = true) {
            if (!this.wsQuery) return;

            if (newSearch) {
                this.wsOffset = 0;
                this.wsResults = [];
                this.hasSearchedWs = false;
                this.wsTotal = 0;
            }

            this.wsLoading = true;
            try {
                const resp = await fetch('/api/v1/webshare/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: this.wsQuery,
                        limit: 50,
                        sort: this.wsSort,
                        min_size: this.wsMinSize ? parseInt(this.wsMinSize) * 1024 * 1024 : null,
                        max_size: this.wsMaxSize ? parseInt(this.wsMaxSize) * 1024 * 1024 : null,
                        offset: this.wsOffset
                    })
                });
                const data = await resp.json();

                if (data.results && data.results.length > 0) {
                    if (newSearch) {
                        this.wsResults = data.results;
                    } else {
                        // Append new results
                        this.wsResults = [...this.wsResults, ...data.results];
                    }
                    this.wsOffset += data.results.length;
                }

                this.wsTotal = data.total || this.wsResults.length;
                this.hasSearchedWs = true;
            } catch (e) {
                this.showToast('Webshare Search Error', 'error');
            } finally {
                this.wsLoading = false;
            }
        },

        async importWebshareFile(file) {
            try {
                await fetch('/api/v1/import/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        urls: [file.link],
                        items: [{
                            url: file.link,
                            title: file.title,
                            thumbnail: file.thumbnail,
                            size_bytes: file.size_bytes
                        }],
                        batch_name: 'Webshare',
                        parser: 'yt-dlp'
                    })
                });

                this.showToast(`Imported: ${file.title}`, 'check_circle', 'success');
            } catch (e) {
                this.showToast('Import failed', 'error');
            }
        }
    };
}

function createDownloadModule() {
    return {
        downloads: {},

        get hasActiveDownloads() {
            return Object.keys(this.downloads || {}).length > 0;
        },

        get primaryDownload() {
            const ids = Object.keys(this.downloads || {});
            if (!ids.length) return null;
            const id = ids[0];
            const raw = this.downloads[id];
            const data = typeof raw === 'number' ? { percent: raw } : (raw || {});
            const percent = typeof data.percent === 'number' ? data.percent : 0;
            const downloadedMb = typeof data.downloaded_mb === 'number' ? data.downloaded_mb : null;
            const totalMb = typeof data.total_mb === 'number' ? data.total_mb : null;
            const speedMb = typeof data.speed_mb_s === 'number' ? data.speed_mb_s : null;
            const video = (this.videos || []).find(v => String(v.id) === String(id));

            let etaSeconds = null;
            if (downloadedMb != null && totalMb != null && speedMb != null && speedMb > 0) {
                const remainingMb = totalMb - downloadedMb;
                if (remainingMb > 0) {
                    etaSeconds = remainingMb / speedMb;
                }
            }

            return {
                id,
                title: video ? video.title : `Video #${id}`,
                percent,
                downloadedMb,
                totalMb,
                speedMb,
                etaSeconds
            };
        },

        formatEta(seconds) {
            if (seconds == null || seconds === Infinity) return '';
            if (seconds < 60) return `${Math.ceil(seconds)}s`;
            const mins = Math.floor(seconds / 60);
            const secs = Math.ceil(seconds % 60);
            return `${mins}m ${secs}s`;
        },

        get downloadSummaryText() {
            const primary = this.primaryDownload;
            if (!primary) return '';
            const count = Object.keys(this.downloads || {}).length;
            const parts = [];

            if (primary.downloadedMb != null && primary.totalMb != null) {
                const left = Math.max(0, primary.totalMb - primary.downloadedMb);
                parts.push(`${primary.downloadedMb.toFixed(1)} / ${primary.totalMb.toFixed(1)} MB (${left.toFixed(1)} MB left)`);
            }

            if (primary.speedMb != null) {
                parts.push(`${primary.speedMb.toFixed(1)} MB/s`);
            }

            if (primary.etaSeconds != null) {
                parts.push(`ETA: ${this.formatEta(primary.etaSeconds)}`);
            }

            if (count > 1) {
                parts.push(`${count} active`);
            }

            return parts.join(' · ');
        },

        get systemStatus() {
            if (this.hasActiveDownloads) {
                const p = this.primaryDownload;
                if (!p) return { text: 'Starting downloads...', type: 'downloading', icon: 'download' };
                let text = `Downloading: ${p.title || 'Video'} (${p.percent || 0}%)`;
                if (p.speedMb != null) text += ` · ${p.speedMb.toFixed(1)} MB/s`;
                if (p.etaSeconds != null) text += ` · ETA: ${this.formatEta(p.etaSeconds)}`;
                return { text, type: 'downloading', icon: 'download' };
            }
            const processing = (this.videos || []).find(v => v.status === 'processing');
            if (processing) {
                return { text: `Processing: ${processing.title}...`, type: 'processing', icon: 'sync' };
            }
            const pending = (this.videos || []).filter(v => v.status === 'pending').length;
            if (pending > 0) {
                return { text: `Idle - ${pending} tasks pending`, type: 'idle', icon: 'queue' };
            }
            return { text: 'System Ready', type: 'ready', icon: 'verified' };
        },

        startDownloadPolling() {
            let failCount = 0;
            const poll = () => {
                fetch('/api/downloads/active')
                    .then(r => r.json())
                    .then(data => {
                        failCount = 0;
                        this.downloads = data || {};
                        setTimeout(poll, 1000);
                    })
                    .catch(() => {
                        failCount++;
                        setTimeout(poll, Math.min(1000 * Math.pow(2, failCount), 30000));
                    });
            };
            setTimeout(poll, 1000);
        },
    };
}

function createCommandModule() {
    return {
        showCommandPalette: false,
        commandQuery: '',
        commandResults: [],
        isCommandSearching: false,
        commands: [
            { id: 'cmd_theme', type: 'command', title: 'Toggle Light/Dark Theme', icon: 'contrast', action: function () { this.settings.theme = this.settings.theme === 'dark' ? 'light' : 'dark'; this.showCommandPalette = false; } },
            { id: 'cmd_batch', type: 'command', title: 'Toggle Batch Mode', icon: 'checklist', action: function () { this.toggleBatchMode(); this.showCommandPalette = false; } },
            { id: 'cmd_fav', type: 'command', title: 'Show Favorites', icon: 'favorite', action: function () { this.filters.favoritesOnly = true; this.loadVideos(true); this.showCommandPalette = false; } },
            { id: 'cmd_home', type: 'command', title: 'Show All Videos', icon: 'dashboard', action: function () { this.filters.favoritesOnly = false; this.loadVideos(true); this.showCommandPalette = false; } },
            { id: 'cmd_splitscreen', type: 'command', title: 'Toggle Split Screen', icon: 'view_column', action: function () { if (this.showPlayer) this.toggleSplitScreen(); else this.showToast('Player must be open'); this.showCommandPalette = false; } },
            { id: 'cmd_netflix', type: 'command', title: 'Toggle Netflix View', icon: 'auto_awesome', action: function () { this.settings.uiMode = this.settings.uiMode === 'netflix' ? 'default' : 'netflix'; this.showToast(`UI Mode: ${this.settings.uiMode}`); this.showCommandPalette = false; } },
            { id: 'cmd_random', type: 'command', title: 'Play Random Video', icon: 'shuffle', action: function () { this.playRandomVideo(); this.showCommandPalette = false; } }
        ],

        playRandomVideo() {
            if (this.videos.length > 0) {
                const randomIndex = Math.floor(Math.random() * this.videos.length);
                this.playVideo(this.videos[randomIndex]);
            } else {
                this.showToast('No videos available to play.', 'info');
            }
        },

        runCommandSearch(q) {
            if (!q.trim()) {
                this.commandResults = this.commands.map(c => ({ ...c, type: 'command' }));
                this.isCommandSearching = false;
                return;
            }
            this.isCommandSearching = true;

            if (q.startsWith('>')) {
                const commandQuery = q.substring(1).toLowerCase();
                this.commandResults = this.commands.filter(c => c.title.toLowerCase().includes(commandQuery));
                this.isCommandSearching = false;
                return;
            }

            this.searchVideos(q).then(videos => {
                const videoResults = videos.map(v => ({ ...v, type: 'video' }));
                const filteredCommands = this.commands.filter(c => c.title.toLowerCase().includes(q.toLowerCase()));
                this.commandResults = [...filteredCommands, ...videoResults];
                this.isCommandSearching = false;
            });
        },

        executeCommandResult(result) {
            if (!result) return;
            if (result.type === 'command') {
                result.action.call(this);
            } else {
                this.playVideo(result);
            }
            this.showCommandPalette = false;
            this.commandQuery = '';
        }
    };
}

function createSmartPlaylistModule() {
    return {
        smartPlaylists: [],
        activeSmartPlaylistId: null,
        showSmartPlaylistModal: false,
        editingPlaylistId: null,
        smartPlaylistForm: { name: '', rules: [] },

        async loadSmartPlaylists() {
            try {
                const res = await fetch('/api/smart-playlists');
                this.smartPlaylists = await res.json();
            } catch (e) {
                console.error('Failed to load smart playlists', e);
            }
        },

        async loadSmartPlaylist(playlistId) {
            this.activeSmartPlaylistId = playlistId;
            this.isLoading = true;
            try {
                const res = await fetch(`/api/smart-playlists/${playlistId}/videos`);
                this.videos = await res.json();
                this.hasMore = false;
            } catch (e) {
                this.showToast('Failed to load playlist videos', 'error', 'error');
            } finally {
                this.isLoading = false;
            }
        },

        openSmartPlaylistModal(playlist = null) {
            if (playlist) {
                this.editingPlaylistId = playlist.id;
                this.smartPlaylistForm.name = playlist.name;
                this.smartPlaylistForm.rules = JSON.parse(JSON.stringify(playlist.rules));
            } else {
                this.editingPlaylistId = null;
                this.smartPlaylistForm.name = '';
                this.smartPlaylistForm.rules = [{ field: 'title', operator: 'contains', value: '' }];
            }
            this.showSmartPlaylistModal = true;
        },

        addSmartPlaylistRule() {
            this.smartPlaylistForm.rules.push({ field: 'title', operator: 'contains', value: '' });
        },

        removeSmartPlaylistRule(index) {
            this.smartPlaylistForm.rules.splice(index, 1);
        },

        async saveSmartPlaylist() {
            const method = this.editingPlaylistId ? 'PUT' : 'POST';
            const url = this.editingPlaylistId ? `/api/smart-playlists/${this.editingPlaylistId}` : '/api/smart-playlists';

            try {
                const res = await fetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.smartPlaylistForm)
                });
                if (res.ok) {
                    this.showToast('Playlist saved', 'check_circle', 'success');
                    this.showSmartPlaylistModal = false;
                    this.loadSmartPlaylists();
                } else {
                    this.showToast('Failed to save playlist', 'error', 'error');
                }
            } catch (e) {
                this.showToast('An error occurred', 'error', 'error');
            }
        }
    };
}

function createBatchModule() {
    return {
        batchMode: false,
        selectedIds: [],

        toggleBatchMode(s) {
            this.batchMode = s !== undefined ? s : !this.batchMode;
            if (!this.batchMode) this.selectedIds = [];
        },

        async runBatch(action) {
            if (confirm(`Action: ${action}?`)) {
                await fetch('/api/batch-action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ video_ids: this.selectedIds, action })
                });
                this.toggleBatchMode(false);
                this.loadVideos(true);
            }
        },

        selectAll() {
            this.selectedIds = this.videos.map(v => v.id);
            this.showToast(`Selected ${this.selectedIds.length} videos`, 'info');
        },

        deselectAll() {
            this.selectedIds = [];
            this.showToast('Selection cleared', 'info');
        },

        selectByQuality(minQuality = '1080p') {
            const order = ['SD', '720p', '1080p', '1440p', '4K'];
            const minIdx = order.indexOf(minQuality);
            if (minIdx === -1) return;
            this.selectedIds = this.videos
                .filter(v => order.indexOf(this.getQuality(v.height)) >= minIdx)
                .map(v => v.id);
            this.showToast(`Selected ${this.selectedIds.length} videos (>= ${minQuality})`, 'info');
        },

        async batchAddTags() {
            if (this.selectedIds.length === 0) {
                this.showToast('No videos selected', 'warning');
                return;
            }
            const tags = prompt('Enter tags (comma-separated):');
            if (!tags) return;

            try {
                const resp = await fetch('/api/batch/tag', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ video_ids: this.selectedIds, tags })
                });
                const data = await resp.json();
                if (data.success) {
                    this.showToast(`Tagged ${data.updated} videos`, 'success');
                    this.loadVideos(true);
                }
            } catch (e) {
                this.showToast('Batch tag failed', 'error');
            }
        },

        async batchDelete() {
            if (this.selectedIds.length === 0) {
                this.showToast('No videos selected', 'warning');
                return;
            }
            if (!confirm(`Delete ${this.selectedIds.length} videos?`)) return;

            try {
                const resp = await fetch('/api/batch/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ video_ids: this.selectedIds })
                });
                const data = await resp.json();
                if (data.success) {
                    this.showToast(`Deleted ${data.deleted} videos`, 'success');
                    this.selectedIds = [];
                    this.loadVideos(true);
                }
            } catch (e) {
                this.showToast('Batch delete failed', 'error');
            }
        },

        isSelected(id) {
            return this.selectedIds.includes(id);
        },

        // Get batch info for a video by batch name
        getBatchInfo(batchName) {
            if (!batchName || !this.batchesDetailed) return null;
            return this.batchesDetailed.find(b => b.name === batchName);
        },

        // Format batch info for display
        formatBatchInfo(batchName) {
            const info = this.getBatchInfo(batchName);
            if (!info) return '';

            const date = info.import_date ? new Date(info.import_date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            }) : 'Unknown';

            let sizeStr = '';
            if (info.total_size_mb) {
                const gb = info.total_size_mb / 1024;
                sizeStr = ` • ${gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(info.total_size_mb) + ' MB'}`;
            }

            return `${info.name} • ${info.size} videos${sizeStr} • Imported: ${date}`;
        }
    };
}

function createPlayerModule() {
    return {
        showPlayer: false,
        splitScreenMode: false,
        secondPickMode: false,
        primaryForSplit: null,
        activeVideo: null,
        activeVideo2: null,
        activePlayerIdx: 0,
        hls1: null,
        hls2: null,
        activePlayerIdx: 0,
        hls1: null,
        hls2: null,
        ambilightInterval: null,
        vFilters: { brightness: 100, contrast: 100, saturate: 100, zoom: 1, preset: 'none', neuralEnabled: false },
        showControls: true,
        controlsTimer: null,

        // VR Mode for main player
        vrMode: false,
        vrViewMode: 'left', // 'left', 'right', 'stereo' - which eye to show for SBS videos
        vrFov: 90, // field of view
        vrRotation: { x: 0, y: 0 }, // rotation for panning
        vrIsDragging: false,
        vrDragStart: { x: 0, y: 0 },
        vrZoom: 1,

        // Duo Player (Flow Mode) state
        duoPlayerMode: false,
        duoLayout: 'horizontal', // 'horizontal' or 'vertical'
        duoSplitRatio: 50, // percentage for first video (0-100)
        duoVideo1: null,
        duoVideo2: null,
        duoZoom1: 1,
        duoZoom2: 1,
        duoPan1: { x: 0, y: 0 },
        duoPan2: { x: 0, y: 0 },
        duoFocused: 1, // which video is focused (1 or 2)
        duoFilters1: { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, sepia: 0, grayscale: 0 },
        duoFilters2: { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, sepia: 0, grayscale: 0 },
        duoSync: false, // sync playback between videos
        duoMuted: { 1: false, 2: true }, // by default mute second video
        duoAspectRatio: { 1: 'fill', 2: 'fill' }, // 'fill' (stretched) or 'contain' (original)
        duoHls: { 1: null, 2: null }, // HLS instances for duo player
        duoPlaybackRate: { 1: 1, 2: 1 }, // playback speed
        duoVR: { 1: false, 2: false }, // VR mode enabled
        duoVRFov: { 1: 90, 2: 90 }, // VR field of view
        duoVRRotation: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 0 } }, // VR rotation
        duoShowFilters: false, // show filter panel
        duoIsDragging: { 1: false, 2: false }, // dragging state for pan
        duoPickMode: false, // pick mode to select video from flow view
        duoPickTarget: 1, // which slot to load the picked video into (1 or 2)

        resetControlsTimer() {
            this.showControls = true;
            if (this.controlsTimer) clearTimeout(this.controlsTimer);
            this.controlsTimer = setTimeout(() => {
                if (this.showPlayer) this.showControls = false;
            }, 10000);
        },

        async initPlayer(video, playerIdx) {
            if (!video) return;
            if (this.isArchivebateVideo(video) || this.isPornhoarderVideo(video) || this.isBunkrPageVideo(video)) {
                // Archivebate/PornHoarder/Bunkr-page videos are rendered as embedded iframe players.
                // No HTML5 <video> source initialization is needed here.
                return;
            }

            const videoRef = playerIdx === 0 ? this.$refs.videoPlayer1 : this.$refs.videoPlayer2;
            if (!videoRef) {
                console.warn(`[Player ${playerIdx}] Video element not found - possibly still rendering. Retrying...`);
                // Retry once after a short delay
                setTimeout(() => {
                    const retryRef = playerIdx === 0 ? this.$refs.videoPlayer1 : this.$refs.videoPlayer2;
                    if (retryRef) this.initPlayer(video, playerIdx);
                }, 50);
                return;
            }

            if (playerIdx === 0 && this.hls1) {
                this.hls1.destroy();
                this.hls1 = null;
            }
            if (playerIdx === 1 && this.hls2) {
                this.hls2.destroy();
                this.hls2 = null;
            }

            videoRef.removeAttribute('src');
            videoRef.load();

            const urlLower = (video.url || '').toLowerCase();
            const isHls = urlLower.includes('.m3u8') || urlLower.includes('/hls/') || urlLower.includes('video-hls') || (urlLower.includes('vkuser.net') && !urlLower.includes('.mp4'));
            const isWebshare = (video.source_url && (video.source_url.includes('webshare.cz') || video.source_url.includes('wsfiles.cz'))) || (video.url && video.url.startsWith('webshare:'));

            console.log(`[Player ${playerIdx}] Initializing video ${video.id || 'N/A'}:`, {
                title: video.title ? video.title.substring(0, 30) : 'N/A',
                isWebshare,
                isHls,
                url: video.url ? video.url.substring(0, 100) : 'N/A',
                hlsAvailable: typeof Hls !== 'undefined' && Hls.isSupported()
            });

            let src = null;

            const sourceUrlLower = (video.source_url || '').toLowerCase();
            const isPornhoarder = sourceUrlLower.includes('pornhoarder.');
            const isLeakLike = sourceUrlLower.includes('leakporner.') || sourceUrlLower.includes('djav.org');
            const directHlsUrl = video.url && video.url.startsWith('http') ? video.url : null;

            if (isWebshare) {
                // For Webshare, we ONLY play if we have a resolved http(s) link.
                if (video.url && video.url.startsWith('http')) {
                    src = video.url;
                    console.log(`[Player ${playerIdx}] Using direct Webshare VIP URL for playback.`);
                } else {
                    // If the URL is not a VIP link (e.g., it's still 'webshare:ident'), we can't play it.
                    this.showToast('Webshare video is still processing. Please wait for the "Ready" notification.', 'hourglass_empty', 'info');
                    console.warn(`[Player ${playerIdx}] Webshare video ${video.id} not ready for playback. URL is: ${video.url}`);
                    return; // Abort playback initialization
                }
            } else if (video.storage_type === 'local_direct' && video.url) {
                // For local_direct videos, use the local file stream endpoint
                src = `/api/v1/videos/${video.id}/stream`;
                console.log(`[Player ${playerIdx}] Using native browser playback for local file via stream endpoint.`);
            } else if (isHls && directHlsUrl) {
                // Some providers need direct HLS playback, but LeakPorner/DJAV
                // must stay proxied because the browser blocks the raw manifest
                // on CORS before Hls.js can resolve the segments.
                if (isPornhoarder) {
                    src = directHlsUrl;
                    console.log(`[Player ${playerIdx}] Using direct HLS URL for PornHoarder stream`);
                } else {
                    // Route HLS through backend proxy so .ts segments get correct Referer header
                    const hlsReferer = video.source_url ? encodeURIComponent(new URL(video.source_url).origin + '/') : '';
                    src = `/hls_proxy?url=${encodeURIComponent(video.url)}&referer=${hlsReferer}`;
                    console.log(`[Player ${playerIdx}] Using HLS rewriting proxy`);
                }
            } else {
                src = `/stream_proxy/${video.id}.mp4`;
                console.log(`[Player ${playerIdx}] Using proxy for local/unknown file.`);
            }

            if (!src) {
                console.error(`[Player ${playerIdx}] Could not determine a valid source URL for video ${video.id}.`);
                this.showToast('Cannot play video: source URL is missing.', 'error', 'error');
                return;
            }

            // Use HLS.js for HLS streams, but NOT for Webshare, as it handles its own streaming.
            if (typeof Hls !== 'undefined' && Hls.isSupported() && isHls && !isWebshare) {
                console.log(`[Player ${playerIdx}] Attaching HLS.js to video element.`);
                const hls = new Hls({
                    fragLoadingMaxRetry: 5,
                    fragLoadingMaxRetryTimeout: 20000,
                    levelLoadingMaxRetry: 5,
                    levelLoadingMaxRetryTimeout: 20000,
                });
                if (playerIdx === 0) this.hls1 = hls;
                else this.hls2 = hls;

                const safePlay = () => {
                    if (!this.settings.autoplay) return;
                    const playPromise = videoRef.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch((err) => {
                            if (!err || err.name !== 'AbortError') {
                                console.warn(`[HLS ${playerIdx}] play() failed:`, err);
                            }
                        });
                    }
                };

                hls.loadSource(src);
                hls.attachMedia(videoRef);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    safePlay();
                });
                hls.on(Hls.Events.ERROR, function (event, data) {
                    if (data.fatal) {
                        console.error(`[HLS ${playerIdx}] Fatal Error:`, data);
                        // Fallback: if proxy URL failed, retry once with direct HLS URL.
                        if (src && src.startsWith('/hls_proxy') && directHlsUrl && !isLeakLike) {
                            try {
                                hls.stopLoad();
                                hls.destroy();
                            } catch (_) {}
                            videoRef.pause();
                            videoRef.src = directHlsUrl;
                            videoRef.load();
                            videoRef.addEventListener('canplay', () => {
                                const playPromise = this.settings.autoplay ? videoRef.play() : null;
                                if (playPromise && typeof playPromise.catch === 'function') {
                                    playPromise.catch((err) => {
                                        if (!err || err.name !== 'AbortError') {
                                            console.warn(`[HLS ${playerIdx}] direct fallback play() failed:`, err);
                                        }
                                    });
                                }
                            }, { once: true });
                            console.warn(`[HLS ${playerIdx}] Retrying with direct HLS URL after proxy fatal.`);
                        }
                    }
                }.bind(this));
            } else {
                console.log(`[Player ${playerIdx}] Using native browser playback for src: ${src.substring(0, 100)}...`);
                videoRef.src = src;
                videoRef.load();
                videoRef.addEventListener('canplay', () => {
                    const playPromise = this.settings.autoplay ? videoRef.play() : null;
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch((err) => {
                            if (!err || err.name !== 'AbortError') {
                                console.warn(`[Player ${playerIdx}] play() failed:`, err);
                            }
                        });
                    }
                }, { once: true });
            }

            // Start Ambilight - unified handler for both players
            if (!this.ambilightInterval) {
                const canvas = document.getElementById('ambilight-canvas');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    this.ambilightInterval = setInterval(() => {
                        const activeRef = this.activePlayerIdx === 0 ? this.$refs.videoPlayer1 : this.$refs.videoPlayer2;
                        if (activeRef && !activeRef.paused && !activeRef.ended) {
                            try {
                                ctx.drawImage(activeRef, 0, 0, canvas.width, canvas.height);
                            } catch (e) {
                                // Ignore errors if video is not ready
                            }
                        }
                    }, 100);
                }
            }
        },

        isArchivebateVideo(video) {
            if (!video) return false;
            const src = String(video.source_url || '').toLowerCase();
            return src.includes('archivebate.com/watch/');
        },

        isPornhoarderVideo(video) {
            if (!video) return false;
            const src = String(video.source_url || '').toLowerCase();
            return /pornhoarder\.(io|net|pictures)\/watch\//i.test(src);
        },

        isBunkrPageVideo(video) {
            if (!video) return false;
            const src = String(video.source_url || '').toLowerCase();
            const url = String(video.url || '').toLowerCase();
            const hasBunkr = /bunkr\./i.test(src) || /bunkr\./i.test(url);
            const pageLike = /\/(f|v)\//i.test(src) || /\/(f|v)\//i.test(url);
            const hasDirectCdn = /scdn\.st|media-files|stream-files/i.test(url);
            return hasBunkr && pageLike && !hasDirectCdn;
        },

        archivebateEmbedUrl(video) {
            if (!this.isArchivebateVideo(video)) return '';
            const stream = String(video.url || '').trim();
            const source = String(video.source_url || '').trim();

            // Prefer canonical media id from resolved Archivebate stream URL:
            // https://a-deliveryXX.mxcontent.net/v2/<id>.mp4?... -> <id>
            let embedId = '';
            let m = stream.match(/\/v2\/([a-zA-Z0-9_-]+)\.mp4/i);
            if (m) embedId = m[1];

            // Secondary fallback if URL is already an /e/<id> embed URL.
            if (!embedId) {
                m = stream.match(/\/e\/([a-zA-Z0-9_-]+)/i);
                if (m) embedId = m[1];
            }

            // Last fallback: watch-page id (less reliable, keep only as fallback).
            if (!embedId) {
                m = source.match(/\/watch\/([a-zA-Z0-9_-]+)/i);
                if (m) embedId = m[1];
            }

            if (!embedId) return source || stream;
            return `https://mixdrop.ag/e/${embedId}`;
        },

        pornhoarderEmbedUrl(video) {
            if (!this.isPornhoarderVideo(video)) return '';
            const source = String(video.source_url || '').trim();
            const stream = String(video.url || '').trim();
            const stats = video.download_stats && typeof video.download_stats === 'object' ? video.download_stats : null;
            const storedPlayer = String((stats && stats.player_url) || '').trim();
            if (storedPlayer && /^https?:\/\//i.test(storedPlayer)) {
                return storedPlayer.replace('/player.php?', '/player_t.php?');
            }

            // Canonical PH watch URL pattern: /watch/<slug>/<token>
            // Use the token to reconstruct embeddable player URL.
            let token = '';
            let m = source.match(/\/watch\/[^/]+\/([^/?#]+)/i);
            if (m) token = m[1];

            // Fallback: if stream already points to player page, normalize to player_t.
            if (!token && /\/player(?:_t)?\.php\?video=/i.test(stream)) {
                return stream.replace('/player.php?', '/player_t.php?');
            }
            if (!token) return source || stream;
            return `https://pornhoarder.net/player_t.php?video=${encodeURIComponent(token)}`;
        },

        bunkrEmbedUrl(video) {
            if (!this.isBunkrPageVideo(video)) return '';
            return String(video.source_url || video.url || '').trim();
        },

        playVideo(video) {
            if (video.status !== 'ready' && video.status !== 'ready_to_stream') return this.showToast('Video processing...', 'hourglass_empty');

            if (this.showPlayer && this.splitScreenMode) {
                if (this.activePlayerIdx === 1) {
                    this.activeVideo2 = video;
                    this.$nextTick(() => this.initPlayer(video, 1));
                } else {
                    this.activeVideo = video;
                    this.$nextTick(() => this.initPlayer(video, 0));
                }
            } else {
                this.activeVideo = video;
                this.showPlayer = true;
                this.resetControlsTimer();
                this.$nextTick(() => this.initPlayer(video, 0));
            }

            this.showCommandPalette = false;
        },

        getContainerStyle() {
            if (!this.showPlayer) return '';
            const phPrimary = this.activeVideo && this.isPornhoarderVideo(this.activeVideo);
            const phSecondary = this.splitScreenMode && this.activeVideo2 && this.isPornhoarderVideo(this.activeVideo2);
            if (phPrimary || phSecondary) {
                return 'width: 98vw !important; height: 90vh !important; max-width: 100vw; max-height: 95vh; transition: all 0.2s ease-out;';
            }
            const zoom = parseFloat(this.vFilters.zoom || 1);
            if (zoom <= 1) return '';
            const height = Math.min(100, 75 + (zoom - 1) * 12.5);
            const width = Math.min(100, 90 + (zoom - 1) * 5);
            return `width: ${width}vw !important; height: ${height}vh !important; max-width: 100vw; max-height: 100vh; transition: all 0.2s ease-out;`;
        },

        getPlayerStyle(idx) {
            const f = this.vFilters;
            let filter = `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%)`;

            if (f.neuralEnabled) {
                filter += ' contrast(110%) saturate(110%) brightness(105%)';
            }

            switch (f.preset) {
                case 'grayscale': filter += ' grayscale(100%)'; break;
                case 'sepia': filter += ' sepia(100%)'; break;
                case 'invert': filter += ' invert(100%)'; break;
                case 'thermal': filter = 'contrast(200%) hue-rotate(280deg)'; break;
                case 'nightvision': filter = 'grayscale(100%) brightness(170%) contrast(1.5) sepia(20%) hue-rotate(50deg)'; break;
            }

            // VR mode transforms for 180° SBS videos
            if (this.vrMode) {
                const zoom = this.vrZoom * f.zoom;
                const rotX = this.vrRotation.x;
                const rotY = this.vrRotation.y;

                // For SBS (side-by-side) VR videos, we show only half the video
                // Left eye = left half, Right eye = right half
                let translateX = 0;
                let scaleX = 1;

                if (this.vrViewMode === 'left') {
                    // Show left half only (left eye view), scale to fill
                    translateX = 25; // Move right to center the left half
                    scaleX = 2; // Double width to show only left half
                } else if (this.vrViewMode === 'right') {
                    // Show right half only (right eye view), scale to fill
                    translateX = -25; // Move left to center the right half
                    scaleX = 2;
                }
                // 'stereo' mode shows full SBS video

                return `filter: ${filter}; transform: scale(${scaleX * zoom}, ${zoom}) translateX(${translateX}%) perspective(1000px) rotateY(${rotY}deg) rotateX(${rotX}deg); transform-origin: center; ${f.neuralEnabled ? 'image-rendering: -webkit-optimize-contrast;' : ''}`;
            }

            return `filter: ${filter}; transform: scale(${f.zoom}); transform-origin: center; ${f.neuralEnabled ? 'image-rendering: -webkit-optimize-contrast;' : ''}`;
        },

        resetFilters() {
            this.vFilters = { brightness: 100, contrast: 100, saturate: 100, zoom: 1, preset: 'none', neuralEnabled: false };
            // Also reset VR settings
            this.vrRotation = { x: 0, y: 0 };
            this.vrZoom = 1;
        },

        // VR Mode Controls for main player
        toggleVrMode() {
            this.vrMode = !this.vrMode;
            if (this.vrMode) {
                // Reset VR rotation when entering VR mode
                this.vrRotation = { x: 0, y: 0 };
                this.vrZoom = 1;
                this.showToast(`VR Mode ON (${this.vrViewMode === 'left' ? 'Left Eye' : this.vrViewMode === 'right' ? 'Right Eye' : 'Stereo'})`, 'vrpano', 'info');
            } else {
                this.showToast('VR Mode OFF', 'vrpano');
            }
        },

        cycleVrViewMode() {
            const modes = ['left', 'right', 'stereo'];
            const currentIdx = modes.indexOf(this.vrViewMode);
            this.vrViewMode = modes[(currentIdx + 1) % modes.length];
            const labels = { left: 'Left Eye', right: 'Right Eye', stereo: 'Full Stereo SBS' };
            this.showToast(`VR View: ${labels[this.vrViewMode]}`, 'visibility');
        },

        handleVrWheel(event) {
            if (!this.vrMode) return;
            event.preventDefault();
            const delta = event.deltaY > 0 ? -0.1 : 0.1;
            this.vrZoom = Math.max(0.5, Math.min(4, this.vrZoom + delta));
        },

        handleVrMouseDown(event) {
            if (!this.vrMode) return;
            this.vrIsDragging = true;
            this.vrDragStart = { x: event.clientX, y: event.clientY };
        },

        handleVrMouseMove(event) {
            if (!this.vrMode || !this.vrIsDragging) return;
            const deltaX = event.clientX - this.vrDragStart.x;
            const deltaY = event.clientY - this.vrDragStart.y;

            // Rotate view (limited to reasonable angles for 180° VR)
            this.vrRotation.y = Math.max(-90, Math.min(90, this.vrRotation.y + deltaX * 0.3));
            this.vrRotation.x = Math.max(-45, Math.min(45, this.vrRotation.x - deltaY * 0.2));

            this.vrDragStart = { x: event.clientX, y: event.clientY };
        },

        handleVrMouseUp() {
            this.vrIsDragging = false;
        },

        resetVrView() {
            this.vrRotation = { x: 0, y: 0 };
            this.vrZoom = 1;
            this.showToast('VR View Reset', 'restart_alt');
        },

        screenshot(idx) {
            const vid = idx === 0 ? this.$refs.videoPlayer1 : this.$refs.videoPlayer2;
            if (!vid) return;
            const canvas = document.createElement('canvas');
            canvas.width = vid.videoWidth;
            canvas.height = vid.videoHeight;
            canvas.getContext('2d').drawImage(vid, 0, 0);
            const link = document.createElement('a');
            link.download = `snap_${Date.now()}.jpg`;
            link.href = canvas.toDataURL('image/jpeg');
            link.click();
            this.showToast('Screenshot saved', 'camera_alt');
        },

        toggleSplitScreen() {
            this.splitScreenMode = !this.splitScreenMode;
            if (!this.splitScreenMode) {
                this.activeVideo2 = null;
                this.secondPickMode = false;
                this.primaryForSplit = null;
                if (this.hls2) {
                    this.hls2.destroy();
                    this.hls2 = null;
                }
            }
            this.showToast(this.splitScreenMode ? 'Split Screen ON' : 'Split Screen OFF', 'view_column');
        },

        async regenerateThumb(video) {
            this.showToast('Regenerating...', 'refresh');
            try {
                const mode = this.settings.useHls ? 'hls' : 'mp4';
                const res = await fetch(`/api/videos/${video.id}/regenerate?mode=${mode}`, { method: 'POST' });
                if (res.ok) {
                    this.showToast('Queued for processing', 'check_circle');
                    video.status = 'processing';
                    this.startPolling();
                }
            } catch (e) {
                this.showToast('Error starting regeneration', 'error', 'error');
            }
        },

        async regenerateThumbAll() {
            if (!this.selectedIds.length) return;
            this.showToast('Batch regenerating...', 'refresh');
            const mode = this.settings.useHls ? 'hls' : 'mp4';
            for (const id of this.selectedIds) {
                try {
                    await fetch(`/api/videos/${id}/regenerate?mode=${mode}`, { method: 'POST' });
                } catch (e) {
                }
            }
            this.showToast('Všetky označené videá boli poslané na regeneráciu', 'check_circle');
            this.startPolling();
        },

        focusPlayer(idx) {
            this.activePlayerIdx = idx;
            if (this.splitScreenMode && this.showPlayer && idx === 1) {
                this.showToast('Right player selected - next gallery click will load here.', 'view_column');
            }
        },

        closePlayer() {
            this.showPlayer = false;
            this.activeVideo = null;
            this.activeVideo2 = null;
            this.splitScreenMode = false;
            this.secondPickMode = false;
            this.primaryForSplit = null;
            // Reset VR mode
            this.vrMode = false;
            this.vrRotation = { x: 0, y: 0 };
            this.vrZoom = 1;
            this.vrIsDragging = false;
            if (this.hls1) {
                this.hls1.destroy();
                this.hls1 = null;
            }
            if (this.hls2) {
                this.hls2.destroy();
                this.hls2 = null;
            }
            if (this.ambilightInterval) {
                clearInterval(this.ambilightInterval);
                this.ambilightInterval = null;
            }
        },

        // ==================== DUO PLAYER (FLOW MODE) ====================
        openDuoPlayer(video1, video2) {
            this.duoPlayerMode = true;
            this.duoVideo1 = video1;
            this.duoVideo2 = video2 || null;
            this.duoFocused = 1;
            this.duoZoom1 = 1;
            this.duoZoom2 = 1;
            this.duoPan1 = { x: 0, y: 0 };
            this.duoPan2 = { x: 0, y: 0 };
            this.duoVR = { 1: false, 2: false };
            this.duoVRRotation = { 1: { x: 0, y: 0 }, 2: { x: 0, y: 0 } };
            this.$nextTick(() => {
                this.initDuoPlayer(1);
                if (video2) this.initDuoPlayer(2);
            });
        },

        closeDuoPlayer() {
            this.duoPlayerMode = false;
            this.duoPickMode = false;
            const v1 = this.$refs.duoVideo1;
            const v2 = this.$refs.duoVideo2;
            if (v1) v1.pause();
            if (v2) v2.pause();
            // Destroy HLS instances
            if (this.duoHls[1]) { this.duoHls[1].destroy(); this.duoHls[1] = null; }
            if (this.duoHls[2]) { this.duoHls[2].destroy(); this.duoHls[2] = null; }
            this.duoVideo1 = null;
            this.duoVideo2 = null;
            this.duoShowFilters = false;
        },

        // Enter pick mode - hides duo player so user can select a video from flow view
        enterDuoPickMode(targetSlot) {
            this.duoPickTarget = targetSlot;
            this.duoPickMode = true;
            this.duoPlayerMode = false; // Hide the player temporarily
            this.showToast(`Click a video to load into slot ${targetSlot}`, 'touch_app', 'info');
        },

        // Cancel pick mode
        cancelDuoPickMode() {
            this.duoPickMode = false;
            this.duoPlayerMode = true; // Show the player again
        },

        async initDuoPlayer(playerNum) {
            const video = playerNum === 1 ? this.duoVideo1 : this.duoVideo2;
            if (!video) return;

            const videoRef = playerNum === 1 ? this.$refs.duoVideo1 : this.$refs.duoVideo2;
            if (!videoRef) {
                setTimeout(() => this.initDuoPlayer(playerNum), 100);
                return;
            }

            // Destroy previous HLS instance if exists
            if (this.duoHls[playerNum]) {
                this.duoHls[playerNum].destroy();
                this.duoHls[playerNum] = null;
            }

            videoRef.removeAttribute('src');
            videoRef.load();

            let src = '';
            const urlLower = (video.url || '').toLowerCase();
            const isHls = urlLower.includes('.m3u8') || urlLower.includes('/hls/') || urlLower.includes('video-hls');
            const isWebshare = video.source_url?.includes('webshare.cz') || video.url?.startsWith('webshare:');

            if (isWebshare && video.url && video.url.startsWith('http')) {
                src = video.url;
            } else if (video.storage_type === 'local_direct' || video.storage_type === 'local') {
                src = `/api/v1/videos/${video.id}/stream`;
            } else if (isHls && video.url && video.url.startsWith('http')) {
                src = video.url;
            } else if (video.url && video.url.startsWith('http')) {
                src = video.url;
            } else {
                src = `/stream_proxy/${video.id}.mp4`;
            }

            console.log(`[DuoPlayer ${playerNum}] Loading: ${video.title?.substring(0, 30)}`, { src: src.substring(0, 80), isHls });

            if (isHls && window.Hls && Hls.isSupported()) {
                const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
                this.duoHls[playerNum] = hls;
                hls.loadSource(src);
                hls.attachMedia(videoRef);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    videoRef.muted = this.duoMuted[playerNum];
                    videoRef.playbackRate = this.duoPlaybackRate[playerNum];
                    videoRef.play().catch(e => console.log('Autoplay blocked:', e));
                });
            } else {
                videoRef.src = src;
                videoRef.muted = this.duoMuted[playerNum];
                videoRef.playbackRate = this.duoPlaybackRate[playerNum];
                videoRef.play().catch(e => console.log('Autoplay blocked:', e));
            }
        },

        setDuoVideo(playerNum, video) {
            console.log(`[DuoPlayer] Setting video ${playerNum}:`, video?.title?.substring(0, 30));
            if (playerNum === 1) {
                this.duoVideo1 = video;
            } else {
                this.duoVideo2 = video;
            }
            this.duoFocused = playerNum;
            this.$nextTick(() => this.initDuoPlayer(playerNum));
            this.showToast(`Video ${playerNum} loaded`, 'play_circle');
        },

        focusDuoPlayer(num) {
            this.duoFocused = num;
        },

        toggleDuoLayout() {
            this.duoLayout = this.duoLayout === 'horizontal' ? 'vertical' : 'horizontal';
            this.showToast(`Layout: ${this.duoLayout}`, 'view_agenda');
        },

        adjustDuoSplit(delta) {
            this.duoSplitRatio = Math.max(10, Math.min(90, this.duoSplitRatio + delta));
        },

        setDuoZoom(playerNum, zoom) {
            const maxZoom = this.duoVR[playerNum] ? 3 : 5;
            if (playerNum === 1) {
                this.duoZoom1 = Math.max(0.5, Math.min(maxZoom, zoom));
            } else {
                this.duoZoom2 = Math.max(0.5, Math.min(maxZoom, zoom));
            }
        },

        adjustDuoZoom(playerNum, delta) {
            const current = playerNum === 1 ? this.duoZoom1 : this.duoZoom2;
            this.setDuoZoom(playerNum, current + delta);
        },

        setDuoPan(playerNum, x, y) {
            if (playerNum === 1) {
                this.duoPan1 = { x, y };
            } else {
                this.duoPan2 = { x, y };
            }
        },

        resetDuoView(playerNum) {
            this.setDuoZoom(playerNum, 1);
            this.setDuoPan(playerNum, 0, 0);
            this.duoVRRotation[playerNum] = { x: 0, y: 0 };
            if (playerNum === 1) {
                this.duoFilters1 = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, sepia: 0, grayscale: 0 };
            } else {
                this.duoFilters2 = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, sepia: 0, grayscale: 0 };
            }
            this.duoPlaybackRate[playerNum] = 1;
            const videoRef = playerNum === 1 ? this.$refs.duoVideo1 : this.$refs.duoVideo2;
            if (videoRef) videoRef.playbackRate = 1;
            this.showToast('View reset', 'restart_alt');
        },

        // Toggle aspect ratio between stretched (fill) and original (contain)
        toggleDuoAspectRatio(playerNum) {
            this.duoAspectRatio[playerNum] = this.duoAspectRatio[playerNum] === 'fill' ? 'contain' : 'fill';
            this.showToast(`Video ${playerNum}: ${this.duoAspectRatio[playerNum] === 'fill' ? 'Stretched' : 'Original'}`, 'aspect_ratio');
        },

        getDuoVideoStyle(playerNum) {
            const zoom = playerNum === 1 ? this.duoZoom1 : this.duoZoom2;
            const pan = playerNum === 1 ? this.duoPan1 : this.duoPan2;
            const filters = playerNum === 1 ? this.duoFilters1 : this.duoFilters2;
            const aspectRatio = this.duoAspectRatio[playerNum];
            const isVR = this.duoVR[playerNum];
            const vrRot = this.duoVRRotation[playerNum];

            let filterStr = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturate}%)`;
            if (filters.hue) filterStr += ` hue-rotate(${filters.hue}deg)`;
            if (filters.blur) filterStr += ` blur(${filters.blur}px)`;
            if (filters.sepia) filterStr += ` sepia(${filters.sepia}%)`;
            if (filters.grayscale) filterStr += ` grayscale(${filters.grayscale}%)`;

            let transformStr;
            if (isVR) {
                // VR mode: use perspective transform for 180° view
                transformStr = `perspective(1000px) rotateX(${vrRot.x}deg) rotateY(${vrRot.y}deg) scale(${zoom})`;
            } else {
                transformStr = `scale(${zoom}) translate(${pan.x}%, ${pan.y}%)`;
            }

            return `object-fit: ${aspectRatio}; transform: ${transformStr}; filter: ${filterStr};`;
        },

        getDuoContainerStyle(playerNum) {
            if (this.duoLayout === 'horizontal') {
                return playerNum === 1
                    ? `width: ${this.duoSplitRatio}%; height: 100%;`
                    : `width: ${100 - this.duoSplitRatio}%; height: 100%;`;
            } else {
                return playerNum === 1
                    ? `width: 100%; height: ${this.duoSplitRatio}%;`
                    : `width: 100%; height: ${100 - this.duoSplitRatio}%;`;
            }
        },

        toggleDuoMute(playerNum) {
            this.duoMuted[playerNum] = !this.duoMuted[playerNum];
            const videoRef = playerNum === 1 ? this.$refs.duoVideo1 : this.$refs.duoVideo2;
            if (videoRef) videoRef.muted = this.duoMuted[playerNum];
        },

        toggleDuoSync() {
            this.duoSync = !this.duoSync;
            this.showToast(this.duoSync ? 'Playback synced' : 'Playback independent', 'sync');
            if (this.duoSync) {
                const v1 = this.$refs.duoVideo1;
                const v2 = this.$refs.duoVideo2;
                if (v1 && v2) {
                    v2.currentTime = v1.currentTime;
                    v2.playbackRate = v1.playbackRate;
                }
            }
        },

        duoPlayPause() {
            const v1 = this.$refs.duoVideo1;
            const v2 = this.$refs.duoVideo2;
            const focused = this.duoFocused === 1 ? v1 : v2;
            if (focused) {
                if (focused.paused) {
                    focused.play();
                    if (this.duoSync) {
                        if (v1) v1.play();
                        if (v2) v2.play();
                    }
                } else {
                    focused.pause();
                    if (this.duoSync) {
                        if (v1) v1.pause();
                        if (v2) v2.pause();
                    }
                }
            }
        },

        duoSeek(seconds) {
            const v1 = this.$refs.duoVideo1;
            const v2 = this.$refs.duoVideo2;
            const focused = this.duoFocused === 1 ? v1 : v2;
            if (focused) {
                focused.currentTime = Math.max(0, Math.min(focused.duration, focused.currentTime + seconds));
                if (this.duoSync) {
                    if (v1) v1.currentTime = focused.currentTime;
                    if (v2) v2.currentTime = focused.currentTime;
                }
            }
        },

        swapDuoVideos() {
            const temp = this.duoVideo1;
            this.duoVideo1 = this.duoVideo2;
            this.duoVideo2 = temp;
            // Also swap aspect ratios and other settings
            const tempAR = this.duoAspectRatio[1];
            this.duoAspectRatio[1] = this.duoAspectRatio[2];
            this.duoAspectRatio[2] = tempAR;
            this.$nextTick(() => {
                if (this.duoVideo1) this.initDuoPlayer(1);
                if (this.duoVideo2) this.initDuoPlayer(2);
            });
            this.showToast('Videos swapped', 'swap_horiz');
        },

        duoFullscreen() {
            const el = document.querySelector('.duo-player-overlay');
            if (el) {
                if (!document.fullscreenElement) el.requestFullscreen();
                else document.exitFullscreen();
            }
        },

        startDuoResize(e) {
            const container = document.querySelector('.duo-player-container');
            if (!container) return;

            const isVertical = this.duoLayout === 'vertical';
            const startPos = isVertical ? e.clientY : e.clientX;
            const startRatio = this.duoSplitRatio;
            const containerRect = container.getBoundingClientRect();
            const containerSize = isVertical ? containerRect.height : containerRect.width;

            const onMouseMove = (moveEvent) => {
                const currentPos = isVertical ? moveEvent.clientY : moveEvent.clientX;
                const delta = currentPos - startPos;
                const deltaPercent = (delta / containerSize) * 100;
                this.duoSplitRatio = Math.max(10, Math.min(90, startRatio + deltaPercent));
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        },

        handleDuoWheel(playerNum, e) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.15 : 0.15;
            this.adjustDuoZoom(playerNum, delta);
        },

        handleDuoPan(playerNum, e) {
            if (e.buttons !== 1) return;
            this.duoIsDragging[playerNum] = true;

            const isVR = this.duoVR[playerNum];

            if (isVR) {
                // VR mode: rotate the view
                const rot = this.duoVRRotation[playerNum];
                const newX = Math.max(-60, Math.min(60, rot.x - e.movementY * 0.3));
                const newY = Math.max(-180, Math.min(180, rot.y + e.movementX * 0.3));
                this.duoVRRotation[playerNum] = { x: newX, y: newY };
            } else {
                // Normal mode: pan
                const zoom = playerNum === 1 ? this.duoZoom1 : this.duoZoom2;
                if (zoom <= 1) return;

                const pan = playerNum === 1 ? this.duoPan1 : this.duoPan2;
                const maxPan = (zoom - 1) * 30;
                const newX = Math.max(-maxPan, Math.min(maxPan, pan.x + e.movementX * 0.15));
                const newY = Math.max(-maxPan, Math.min(maxPan, pan.y + e.movementY * 0.15));
                this.setDuoPan(playerNum, newX, newY);
            }
        },

        handleDuoMouseUp(playerNum) {
            this.duoIsDragging[playerNum] = false;
        },

        // VR Mode toggle
        toggleDuoVR(playerNum) {
            this.duoVR[playerNum] = !this.duoVR[playerNum];
            if (this.duoVR[playerNum]) {
                // Reset rotation and set initial zoom for VR
                this.duoVRRotation[playerNum] = { x: 0, y: 0 };
                this.setDuoZoom(playerNum, 1.5);
                this.duoAspectRatio[playerNum] = 'fill';
            } else {
                this.setDuoZoom(playerNum, 1);
            }
            this.showToast(`VR Mode: ${this.duoVR[playerNum] ? 'ON' : 'OFF'}`, 'vrpano');
        },

        // Adjust VR field of view
        adjustDuoVRFov(playerNum, delta) {
            this.duoVRFov[playerNum] = Math.max(60, Math.min(120, this.duoVRFov[playerNum] + delta));
        },

        // Playback speed control
        setDuoPlaybackRate(playerNum, rate) {
            this.duoPlaybackRate[playerNum] = rate;
            const videoRef = playerNum === 1 ? this.$refs.duoVideo1 : this.$refs.duoVideo2;
            if (videoRef) videoRef.playbackRate = rate;
            if (this.duoSync) {
                const otherRef = playerNum === 1 ? this.$refs.duoVideo2 : this.$refs.duoVideo1;
                if (otherRef) otherRef.playbackRate = rate;
                this.duoPlaybackRate[playerNum === 1 ? 2 : 1] = rate;
            }
            this.showToast(`Speed: ${rate}x`, 'speed');
        },

        cycleDuoPlaybackRate(playerNum) {
            const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
            const current = this.duoPlaybackRate[playerNum];
            const idx = rates.indexOf(current);
            const nextIdx = (idx + 1) % rates.length;
            this.setDuoPlaybackRate(playerNum, rates[nextIdx]);
        },

        // Filter adjustments
        setDuoFilter(playerNum, filter, value) {
            if (playerNum === 1) {
                this.duoFilters1[filter] = value;
            } else {
                this.duoFilters2[filter] = value;
            }
        },

        // Screenshot
        duoScreenshot(playerNum) {
            const videoRef = playerNum === 1 ? this.$refs.duoVideo1 : this.$refs.duoVideo2;
            if (!videoRef) return;

            const canvas = document.createElement('canvas');
            canvas.width = videoRef.videoWidth;
            canvas.height = videoRef.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoRef, 0, 0);

            const link = document.createElement('a');
            link.download = `duo-screenshot-${playerNum}-${Date.now()}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            this.showToast('Screenshot saved', 'camera_alt');
        },

        // Picture-in-Picture for duo
        async duoPip(playerNum) {
            const videoRef = playerNum === 1 ? this.$refs.duoVideo1 : this.$refs.duoVideo2;
            if (!videoRef || !document.pictureInPictureEnabled) {
                this.showToast('PiP not supported', 'error');
                return;
            }
            try {
                if (document.pictureInPictureElement === videoRef) {
                    await document.exitPictureInPicture();
                } else {
                    await videoRef.requestPictureInPicture();
                }
            } catch (err) {
                this.showToast('PiP failed', 'error');
            }
        },

        // Loop toggle
        toggleDuoLoop(playerNum) {
            const videoRef = playerNum === 1 ? this.$refs.duoVideo1 : this.$refs.duoVideo2;
            if (videoRef) {
                videoRef.loop = !videoRef.loop;
                this.showToast(`Loop: ${videoRef.loop ? 'ON' : 'OFF'}`, 'loop');
            }
        },

        // Mirror/Flip video
        duoMirror: { 1: { h: false, v: false }, 2: { h: false, v: false } },

        toggleDuoMirror(playerNum, direction) {
            if (!this.duoMirror) {
                this.duoMirror = { 1: { h: false, v: false }, 2: { h: false, v: false } };
            }
            this.duoMirror[playerNum][direction] = !this.duoMirror[playerNum][direction];
        },

        getDuoMirrorStyle(playerNum) {
            if (!this.duoMirror) return '';
            const m = this.duoMirror[playerNum];
            const scaleX = m?.h ? -1 : 1;
            const scaleY = m?.v ? -1 : 1;
            return `scale(${scaleX}, ${scaleY})`;
        },
        // ==================== END DUO PLAYER ====================

        togglePlay() {
            const v1 = this.$refs.videoPlayer1;
            const v2 = this.$refs.videoPlayer2;
            if (this.activePlayerIdx === 0 && v1) v1.paused ? v1.play() : v1.pause();
            if (this.activePlayerIdx === 1 && v2) v2.paused ? v2.play() : v2.pause();
        },

        toggleFullscreen() {
            const el = document.querySelector('.player-container');
            if (!document.fullscreenElement) el.requestFullscreen();
            else document.exitFullscreen();
        },

        async togglePip() {
            const video = this.activePlayerIdx === 0 ? this.$refs.videoPlayer1 : this.$refs.videoPlayer2;
            if (!video || !document.pictureInPictureEnabled) {
                this.showToast('PiP not supported', 'error', 'error');
                return;
            }
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else {
                    await video.requestPictureInPicture();
                }
            } catch (err) {
                this.showToast('PiP mode failed', 'error', 'error');
                console.error('PiP Error:', err);
            }
        },

        onTimeUpdate(e, v) {
            if (v && Math.random() > 0.95) {
                fetch(`/api/videos/${v.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ resume_time: e.target.currentTime })
                });
            }
        },

        startPreview(v) {
            if (this.previewTimeout) clearTimeout(this.previewTimeout);
            this.previewTimeout = setTimeout(() => {
                if (v.status === 'ready' && !this.batchMode) {
                    this.hoverVideoId = v.id;

                    // For local videos, preload video preview
                    if (v.storage_type === 'local_direct' && !v.preview_loaded) {
                        // Mark as loaded to avoid duplicate requests
                        v.preview_loaded = true;
                        v.preview_url = `/api/v1/videos/${v.id}/preview`;
                    }
                }
            }, 150);
        },

        stopPreview() {
            if (this.previewTimeout) clearTimeout(this.previewTimeout);
            this.hoverVideoId = null;
        },

        playNextVideo() {
            if (!this.activeVideo || this.videos.length === 0) return;
            const currentIndex = this.videos.findIndex(v => v.id === this.activeVideo.id);
            if (currentIndex < this.videos.length - 1) {
                this.playVideo(this.videos[currentIndex + 1]);
            } else {
                this.showToast('Last video in list', 'info');
            }
        },

        playPreviousVideo() {
            if (!this.activeVideo || this.videos.length === 0) return;
            const currentIndex = this.videos.findIndex(v => v.id === this.activeVideo.id);
            if (currentIndex > 0) {
                this.playVideo(this.videos[currentIndex - 1]);
            } else {
                this.showToast('First video in list', 'info');
            }
        }
    };
}

function createToastModule() {
    return {
        toasts: [],

        showToast(message, icon, type = 'info', duration = 3000, isHtml = false) {
            const id = Date.now().toString(36) + Math.random().toString(36).substr(2);
            this.toasts.push({ id, message, icon, type, isHtml });
            setTimeout(() => {
                this.toasts = this.toasts.filter(x => x.id !== id);
            }, duration);
        }
    };
}

function createUtilityModule() {
    return {
        formatDuration(seconds) {
            if (!seconds) return '0:00';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) {
                return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            }
            return `${m}:${s.toString().padStart(2, '0')}`;
        },

        getQuality(height) {
            return height >= 2160 ? '4K' : height >= 1440 ? '1440p' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : 'SD';
        },

        getQualityClass(height) {
            return height >= 2160 ? 'q-4k' : height >= 1080 ? 'q-fhd' : '';
        },

        getQualityTitle(width, height) {
            return width && height ? `${width}x${height}` : 'Resolution not available';
        },

        getStatusClass(status) {
            return `status-${status}`;
        },

        isNew(dateValue) {
            return (new Date() - new Date(dateValue)) < 86400000;
        }
    };
}

function createShortcutModule() {
    return {
        showShortcutsModal: false,
        theaterMode: false,

        setupKeys() {
            window.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                if (e.ctrlKey && e.code === 'KeyK') { e.preventDefault(); this.showCommandPalette = true; }

                if (this.showPlayer) {
                    if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
                    if (e.code === 'KeyS') this.toggleSplitScreen();
                    if (e.code === 'KeyF') this.toggleFullscreen();
                    if (e.code === 'KeyI') this.togglePip();
                    // VR Mode shortcuts
                    if (e.code === 'KeyV') { e.preventDefault(); this.toggleVrMode(); }
                    if (e.code === 'KeyE' && this.vrMode) { e.preventDefault(); this.cycleVrViewMode(); }
                    if (e.code === 'KeyR' && this.vrMode) { e.preventDefault(); this.resetVrView(); }
                }

                if (e.code === 'Escape') {
                    if (this.showCommandPalette) this.showCommandPalette = false;
                    else if (this.showSettings) { this.showSettings = false; this.saveSettings(); }
                    else if (this.showPlayer) this.closePlayer();
                    else if (this.secondPickMode) { this.secondPickMode = false; this.primaryForSplit = null; }
                    else if (this.showImportModal) this.showImportModal = false;
                    else if (this.batchMode) this.toggleBatchMode(false);
                }
            });
        },

        handleKeyPress(e) {
            if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

            const key = e.key.toLowerCase();

            if (key === 't' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.toggleTheaterMode();
            } else if (key === 'b' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.toggleBatchMode();
            } else if (key === '/' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                document.querySelector('input[type="search"]')?.focus();
            } else if (key === 'escape') {
                if (this.duoPickMode) this.cancelDuoPickMode();
                else if (this.duoPlayerMode) this.closeDuoPlayer();
                else if (this.showPlayer) this.closePlayer();
                else if (this.theaterMode) this.theaterMode = false;
                else if (this.secondPickMode) { this.secondPickMode = false; this.primaryForSplit = null; }
                else if (this.batchMode) this.batchMode = false;
            } else if (key === 'a' && (e.ctrlKey || e.metaKey) && this.batchMode) {
                e.preventDefault();
                this.selectAll();
            }

            // Duo Player keyboard shortcuts
            if (this.duoPlayerMode) {
                if (key === ' ' || key === 'k') {
                    e.preventDefault();
                    this.duoPlayPause();
                } else if (key === 'arrowleft') {
                    e.preventDefault();
                    this.duoSeek(-10);
                } else if (key === 'arrowright') {
                    e.preventDefault();
                    this.duoSeek(10);
                } else if (key === 'l') {
                    e.preventDefault();
                    this.toggleDuoLayout();
                } else if (key === 's' && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    this.toggleDuoSync();
                } else if (key === 'f' && !e.shiftKey) {
                    e.preventDefault();
                    this.duoFullscreen();
                } else if (key === '1') {
                    e.preventDefault();
                    this.focusDuoPlayer(1);
                } else if (key === '2') {
                    e.preventDefault();
                    this.focusDuoPlayer(2);
                } else if (key === 'x') {
                    e.preventDefault();
                    this.swapDuoVideos();
                } else if (key === 'r') {
                    e.preventDefault();
                    this.resetDuoView(this.duoFocused);
                } else if (key === '+' || key === '=') {
                    e.preventDefault();
                    this.adjustDuoZoom(this.duoFocused, 0.25);
                } else if (key === '-') {
                    e.preventDefault();
                    this.adjustDuoZoom(this.duoFocused, -0.25);
                } else if (key === 'm') {
                    e.preventDefault();
                    this.toggleDuoMute(this.duoFocused);
                } else if (key === 'a') {
                    e.preventDefault();
                    this.toggleDuoAspectRatio(this.duoFocused);
                } else if (key === 'v') {
                    e.preventDefault();
                    this.toggleDuoVR(this.duoFocused);
                } else if (key === 't') {
                    e.preventDefault();
                    this.duoShowFilters = !this.duoShowFilters;
                } else if (key === 'c') {
                    e.preventDefault();
                    this.duoScreenshot(this.duoFocused);
                } else if (key === 'p') {
                    e.preventDefault();
                    this.duoPip(this.duoFocused);
                } else if (key === 'arrowup') {
                    e.preventDefault();
                    this.cycleDuoPlaybackRate(this.duoFocused);
                } else if (key === 'arrowdown') {
                    e.preventDefault();
                    // Cycle backwards through playback rates
                    const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
                    const current = this.duoPlaybackRate[this.duoFocused];
                    const idx = rates.indexOf(current);
                    const prevIdx = idx <= 0 ? rates.length - 1 : idx - 1;
                    this.setDuoPlaybackRate(this.duoFocused, rates[prevIdx]);
                }
                return; // Don't process regular player shortcuts when in duo mode
            }

            if (!this.showPlayer) return;

            const video = this.activePlayerIdx === 0 ? this.$refs.videoPlayer1 : this.$refs.videoPlayer2;
            if (!video) return;

            if (key === ' ' || key === 'k') {
                e.preventDefault();
                video.paused ? video.play() : video.pause();
            } else if (key === 'arrowleft') {
                e.preventDefault();
                video.currentTime = Math.max(0, video.currentTime - 10);
            } else if (key === 'arrowright') {
                e.preventDefault();
                video.currentTime = Math.min(video.duration, video.currentTime + 10);
            } else if (key === 'arrowup') {
                e.preventDefault();
                video.volume = Math.min(1, video.volume + 0.1);
            } else if (key === 'arrowdown') {
                e.preventDefault();
                video.volume = Math.max(0, video.volume - 0.1);
            } else if (key === 'm') {
                e.preventDefault();
                video.muted = !video.muted;
            } else if (key === 'f') {
                e.preventDefault();
                this.toggleFullscreen();
            } else if (key === 'n' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.playNextVideo();
            } else if (key === 'p' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.playPreviousVideo();
            }
        },

        toggleTheaterMode() {
            this.theaterMode = !this.theaterMode;
            this.showToast(this.theaterMode ? 'Theater Mode ON' : 'Theater Mode OFF', 'info');
        }
    };
}

function createLifecycleModule() {
    return {
        init() {
            this.loadSettings();
            this.loadBatches();
            this.loadTags();
            this.loadVideos(true);
            this.setupKeys();
            this.loadSmartPlaylists();
            this.loadRecommendations();
            this.connectWebSocket();
            this.registerDragAndDrop();
            this.startDownloadPolling();

            // QUANTUM UX - Initialize all 10 powerful features
            if (typeof this.initQuantumUX === 'function') {
                this.initQuantumUX();
            }

            document.body.className = (this.settings.theme || 'dark') + '-theme';
            if (this.settings.uiMode === 'netflix') document.body.classList.add('netflix-mode');
            document.body.dataset.accent = this.settings.accentColor || 'purple';

            this.$watch('settings.theme', (theme) => {
                document.body.className = theme + '-theme';
                if (this.settings.uiMode === 'netflix') document.body.classList.add('netflix-mode');
            });
            this.$watch('settings.accentColor', (color) => {
                document.body.dataset.accent = color;
            });
            this.$watch('settings.uiMode', (mode) => {
                if (mode === 'netflix') document.body.classList.add('netflix-mode');
                else document.body.classList.remove('netflix-mode');
            });

            this.$watch('commandQuery', (q) => this.runCommandSearch(q));
            this.$watch('showCommandPalette', (visible) => {
                if (visible) {
                    this.commandQuery = '';
                    this.$nextTick(() => this.$refs.commandInput.focus());
                }
            });
        }
    };
}


function createMaintenanceModule() {
    return {
        async runMaintenance(action) {
            let endpoint = '';
            let method = 'POST';
            let body = null;
            let successMsg = '';

            switch (action) {
                case 'full-optimization':
                    endpoint = '/api/maintenance/full-optimization';
                    successMsg = 'Full optimization started in background!';
                    break;
                case 'resolve-name':
                    endpoint = '/api/maintenance/duplicates/resolve';
                    body = { type: 'name' };
                    successMsg = 'Name duplicates resolved!';
                    break;
                case 'resolve-hash':
                    endpoint = '/api/maintenance/duplicates/resolve';
                    body = { type: 'hash' };
                    successMsg = 'Visual duplicates resolved!';
                    break;
                case 'cleanup-broken':
                    endpoint = '/api/maintenance/cleanup';
                    body = { delete_permanently: true };
                    successMsg = 'Broken links removed!';
                    break;
                case 'normalize-titles':
                    endpoint = '/api/maintenance/normalize-titles';
                    successMsg = 'Titles normalized!';
                    break;
                case 'fix-thumbnails':
                    endpoint = '/api/maintenance/fix-thumbnails';
                    successMsg = 'Missing thumbnails re-queued!';
                    break;
                case 'sync-durations':
                    endpoint = '/api/maintenance/sync-durations';
                    successMsg = 'Durations synced from source!';
                    break;
                case 'scan-sizes':
                    endpoint = '/api/maintenance/scan-sizes';
                    successMsg = 'File size extraction completed!';
                    break;
                case 'refresh-metadata':
                    endpoint = '/api/maintenance/refresh-metadata';
                    successMsg = 'Metadata refresh session started!';
                    break;
            }

            try {
                this.showToast(`Running ${action}...`, 'settings', 'info');
                const opt = {
                    method: method,
                    headers: { 'Content-Type': 'application/json' }
                };
                if (body) opt.body = JSON.stringify(body);

                const response = await fetch(endpoint, opt);
                const data = await response.json();

                if (response.ok) {
                    this.showToast(
                        successMsg + (data.deleted_videos ? ` (Deleted ${data.deleted_videos})` : ''),
                        'check_circle',
                        'success'
                    );
                    if (action !== 'full-optimization') this.loadVideos(true);
                } else {
                    this.showToast(`Error: ${data.detail || 'Failed to run maintenance'}`, 'error', 'error');
                }
            } catch (e) {
                this.showToast(`Maintenance failed: ${e}`, 'error', 'error');
            }
        }
    };
}

function vipDashboard() {
    return composeDashboard([
        createToastModule,
        createUtilityModule,
        createCollectionModule,
        createSettingsModule,
        createImportModule,
        createExternalDiscoveryModule,
        createDownloadModule,
        createCommandModule,
        createMaintenanceModule,
        createSmartPlaylistModule,
        createBatchModule,
        createPlayerModule,
        createShortcutModule,
        createLifecycleModule,
        createQuantumUXModule  // QUANTUM UX - 10 Powerful Features
    ]);
}

document.addEventListener('alpine:init', () => {
    Alpine.data('dashboard', vipDashboard);
});
