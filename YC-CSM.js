// ==UserScript==
// @name         v6.3 YC Contact Sheet Maker
// @namespace    http://tampermonkey.net/
// @version      6.3
// @description  bulk generate contact sheets for videos in file host sites album (currently works only for pixeldrain)
// @match        *://pixeldrain.com/*
// @match        *://pixeldrain.net/*
// @match        *://pixeldra.in/*
// @match        *://bunkr.su/*
// @match        *://bunkr.cr/*
// @match        *://balbums.st/*
// @match        *://bunkr.red/*
// @match        *://bunkr.ac/*
// @match        *://bunkr.ax/*
// @match        *://bunkr.cat/*
// @match        *://bunkr.black/*
// @match        *://bunkr.ci/*
// @match        *://bunkr.fi/*
// @match        *://bunkr.is/*
// @match        *://bunkr.media/*
// @match        *://bunkr.nu/*
// @match        *://bunkr.ru/*
// @match        *://bunkr.se/*
// @match        *://bunkr.si/*
// @match        *://bunkr.pk/*
// @match        *://bunkr.ph/*
// @match        *://bunkr.ps/*
// @match        *://bunkr.sk/*
// @match        *://bunkr.ws/*
// @match        *://bunkrr.ru/*
// @match        *://bunkrr.su/*
// @match        *://bunkr-cache.se/*
// @match        *://bunkrrr.org/*
// @match        *://b-cdn.net/*
// @match        *://gigachan-cdn.ru/*
// @match        *://filester.sh/*
// @match        *://filester.me/*
// @match        *://filester.si/*
// @match        *://filester.gg/*
// @connect      *
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// ==/UserScript==

(function() {
    'use strict';

    // Force browser to send referer headers for native media elements to bypass CDN hotlink protection
    if (!document.querySelector('meta[name="referrer"]')) {
        document.head.insertAdjacentHTML('beforeend', '<meta name="referrer" content="unsafe-url">');
    }

    const GM_http = window.GM_xmlhttpRequest;
    const TARGET_HOSTS = ['bunkr', 'filester', 'pixeldrain'];

    let gridRules = [
        { maxMins: 2, cols: 2, rows: 3 },
        { maxMins: 10, cols: 3, rows: 4 },
        { maxMins: 20, cols: 4, rows: 4 },
        { maxMins: Infinity, cols: 5, rows: 5 }
    ];
    let workerCount = 3;
    let isProcessing = false;
    let stopRequested = false;

    // ==========================================
    // 1. XFPD CORE HELPERS & HTTP WRAPPER
    // ==========================================
    const h = {
        unique: (items) => [...new Set(items)],
        formatBytes: (bytes) => {
            if (!bytes || isNaN(bytes)) return 'Unknown Size';
            const k = 1024, i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + ['Bytes', 'KB', 'MB', 'GB'][i];
        },
        delayedResolve: ms => new Promise(res => setTimeout(res, ms)),
        http: {
            base: (method, url, headers = {}, data = null, responseType = 'text') => {
                return new Promise((resolve) => {
                    const hdrs = { Referer: url, ...(headers || {}) };
                    const withCreds = !!hdrs.__xfpd_withCredentials;
                    if (hdrs.__xfpd_withCredentials) delete hdrs.__xfpd_withCredentials;

                    GM_http({
                        method, url, data, headers: hdrs, responseType,
                        ...(withCreds ? { withCredentials: true, anonymous: false } : {}),
                        onload: r => resolve({ source: r.responseText || r.response || '', status: r.status, dom: r.response, finalUrl: r.finalUrl || r.responseURL || url, responseHeaders: r.responseHeaders }),
                        onerror: () => resolve({ source: '', status: 0, finalUrl: url, responseHeaders: '' })
                    });
                });
            },
            get: (url, headers = {}) => h.http.base('GET', url, headers),
            post: (url, data, headers = {}) => h.http.base('POST', url, headers, data),
            head: (url, headers = {}) => new Promise(res => GM_http({ method: 'HEAD', url, headers, onload: r => res(r.responseHeaders), onerror: () => res('') }))
        }
    };

    // ==========================================
    // 2. XFPD BUNKR BYPASS ENGINE
    // ==========================================
    const BUNKR_CF_MAX_RETRIES = 3;
    function xfpdLooksLikeCfChallenge(source) {
        const s = String(source || '').slice(0, 8000).toLowerCase();
        return s.includes('challenges.cloudflare.com') || s.includes('cf-browser-verification') || s.includes('just a moment');
    }

    async function xfpdBunkrCfWarmup(url) {
        try {
            const tab = GM_openInTab(url, { active: false, insert: true, setParent: true });
            await h.delayedResolve(6000);
            try { tab.close(); } catch(e){}
        } catch(e){}
    }

    async function xfpdBunkrGetWithCfRetry(url, originUrl) {
        let last = null;
        for (let attempt = 0; attempt <= BUNKR_CF_MAX_RETRIES; attempt++) {
            last = await h.http.get(url);
            if (!xfpdLooksLikeCfChallenge(last.source)) return last;
            if (attempt < BUNKR_CF_MAX_RETRIES) await xfpdBunkrCfWarmup(originUrl || url);
        }
        return last;
    }

    async function xfpdBunkrPostVsWithCfRetry(endpoint, slug, refererUrl, originUrl) {
        for (let attempt = 0; attempt <= BUNKR_CF_MAX_RETRIES; attempt++) {
            const r = await h.http.post(endpoint, JSON.stringify({ slug }), { 'Content-Type': 'application/json', Referer: refererUrl, Origin: originUrl });
            try {
                return JSON.parse(r.source);
            } catch (e) {
                if (xfpdLooksLikeCfChallenge(r.source) && attempt < BUNKR_CF_MAX_RETRIES) {
                    await xfpdBunkrCfWarmup(originUrl || endpoint);
                    continue;
                }
                return null;
            }
        }
        return null;
    }

    function decodeBunkrUrl(data) {
        if (!data || !data.url) return null;
        if (!data.encrypted) return data.url;
        try {
            const binary = atob(data.url);
            const key = new TextEncoder().encode(`SECRET_KEY_${Math.floor(data.timestamp / 3600)}`);
            let finalUrl = Array.from(binary).map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key[i % key.length])).join('');
            return finalUrl.startsWith('//') ? 'https:' + finalUrl : finalUrl;
        } catch(e){ return null; }
    }

    // ==========================================
    // 3. XFPD FILESTER BYPASS ENGINE
    // ==========================================
    async function resolveFilesterDirect(slug, originalUrl) {
        const apiBase = 'https://filester.me';
        const headers = { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=UTF-8', Origin: apiBase, Referer: originalUrl, __xfpd_withCredentials: true };

        const dlRes = await h.http.post(`${apiBase}/api/public/download`, JSON.stringify({ file_slug: slug }), headers);
        let tokenUrl = null;
        try {
            const j = JSON.parse(dlRes.source);
            tokenUrl = j.url || j.download_url || j.downloadUrl;
        } catch(e) {}

        if (!tokenUrl) {
            const m = /"download_url"\s*:\s*"([^"]+)"/i.exec(dlRes.source);
            if (m && m[1]) tokenUrl = m[1];
        }

        if (tokenUrl) {
            const r1 = await h.http.base('GET', tokenUrl, { Range: 'bytes=0-0', Referer: `${apiBase}/d/${slug}`, __xfpd_withCredentials: true });
            if (r1.finalUrl && r1.finalUrl.includes('/v/')) return r1.finalUrl.split('?')[0];

            const mCt1 = /content-type:\s*([^\r\n]+)/i.exec(r1.responseHeaders || '');
            if (mCt1 && /text\/html/i.test(mCt1[1])) {
                const r2 = await h.http.get(tokenUrl, { Accept: 'text/html', Referer: `${apiBase}/d/${slug}`, __xfpd_withCredentials: true });
                const mFull = /(https?:\/\/cache\d+\.filester\.(me|sh|si|gg)\/v\/[^\"'<>\s]+)/i.exec(r2.source);
                if (mFull && mFull[1]) return mFull[1].trim();
            }
            return tokenUrl;
        }
        return null;
    }

    // ==========================================
    // 4. ALBUM EXPANSION & CDN RESOLUTION
    // ==========================================
    async function expandAndResolve(rawLinks, log) {
        log(`🔍 Analyzing ${rawLinks.length} raw links...`);
        let finalFiles = [];

        for (let url of rawLinks) {
            if (/bunkrr?r?\.[a-z]+\/a\/([^\/?#]+)/i.test(url)) {
                log(`📂 Expanding Bunkr Album: ${url}`);
                const u = new URL(url);
                const r = await xfpdBunkrGetWithCfRetry(url, u.origin);
                if (r && r.source) {
                    const re = /\/(f|v|d)\/([^\/?#"']+)/gi;
                    let m;
                    let foundSlugs = new Set();
                    while ((m = re.exec(r.source)) !== null) { foundSlugs.add(m[2]); }
                    foundSlugs.forEach(slug => {
                        finalFiles.push({ host: 'bunkr', type: 'file', original: url, url: `${u.origin}/v/${slug}`, slug: slug, name: `Bunkr_Vid_${slug}` });
                    });
                }
            }
            else if (/filester\.[a-z]+\/f\/([^\/?#]+)/i.test(url)) {
                log(`📂 Expanding Filester Album: ${url}`);
                for (let page = 1; page <= 5; page++) {
                    const r = await h.http.get(`${url}?page=${page}`, { Accept: 'text/html', Referer: url, __xfpd_withCredentials: true });
                    if (!r.source || !r.source.includes('/d/')) break;

                    const parser = new DOMParser();
                    const dom = parser.parseFromString(r.source, 'text/html');
                    const items = [...dom.querySelectorAll('div.file-item')];
                    let added = 0;

                    for (const el of items) {
                        let slug = '';
                        const oc = String(el.getAttribute('onclick') || '');
                        const m1 = /\/d\/([^'"?\s]+)/i.exec(oc);
                        if (m1 && m1[1]) slug = m1[1];
                        if (!slug) {
                            const btn = el.querySelector('button.download-btn');
                            const m2 = /downloadFile\(\s*'([^']+)'/i.exec(String(btn?.getAttribute?.('onclick') || ''));
                            if (m2 && m2[1]) slug = m2[1];
                        }
                        if (slug) {
                            let name = String(el.getAttribute('data-name') || el.querySelector('.file-name')?.textContent || '').trim();
                            finalFiles.push({ host: 'filester', type: 'file', original: url, url: `https://filester.me/d/${slug}`, slug: slug, name: name || slug });
                            added++;
                        }
                    }
                    if (added === 0) break;
                }
            }
            else if (/pixeldrain\.[a-z]+\/l\/([^\/?#]+)/i.test(url)) {
                log(`📂 Expanding Pixeldrain Album: ${url}`);
                const slug = url.match(/\/l\/([^\/?#]+)/i)[1];
                const r = await h.http.get(`https://pixeldrain.com/api/list/${slug}`);
                try {
                    const j = JSON.parse(r.source);
                    if (j.files) j.files.forEach(f => finalFiles.push({ host: 'pixeldrain', type: 'file', original: url, url: `https://pixeldrain.com/u/${f.id}`, name: f.name }));
                } catch(e) {}
            }
            else if (/bunkrr?r?\.[a-z]+\/(f|v|d)\/([^\/?#]+)/i.test(url)) {
                const slugMatch = url.match(/\/(f|v|d)\/([^\/?#]+)/i);
                const slug = slugMatch ? slugMatch[2] : '';
                finalFiles.push({ host: 'bunkr', type: 'file', original: url, url, slug: slug, name: `Bunkr_Video_${slug}` });
            }
            else if (/filester\.[a-z]+\/d\/([^\/?#]+)/i.test(url)) {
                const slug = url.split('/d/')[1].split(/[?#]/)[0];
                finalFiles.push({ host: 'filester', type: 'file', original: url, url, slug: slug, name: `Filester_Video_${slug}` });
            }
            else if (/pixeldrain\.[a-z]+\/u\/([^\/?#]+)/i.test(url)) {
                finalFiles.push({ host: 'pixeldrain', type: 'file', original: url, url, name: 'Pixeldrain_Video' });
            }
        }
        return finalFiles.filter((v, i, a) => a.findIndex(t => (t.url === v.url)) === i);
    }

    async function getDirectCdn(fileObj) {
        if (fileObj.host === 'pixeldrain') {
            const slug = fileObj.url.split('/u/')[1];
            return `https://pixeldrain.com/api/file/${slug}?download`;
        }
        if (fileObj.host === 'bunkr') {
            const u = new URL(fileObj.url);
            const data = await xfpdBunkrPostVsWithCfRetry(`${u.origin}/api/vs`, fileObj.slug, fileObj.url, u.origin);
            return decodeBunkrUrl(data);
        }
        if (fileObj.host === 'filester') {
            return await resolveFilesterDirect(fileObj.slug, fileObj.url);
        }
        return null;
    }

    // ==========================================
    // 5. FULL SCREEN UI MANAGER
    // ==========================================
    let mainBtn, fsModal;
    let videoList = [];
    let completedSheets = [];

    const initUI = () => {
        if (document.getElementById('xfpd-v6-btn')) return;

        mainBtn = document.createElement('button');
        mainBtn.id = 'xfpd-v6-btn';
        mainBtn.innerText = "🎬 Master Extract (B/F/P)";
        mainBtn.style.cssText = "position:fixed; bottom:20px; right:20px; z-index:999999; padding:15px; background:#e50914; color:white; border:none; border-radius:8px; font-weight:bold; font-size:14px; cursor:pointer; box-shadow: 0 5px 15px rgba(0,0,0,0.5);";
        document.body.appendChild(mainBtn);

        fsModal = document.createElement('div');
        fsModal.style.cssText = "display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:#111; z-index:2147483647; overflow-y:auto; font-family:sans-serif; color:white;";
        document.body.appendChild(fsModal);

        mainBtn.addEventListener('click', () => {
            mainBtn.style.display = 'none';
            fsModal.style.display = 'flex';
            fsModal.style.justifyContent = 'center';
            fsModal.style.alignItems = 'center';

            fsModal.innerHTML = `
                <div style="background:#222; padding:30px; border-radius:10px; border:1px solid #444; width:400px; text-align:center;">
                    <h2 style="margin-top:0;">Select Mode</h2>
                    <p style="color:#aaa; font-size:14px; margin-bottom:20px;">Do you want to scan this page for links, or paste a list of URLs manually?</p>
                    <button id="xfpd-mode-scan" style="width:100%; padding:15px; background:#0078FF; color:white; border:none; border-radius:6px; font-weight:bold; font-size:15px; cursor:pointer; margin-bottom:10px;">🔍 Scan Page For Links</button>
                    <button id="xfpd-mode-paste" style="width:100%; padding:15px; background:#8A2BE2; color:white; border:none; border-radius:6px; font-weight:bold; font-size:15px; cursor:pointer; margin-bottom:10px;">📋 Paste Links Manually</button>
                    <button id="xfpd-mode-close" style="width:100%; padding:15px; background:#444; color:white; border:none; border-radius:6px; font-weight:bold; font-size:15px; cursor:pointer;">❌ Cancel</button>
                </div>
            `;

            fsModal.querySelector('#xfpd-mode-close').onclick = () => { fsModal.style.display = 'none'; mainBtn.style.display = 'block'; };

            fsModal.querySelector('#xfpd-mode-scan').onclick = async () => {
                fsModal.style.display = 'block';
                fsModal.innerHTML = `<div style="padding:40px; text-align:center; font-size:20px; font-weight:bold;">🔍 Scanning & Expanding Albums...</div>`;

                let rawLinks = [];
                document.querySelectorAll('a').forEach(a => { if (TARGET_HOSTS.some(k => a.href.includes(k))) rawLinks.push(a.href); });
                const textLinks = document.body.innerHTML.match(/https?:\/\/[^\s"'<>]+/g) || [];
                textLinks.forEach(url => { if (TARGET_HOSTS.some(k => url.includes(k))) rawLinks.push(url.split(/[\s"'<>\]]/)[0]); });
                rawLinks = h.unique(rawLinks);

                if (!rawLinks.length) {
                    fsModal.innerHTML = `<div style="padding:40px; text-align:center; font-size:20px; color:#ff4444;">❌ No valid links found on page.</div>
                    <button onclick="document.getElementById('xfpd-v6-btn').style.display='block'; this.parentNode.style.display='none';" style="display:block; margin:20px auto; padding:10px 20px; background:#444; color:white; border:none; border-radius:5px; cursor:pointer;">Close</button>`;
                    return;
                }

                videoList = await expandAndResolve(rawLinks, (msg) => { fsModal.innerHTML = `<div style="padding:40px; text-align:center; font-size:16px;">${msg}</div>`; });
                renderSelectionUI();
            };

            fsModal.querySelector('#xfpd-mode-paste').onclick = () => {
                fsModal.style.display = 'block';
                fsModal.innerHTML = `
                    <div style="padding:20px; max-width:800px; margin:0 auto; display:flex; flex-direction:column; height:100vh;">
                        <h2>📋 Paste Links</h2>
                        <textarea id="xfpd-paste-area" style="flex:1; width:100%; background:#111; color:white; border:1px solid #555; border-radius:6px; padding:15px; font-family:monospace; resize:none; margin-bottom:15px;"></textarea>
                        <div style="display:flex; gap:10px;">
                            <button id="xfpd-paste-go" style="flex:1; padding:15px; background:#00CC66; color:white; border:none; border-radius:6px; font-weight:bold; font-size:15px; cursor:pointer;">▶️ Expand & Process Pasted Links</button>
                            <button id="xfpd-paste-cancel" style="padding:15px; background:#e50914; color:white; border:none; border-radius:6px; font-weight:bold; font-size:15px; cursor:pointer;">Cancel</button>
                        </div>
                    </div>
                `;

                fsModal.querySelector('#xfpd-paste-cancel').onclick = () => { fsModal.style.display = 'none'; mainBtn.style.display = 'block'; };
                fsModal.querySelector('#xfpd-paste-go').onclick = async () => {
                    const val = fsModal.querySelector('#xfpd-paste-area').value;
                    let rawLinks = val.match(/https?:\/\/[^\s"'<>]+/g) || [];
                    rawLinks = h.unique(rawLinks.filter(url => TARGET_HOSTS.some(k => url.includes(k))));

                    if (!rawLinks.length) return alert("No valid Bunkr, Filester, or Pixeldrain links found.");

                    fsModal.innerHTML = `<div style="padding:40px; text-align:center; font-size:20px; font-weight:bold;">🔍 Scanning & Expanding Pasted Links...</div>`;
                    videoList = await expandAndResolve(rawLinks, (msg) => { fsModal.innerHTML = `<div style="padding:40px; text-align:center; font-size:16px;">${msg}</div>`; });
                    renderSelectionUI();
                };
            };
        });
    };

    // ==========================================
    // 6. SELECTION & SETTINGS UI
    // ==========================================
    const renderSelectionUI = () => {
        fsModal.innerHTML = `
            <div style="padding:20px; max-width:900px; margin:0 auto; display:flex; flex-direction:column; height:100vh;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #333; padding-bottom:15px; margin-bottom:15px;">
                    <h2 style="margin:0;">📦 Select Videos (${videoList.length} found)</h2>
                    <div style="display:flex; gap:10px;">
                        <button id="xfpd-btn-settings" style="padding:10px 15px; background:#444; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer;">⚙️ Settings</button>
                        <button id="xfpd-btn-start" style="padding:10px 20px; background:#00CC66; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer;">▶️ Generate Selected</button>
                        <button id="xfpd-btn-close" style="padding:10px 15px; background:#e50914; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer;">Cancel</button>
                    </div>
                </div>

                <div id="xfpd-settings-panel" style="display:none; background:#222; padding:15px; border-radius:8px; margin-bottom:15px; border:1px solid #444;">
                    <h3 style="margin:0 0 10px 0; font-size:14px;">Dynamic Grid Rules (Duration -> R x C)</h3>
                    <div id="xfpd-rules-container" style="display:flex; flex-direction:column; gap:8px; margin-bottom:15px;"></div>
                    <div style="display:flex; align-items:center; gap:15px;">
                        <label style="font-size:14px; display:flex; align-items:center; gap:5px;">
                            Workers (3-5):
                            <select id="xfpd-worker-select" style="background:#111; color:white; padding:5px; border:1px solid #555; border-radius:4px;">
                                <option value="3" selected>3</option><option value="4">4</option><option value="5">5</option>
                            </select>
                        </label>
                    </div>
                </div>

                <div style="margin-bottom:10px;"><label style="cursor:pointer; font-weight:bold; font-size:14px;"><input type="checkbox" id="xfpd-select-all" checked> Select All</label></div>
                <div id="xfpd-video-list" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding-right:10px;"></div>
            </div>
        `;

        const rulesContainer = fsModal.querySelector('#xfpd-rules-container');
        const renderRules = () => {
            rulesContainer.innerHTML = '';
            gridRules.forEach((rule, idx) => {
                rulesContainer.innerHTML += `
                    <div style="display:flex; align-items:center; gap:10px; font-size:13px;">
                        <span>If duration <= </span><input type="number" class="r-max" data-idx="${idx}" value="${rule.maxMins === Infinity ? 999 : rule.maxMins}" style="width:50px; background:#111; color:white; border:1px solid #555; text-align:center;">
                        <span>mins 🢒</span><input type="number" class="r-rows" data-idx="${idx}" value="${rule.rows}" style="width:40px; background:#111; color:white; border:1px solid #555; text-align:center;"> Rows x
                        <input type="number" class="r-cols" data-idx="${idx}" value="${rule.cols}" style="width:40px; background:#111; color:white; border:1px solid #555; text-align:center;"> Cols
                    </div>
                `;
            });
            rulesContainer.querySelectorAll('input').forEach(inp => {
                inp.addEventListener('change', (e) => {
                    const idx = e.target.getAttribute('data-idx');
                    const val = parseInt(e.target.value);
                    if (e.target.classList.contains('r-max')) gridRules[idx].maxMins = val === 999 ? Infinity : val;
                    if (e.target.classList.contains('r-rows')) gridRules[idx].rows = val;
                    if (e.target.classList.contains('r-cols')) gridRules[idx].cols = val;
                });
            });
        };
        renderRules();

        fsModal.querySelector('#xfpd-btn-settings').onclick = () => {
            const p = fsModal.querySelector('#xfpd-settings-panel');
            p.style.display = p.style.display === 'none' ? 'block' : 'none';
        };
        fsModal.querySelector('#xfpd-btn-close').onclick = () => { fsModal.style.display = 'none'; mainBtn.style.display = 'block'; };
        fsModal.querySelector('#xfpd-select-all').onchange = (e) => { fsModal.querySelectorAll('.vid-cb').forEach(cb => cb.checked = e.target.checked); };
        fsModal.querySelector('#xfpd-worker-select').onchange = (e) => { workerCount = parseInt(e.target.value); };

        const listEl = fsModal.querySelector('#xfpd-video-list');
        videoList.forEach((v, i) => {
            v.id = `vid-${i}`;
            listEl.innerHTML += `
                <label style="display:flex; align-items:center; gap:15px; background:#1a1a1a; padding:10px; border-radius:6px; border:1px solid #333; cursor:pointer;">
                    <input type="checkbox" class="vid-cb" data-id="${v.id}" checked style="transform:scale(1.5); margin-left:10px;">
                    <div id="thumb-${v.id}" style="width:80px; height:50px; background:#000; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:24px;">🎬</div>
                    <div style="display:flex; flex-direction:column; flex:1; overflow:hidden;">
                        <span style="font-weight:bold; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${v.name}</span>
                        <span style="font-size:11px; color:#aaa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${v.url}</span>
                    </div>
                </label>
            `;
        });

        fsModal.querySelector('#xfpd-btn-start').onclick = () => {
            const selected = [];
            fsModal.querySelectorAll('.vid-cb:checked').forEach(cb => { selected.push(videoList.find(v => v.id === cb.getAttribute('data-id'))); });
            if (!selected.length) return alert("Select at least 1 video.");
            startProcessing(selected);
        };

        // Async Thumbnails (NO CROSSORIGIN TAG to prevent CDN blocking)
        videoList.forEach(async (v) => {
            const cdn = await getDirectCdn(v);
            if (cdn) {
                const vidEl = document.createElement('video');
                vidEl.muted = true; vidEl.src = cdn;
                vidEl.addEventListener('loadeddata', () => vidEl.currentTime = 0);
                vidEl.addEventListener('seeked', () => {
                    setTimeout(() => {
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = 80; canvas.height = 80 * (vidEl.videoHeight / vidEl.videoWidth || 0.56);
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(vidEl, 0, 0, canvas.width, canvas.height);
                            // Wrap toDataURL in try-catch in case taint occurs
                            try {
                                const dataUrl = canvas.toDataURL();
                                const tmb = document.getElementById(`thumb-${v.id}`);
                                if(tmb) { tmb.innerHTML = ''; tmb.style.background = `url(${dataUrl}) center/cover`; }
                            } catch(e) {}
                        } catch(e) {}
                    }, 300);
                });
            }
        });
    };

    // ==========================================
    // 7. BATCH PROCESSING ENGINE
    // ==========================================
    async function startProcessing(selectedVideos) {
        isProcessing = true;
        stopRequested = false;
        completedSheets = [];

        fsModal.innerHTML = `
            <div style="padding:20px; max-width:1000px; margin:0 auto; display:flex; flex-direction:column; height:100vh;">
                <div style="background:#222; padding:15px; border-radius:8px; margin-bottom:15px; border:1px solid #444; position:sticky; top:20px; z-index:10;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                        <h2 id="xfpd-proc-title" style="margin:0;">Processing 0 / ${selectedVideos.length} Videos</h2>
                        <div>
                            <button id="xfpd-btn-stop" style="padding:10px 15px; background:#e50914; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer;">🛑 Stop</button>
                            <button id="xfpd-btn-export" style="display:none; padding:10px 15px; background:#00CC66; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer;">💾 Export to Doc</button>
                        </div>
                    </div>
                    <div style="width:100%; background:#000; height:10px; border-radius:5px; overflow:hidden;">
                        <div id="xfpd-proc-bar" style="width:0%; height:100%; background:#0078FF; transition:width 0.3s;"></div>
                    </div>
                    <div id="xfpd-proc-status" style="margin-top:5px; font-size:12px; color:#aaa; font-weight:bold;">Initializing...</div>
                </div>
                <div id="xfpd-sheets-container" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:30px; padding-bottom:50px;"></div>
            </div>
        `;

        const titleEl = fsModal.querySelector('#xfpd-proc-title');
        const statusEl = fsModal.querySelector('#xfpd-proc-status');
        const barEl = fsModal.querySelector('#xfpd-proc-bar');
        const containerEl = fsModal.querySelector('#xfpd-sheets-container');
        const stopBtn = fsModal.querySelector('#xfpd-btn-stop');
        const exportBtn = fsModal.querySelector('#xfpd-btn-export');

        stopBtn.onclick = () => { stopRequested = true; stopBtn.disabled = true; stopBtn.innerText = "Stopping..."; };
        exportBtn.onclick = () => exportToDoc();

        for (let i = 0; i < selectedVideos.length; i++) {
            if (stopRequested) break;
            const v = selectedVideos[i];
            titleEl.innerText = `Processing ${i+1} / ${selectedVideos.length} Videos`;
            statusEl.innerText = `Resolving CDN for ${v.name}...`;

            const cdnUrl = await getDirectCdn(v);
            if (!cdnUrl) {
                statusEl.innerText = `❌ Failed to resolve CDN: ${v.name}`;
                containerEl.innerHTML += `<div style="background:#331111; border:1px solid #ff4444; padding:15px; border-radius:8px; color:#ffaaaa;"><b>❌ Failed:</b> Could not extract direct URL for ${v.name}. The file may be deleted or blocked.</div>`;
                continue;
            }

            const success = await generateSingleSheet(v, cdnUrl, statusEl, barEl, containerEl);
            if (!success && !stopRequested) {
                containerEl.innerHTML += `<div style="background:#331111; border:1px solid #ff4444; padding:15px; border-radius:8px; color:#ffaaaa;"><b>❌ Failed:</b> ${v.name}<br><span style="font-size:12px;">The CDN actively blocked the native video player. (Usually due to strict hotlink protection or CORS policies on this specific file).</span></div>`;
            }
        }

        isProcessing = false;
        titleEl.innerText = `Finished. Processed ${completedSheets.length} Videos.`;
        statusEl.innerText = "Task Complete.";
        stopBtn.style.display = 'none';
        exportBtn.style.display = 'inline-block';
    }

    function generateSingleSheet(videoObj, cdnUrl, statusEl, barEl, containerEl) {
        return new Promise((resolvePromise) => {
            const probeVideo = document.createElement('video');
            // NO CROSSORIGIN TAG to prevent CDN rejection
            probeVideo.muted = true; probeVideo.playsInline = true; probeVideo.preload = "metadata";

            probeVideo.addEventListener('loadedmetadata', async () => {
                const width = probeVideo.videoWidth, height = probeVideo.videoHeight, duration = probeVideo.duration;
                if (!duration || !isFinite(duration)) return resolvePromise(false);

                const durMins = duration / 60;
                const rule = gridRules.find(r => durMins <= r.maxMins) || gridRules[gridRules.length-1];
                const TOTAL_FRAMES = rule.cols * rule.rows;

                statusEl.innerText = `Drawing ${rule.cols}x${rule.rows} layout for ${videoObj.name}...`;
                barEl.style.width = '0%';

                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                const scale = 0.5;
                const thumbW = width * scale, thumbH = height * scale;
                const headerH = 140;

                canvas.width = thumbW * rule.cols;
                canvas.height = (thumbH * rule.rows) + headerH;

                let fileSizeStr = "Unknown Size";
                try {
                    const headHeaders = await h.http.head(cdnUrl);
                    if (headHeaders) {
                        const match = headHeaders.match(/content-length:\s*(\d+)/i);
                        if (match && match[1]) fileSizeStr = h.formatBytes(parseInt(match[1]));
                    }
                } catch(e) {}

                ctx.fillStyle = "#151515"; ctx.fillRect(0, 0, canvas.width, headerH);
                ctx.fillStyle = "#00FF66"; ctx.fillRect(0, headerH - 4, canvas.width, 4);

                ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 26px Arial";
                ctx.fillText(`File: ${videoObj.name}`, 20, 40);

                ctx.font = "18px Arial"; ctx.fillStyle = "#AAAAAA";
                ctx.fillText(`Source: ${videoObj.original}`, 20, 75);

                ctx.fillStyle = "#DDDDDD"; ctx.font = "20px Arial";
                const formattedDur = `${Math.floor(duration/60)}m ${Math.floor(duration%60)}s`;
                ctx.fillText(`Resolution: ${width}x${height}  |  Duration: ${formattedDur}  |  Size: ${fileSizeStr}`, 20, 110);

                const timeInterval = duration / (TOTAL_FRAMES + 1);
                const frameTasks = [];
                for (let r = 0; r < rule.rows; r++) {
                    for (let c = 0; c < rule.cols; c++) {
                        frameTasks.push({ targetTime: timeInterval * ((r * rule.cols) + c + 1), drawX: c * thumbW, drawY: (r * thumbH) + headerH });
                    }
                }

                const workers = [];
                for(let i=0; i<workerCount; i++) {
                    const wVid = document.createElement('video');
                    wVid.muted = true; wVid.playsInline = true; wVid.preload = "metadata"; wVid.src = cdnUrl;
                    workers.push(wVid);
                }

                let taskIndex = 0, completedFrames = 0, securityErrorTriggered = false, canvasTainted = false;

                async function processFrames(workerVid) {
                    while (taskIndex < frameTasks.length) {
                        if (securityErrorTriggered || stopRequested) return;
                        const task = frameTasks[taskIndex++];

                        await new Promise((res) => {
                            workerVid.currentTime = task.targetTime;
                            const handler = () => { workerVid.removeEventListener('seeked', handler); setTimeout(res, 300); };
                            workerVid.addEventListener('seeked', handler);
                        });

                        try {
                            ctx.drawImage(workerVid, task.drawX, task.drawY, thumbW, thumbH);
                            completedFrames++;
                            const pct = Math.round((completedFrames / TOTAL_FRAMES) * 100);
                            statusEl.innerText = `Rendering frames... ${pct}% (${completedFrames}/${TOTAL_FRAMES}) - ${videoObj.name}`;
                            barEl.style.width = `${pct}%`;
                        } catch (e) {
                            if (e.name === 'SecurityError') { securityErrorTriggered = true; throw e; }
                        }

                        const m = Math.floor(task.targetTime / 60), s = Math.floor(task.targetTime % 60);
                        const timeStr = `${m}:${s < 10 ? '0' : ''}${s}`;
                        ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; ctx.fillRect(task.drawX + 10, task.drawY + 10, ctx.measureText(timeStr).width + 16, 28);
                        ctx.fillStyle = "white"; ctx.font = "bold 18px Arial"; ctx.fillText(timeStr, task.drawX + 18, task.drawY + 30);
                    }
                }

                try {
                    await Promise.all(workers.map(w => processFrames(w)));
                } catch (e) {
                    workers.forEach(w => w.src = ""); return resolvePromise(false);
                }

                workers.forEach(w => w.src = ""); probeVideo.src = "";
                if (stopRequested) return resolvePromise(false);

                // Explicit Try-Catch for Canvas Taint
                let base64Data;
                try {
                    base64Data = canvas.toDataURL('image/jpeg', 0.85);
                } catch (e) {
                    if (e.name === 'SecurityError') {
                        containerEl.innerHTML += `<div style="background:#331111; border:1px solid #ff4444; padding:15px; border-radius:8px; color:#ffaaaa;"><b>❌ CORS Taint Error:</b> ${videoObj.name}<br><span style="font-size:12px;">Your browser blocked the script from saving the image due to strict cross-origin security on this specific CDN link. You must enable a CORS unblocker extension.</span></div>`;
                        return resolvePromise(false);
                    }
                }

                completedSheets.push({ obj: videoObj, cdn: cdnUrl, img: base64Data });

                const block = document.createElement('div');
                block.style.cssText = "background:#1a1a1a; border:1px solid #333; padding:15px; border-radius:8px;";
                block.innerHTML = `
                    <a href="${base64Data}" download="${videoObj.name}_Sheet.jpg" title="Click to download image">
                        <img src="${base64Data}" style="width:100%; border-radius:4px; box-shadow:0 4px 10px rgba(0,0,0,0.5);">
                    </a>
                    <div style="margin-top:15px; padding:10px; background:#000; border-radius:4px; word-break:break-all;">
                        <a href="${cdnUrl}" target="_blank" style="color:#0078FF; font-weight:bold; text-decoration:none;">⬇️ Direct CDN Download Link</a>
                        <br><span style="font-size:11px; color:#aaa;">${cdnUrl}</span>
                    </div>
                `;
                containerEl.appendChild(block);
                resolvePromise(true);
            });

            probeVideo.addEventListener('error', () => resolvePromise(false));
            probeVideo.src = cdnUrl;
        });
    }

    // ==========================================
    // 8. EXPORT TO DOC (HTML BLOB)
    // ==========================================
    function exportToDoc() {
        if (!completedSheets.length) return alert("No sheets completed to export.");

        let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Video Contact Sheets</title>
            <style>
                body { font-family: Arial, sans-serif; background: #ffffff; color: #000; max-width: 1200px; margin: 0 auto; padding: 20px; }
                .sheet-block { margin-bottom: 50px; padding-bottom: 20px; border-bottom: 2px solid #ccc; }
                img { width: 100%; height: auto; border: 1px solid #000; }
                .links { margin-top: 15px; padding: 15px; background: #f5f5f5; border: 1px solid #ddd; }
                a { color: #0056b3; text-decoration: none; font-weight: bold; font-size: 16px; }
                a:hover { text-decoration: underline; }
                .url-text { font-family: monospace; font-size: 12px; color: #555; word-break: break-all; margin-top: 5px; display: block; }
                .original-link { font-size: 14px; color: #d32f2f; margin-bottom: 10px; display: block; }
            </style>
        </head>
        <body>
            <h1>Video Contact Sheets Export</h1>
            <p>Generated on: ${new Date().toLocaleString()}</p>
            <hr>
        `;

        completedSheets.forEach(sheet => {
            html += `
                <div class="sheet-block">
                    <h2>${sheet.obj.name}</h2>
                    <img src="${sheet.img}">
                    <div class="links">
                        <a class="original-link" href="${sheet.obj.original}" target="_blank">🔗 Original Source / Album Link</a>
                        <a href="${sheet.cdn}" target="_blank">⬇️ Direct Video Download Link</a>
                        <span class="url-text">${sheet.cdn}</span>
                    </div>
                </div>
            `;
        });

        html += `</body></html>`;

        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Video_Sheets_Export_${Date.now()}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    const runInject = () => {
        if (document.readyState === 'complete' || document.readyState === 'interactive') initUI();
        else { window.addEventListener('DOMContentLoaded', initUI); window.addEventListener('load', initUI); }
    };
    runInject();
    setInterval(() => { if (!document.getElementById('xfpd-v6-btn')) runInject(); }, 2000);

})();