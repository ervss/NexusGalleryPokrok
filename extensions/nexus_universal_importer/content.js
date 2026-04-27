// Nexus Universal Video Importer - Content Script

(function() {
    const SCAN_INTERVAL = 2000;
    const MIN_DURATION = 10; // Seconds

    function createOverlay(video) {
        if (video.dataset.nexusImporterActive) return;
        video.dataset.nexusImporterActive = 'true';

        // Extrakcia kvalít zo <source> tagov, ak sú dostupné
        const sources = Array.from(video.querySelectorAll('source')).filter(s => s.src && !s.src.startsWith('blob:'));
        
        let bestSourceUrl = "";
        let bestSourceLabel = "";
        let maxRes = 0;

        const sourcesHtml = sources.map((s, i) => {
            const label = s.getAttribute('label') || s.getAttribute('res') || s.getAttribute('size') || s.getAttribute('title') || s.getAttribute('data-res') || `Zdroj ${i+1}`;
            const resMatch = label.match(/(\d+)/);
            const res = resMatch ? parseInt(resMatch[1]) : 0;
            if (res > maxRes) {
                maxRes = res;
                bestSourceUrl = s.src;
                bestSourceLabel = label;
            }
            return `<div class="nexus-quality-opt" data-url="${s.src}" style="cursor: pointer; padding: 2px 0;">${label}</div>`;
        }).join('');

        const defaultText = bestSourceLabel ? `Najvyššia (${bestSourceLabel})` : 'Auto (Predvolená)';
        const defaultUrl = bestSourceUrl || '';

        let qualityHtml = `
            <div class="nexus-quality-section" style="margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 6px;">
                <div style="font-size: 10px; color: #aaa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Kvalita:</div>
                <div class="nexus-quality-list">
                    <div class="nexus-quality-opt active nexus-default-quality" data-url="${defaultUrl}" style="color: #2ecc71; font-weight: bold; cursor: pointer; padding: 2px 0;">${defaultText}</div>
                    ${sourcesHtml}
                </div>
            </div>
        `;

        const container = document.createElement('div');
        container.className = 'nexus-import-overlay';
        
        container.innerHTML = `
            <div class="nexus-import-btn">
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                Import to
            </div>
            <div class="nexus-port-menu">
                <div style="font-size: 10px; color: #aaa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Port:</div>
                <div class="nexus-port-opt" data-port="8000">Nexus 8000 <span>MAIN</span></div>
                <div class="nexus-port-opt" data-port="8001">Nexus 8001 <span>DEV</span></div>
                <div class="nexus-port-opt" data-port="8002">Nexus 8002 <span>ALT</span></div>
                ${qualityHtml}
            </div>
        `;

        // Position overlay relative to video parent or video itself
        const parent = video.parentElement;
        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        parent.appendChild(container);

        // Handle Quality Selection
        function bindQualityOpt(opt) {
            opt.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                container.querySelectorAll('.nexus-quality-opt').forEach(o => {
                    o.classList.remove('active');
                    o.style.color = '';
                    o.style.fontWeight = 'normal';
                });
                opt.classList.add('active');
                opt.style.color = '#2ecc71';
                opt.style.fontWeight = 'bold';
            };
        }

        container.querySelectorAll('.nexus-quality-opt').forEach(bindQualityOpt);

        // Detekcia a parsovanie HLS streamu pre dodatočné kvality
        let hlsCheckAttempts = 0;
        const hlsCheckInterval = setInterval(() => {
            hlsCheckAttempts++;
            if (hlsCheckAttempts > 15) { // Stop po 30 sekundách ak nenájde
                clearInterval(hlsCheckInterval);
                return;
            }

            chrome.runtime.sendMessage({ type: 'GET_CAPTURED_STREAM' }, (response) => {
                const streamUrl = response?.streamUrl;
                if (streamUrl && streamUrl.includes('.m3u8')) {
                    clearInterval(hlsCheckInterval);

                    // Požiadať background o stiahnutie (obídenie CORS na stránke)
                    chrome.runtime.sendMessage({ type: 'FETCH_PLAYLIST', url: streamUrl }, (res) => {
                        if (!res || res.error || !res.text) return;
                        
                        const lines = res.text.split('\n');
                        const qualities = [];
                        let currentRes = null;
                        
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line.startsWith('#EXT-X-STREAM-INF')) {
                                const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                                currentRes = resMatch ? parseInt(resMatch[1]) : 0;
                            } else if (line && !line.startsWith('#') && currentRes !== null) {
                                const label = currentRes ? (currentRes + 'p') : 'HLS Stream';
                                const fullUrl = new URL(line, streamUrl).href;
                                if (!qualities.some(q => q.height === currentRes)) {
                                    qualities.push({ label, url: fullUrl, height: currentRes });
                                }
                                currentRes = null;
                            }
                        }
                        
                        qualities.sort((a, b) => b.height - a.height);
                        
                        if (qualities.length > 0) {
                            // Nastav najvyššiu HLS kvalitu ako predvolenú ak je dostupná
                            const best = qualities[0];
                            const defaultOpt = container.querySelector('.nexus-default-quality');
                            if (defaultOpt) {
                                defaultOpt.innerText = `Najvyššia (${best.label} HLS)`;
                                defaultOpt.dataset.url = best.url;
                            }

                            const listContainer = container.querySelector('.nexus-quality-list');
                            if (listContainer) {
                                qualities.forEach(q => {
                                    const opt = document.createElement('div');
                                    opt.className = 'nexus-quality-opt';
                                    opt.dataset.url = q.url;
                                    opt.style.cssText = 'cursor: pointer; padding: 2px 0;';
                                    opt.innerText = q.label + ' (HLS)';
                                    bindQualityOpt(opt);
                                    listContainer.appendChild(opt);
                                });
                            }
                        }
                    });
                }
            });
        }, 2000);

        container.querySelectorAll('.nexus-port-opt').forEach(opt => {
            opt.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                const activeOpt = container.querySelector('.nexus-quality-opt.active');
                const finalUrl = activeOpt ? activeOpt.dataset.url : null;
                handleImport(video, opt.dataset.port, finalUrl);
            };
        });
    }

    async function handleImport(video, port, selectedQualityUrl = null) {
        showToast(`Preparing import for port ${port}...`);

        // Try to get URL from background script first (most reliable for HLS)
        chrome.runtime.sendMessage({ type: 'GET_CAPTURED_STREAM' }, (response) => {
            let streamUrl = response?.streamUrl;

            // Ak používateľ vybral špecifickú kvalitu, tá dostane prednosť
            if (selectedQualityUrl) {
                streamUrl = selectedQualityUrl;
            } else if (!streamUrl) {
                // Fallback to video src if background didn't capture anything yet
                streamUrl = video.currentSrc || video.src;
            }

            if (!streamUrl || streamUrl.startsWith('blob:')) {
                // If it's a blob and background didn't catch the m3u8, we might be stuck
                // unless we check for common player objects (Hls.js, etc)
                if (!streamUrl.startsWith('blob:')) {
                    showToast('Could not resolve direct video link.', true);
                    return;
                }
            }

            const metadata = {
                title: document.title.split(' - ')[0].trim(),
                sourceUrl: window.location.href,
                duration: Math.round(video.duration) || 0,
                thumbnail: findThumbnail()
            };

            chrome.runtime.sendMessage({
                type: 'IMPORT_VIDEO',
                streamUrl,
                port,
                metadata
            }, (res) => {
                if (res && res.success) {
                    showToast(`Successfully imported to port ${port}!`);
                } else {
                    showToast(`Failed: ${res?.error || 'Unknown error'}`, true);
                }
            });
        });
    }

    function findThumbnail() {
        // Try various ways to find a thumbnail
        const ogImage = document.querySelector('meta[property="og:image"]')?.content;
        if (ogImage) return ogImage;

        const poster = document.querySelector('video')?.poster;
        if (poster) return poster;

        return null;
    }

    function showToast(text, isError = false) {
        // Vytvorenie alebo nájdenie kontajnera pre toasty
        let toastContainer = document.getElementById('nexus-toast-container');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'nexus-toast-container';
            toastContainer.style.cssText = 'position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 999999; pointer-events: none; align-items: flex-end;';
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement('div');
        toast.className = `nexus-toast ${isError ? 'error' : 'success'}`;
        
        // Resetovanie štýlov, aby sa toast nefixoval voči oknu, ale radil sa vo flex kontajneri
        toast.style.pointerEvents = 'auto'; // Aby na ne išlo kliknúť aj keď kontajner má pointer-events: none
        toast.style.position = 'relative';
        toast.style.bottom = 'auto';
        toast.style.right = 'auto';
        
        // SVG ikonky pre úspech a chybu
        const iconSvg = isError 
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;

        toast.innerHTML = `
            <div class="nexus-toast-icon">${iconSvg}</div>
            <div class="nexus-toast-text">${text}</div>
        `;
        
        toastContainer.appendChild(toast);
        
        setTimeout(() => toast.classList.add('fade-out'), 2700);
        setTimeout(() => {
            toast.remove();
            // Vyčisti kontajner, ak už v ňom nie sú žiadne toasty
            if (toastContainer.childNodes.length === 0) toastContainer.remove();
        }, 3000);
    }

    function scanVideos() {
        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            // Check duration (if available)
            if (video.duration && video.duration < MIN_DURATION) return;
            
            // Wait for metadata to be loaded if duration is NaN
            if (isNaN(video.duration)) {
                video.addEventListener('loadedmetadata', () => {
                    if (video.duration >= MIN_DURATION) {
                        createOverlay(video);
                    }
                }, { once: true });
            } else {
                createOverlay(video);
            }
        });
    }

    // Initial scan and periodic check for dynamic content
    scanVideos();
    setInterval(scanVideos, SCAN_INTERVAL);

})();
