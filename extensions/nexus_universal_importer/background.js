// Nexus Universal Video Importer - Background Service Worker

const capturedStreams = new Map();

// Listen for video streams
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const url = details.url;
        const tabId = details.tabId;
        
        if (tabId < 0) return;

        // Filter for video formats and exclude obvious ads
        if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.mpd')) {
            if (!url.includes('ads') && !url.includes('telemetry') && !url.includes('analytics')) {
                let finalUrl = url;
                
                // Detect JW Player ping URLs with hidden manifest in 'mu' parameter
                if (url.includes('ping.gif') && url.includes('mu=')) {
                    try {
                        const muMatch = url.match(/[?&]mu=([^&]+)/);
                        if (muMatch) {
                            finalUrl = decodeURIComponent(muMatch[1]);
                            console.log(`[Nexus] Extracted real manifest from ping URL: ${finalUrl}`);
                        }
                    } catch (e) {
                        console.error('[Nexus] Failed to parse ping URL', e);
                    }
                }

                console.log(`[Nexus] Captured stream: ${finalUrl} for tab ${tabId}`);
                capturedStreams.set(tabId, finalUrl);
            }
        }
    },
    { urls: ["<all_urls>"] }
);

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
    capturedStreams.delete(tabId);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (request.type === 'GET_CAPTURED_STREAM') {
        const streamUrl = capturedStreams.get(tabId);
        sendResponse({ streamUrl });
    }

    if (request.type === 'FETCH_PLAYLIST') {
        fetch(request.url)
            .then(res => res.text())
            .then(text => sendResponse({ text }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.type === 'IMPORT_VIDEO') {
        const { streamUrl, port, metadata } = request;
        const targetUrl = `http://localhost:${port}/api/v1/import/bulk`;

        console.log(`[Nexus] Importing to port ${port}: ${streamUrl}`);

        fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batch_name: "Extension Import",
                videos: [{
                    url: streamUrl,
                    title: metadata.title || 'Imported Video',
                    source_url: metadata.sourceUrl,
                    duration: metadata.duration,
                    thumbnail: metadata.thumbnail
                }]
            })
        })
        .then(async (res) => {
            const data = await res.json();
            if (res.ok) {
                sendResponse({ success: true, data });
            } else {
                sendResponse({ success: false, error: data.detail || `Server error ${res.status}` });
            }
        })
        .catch(err => {
            console.error(`[Nexus] Import failed:`, err);
            sendResponse({ success: false, error: 'Dashboard unreachable. Is it running on port ' + port + '?' });
        });

        return true; // Async
    }
});
