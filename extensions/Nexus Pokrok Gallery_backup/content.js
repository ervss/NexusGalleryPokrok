console.log("GoFile VIP Explorer content script loaded.");

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "COPY_FILES") {
        copyFiles(request.data).then(sendResponse);
        return true;
    }
    if (request.action === "COPY_TO_ROOT") {
        copyToRoot(request.data).then(sendResponse);
        return true;
    }
});

async function copyToRoot({ contentsId, token }) {
    console.log("Getting Root Folder ID...");
    try {
        // 1. Get Account Details via page context (Fixes 403)
        const accountResp = await fetch(`https://api.gofile.io/accounts/getAccountDetails?token=${token}`);
        const accountData = await accountResp.json();

        if (accountData.status !== 'ok') throw new Error("API Error (Account): " + accountData.status);

        const rootFolderId = accountData.data.rootFolder;

        // 2. Proceed with copy
        return await copyFiles({ contentsId, folderIdDest: rootFolderId, token });
    } catch (e) {
        console.error("Copy to root failed:", e);
        return { status: 'error', message: e.message };
    }
}

async function copyFiles({ contentsId, folderIdDest, token }) {
    console.log("Executing COPY via content script...");
    try {
        const resp = await fetch('https://api.gofile.io/contents/copy', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                // Important: No custom authorization header if we rely on cookies, 
                // but since we are on same origin, cookies are automatic.
                // However, GoFile API often explicitly wants the token in body/param too if provided.
            },
            body: JSON.stringify({
                contentsId: contentsId,
                folderIdDest: folderIdDest,
                token: token
            })
        });

        const data = await resp.json();
        return data;
    } catch (e) {
        console.error("Copy failed:", e);
        return { status: 'error', message: e.message };
    }
}
