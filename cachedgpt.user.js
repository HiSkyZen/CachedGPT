// ==UserScript==
// @name         CachedGPT
// @namespace    https://github.com/HiSkyZen/CachedGPT
// @version      1.1.0
// @description  Cache ChatGPT sidebar data, reduce repeat requests, and keep cached lists visible during 429 cooldowns.
// @description:ko ChatGPT 사이드바 데이터를 캐시하여 반복 요청을 줄이고 429 대기 중에도 저장된 목록을 보여줍니다.
// @author       HiSkyZen
// @license      MIT
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// @homepageURL  https://github.com/HiSkyZen/CachedGPT
// @supportURL   https://github.com/HiSkyZen/CachedGPT/issues
// @downloadURL  https://raw.githubusercontent.com/HiSkyZen/CachedGPT/main/cachedgpt.user.js
// @updateURL    https://raw.githubusercontent.com/HiSkyZen/CachedGPT/main/cachedgpt.user.js
// ==/UserScript==

(() => {
    'use strict';

    const nativeFetch = window.fetch.bind(window);
    const nativeAlert = window.alert.bind(window);

    const CFG = {
        LIST_FRESH_MS: 30_000,
        MIN_NETWORK_GAP_MS: 500,
        INITIAL_BACKOFF_MS: 15_000,
        MAX_BACKOFF_MS: 120_000,
        CACHE_MAX_BYTES: 128 * 1024 * 1024,
        SHOW_STATUS: true,
        STATUS_DURATION_MS: 7_000,
        DB_NAME: 'cachedgpt',
        DB_VERSION: 1,
        STORE: 'responses',
    };

    let dbPromise = null;
    let networkChain = Promise.resolve();
    let lastNetworkStart = 0;
    const cooldowns = new Map();
    const invalidatedAt = new Map();

    const inflight = new Map();

    const channel = typeof BroadcastChannel === 'function'
        ? new BroadcastChannel('cachedgpt-sidebar-v1')
        : null;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function mergedHeaders(input, init) {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        if (init?.headers) {
            for (const [key, value] of new Headers(init.headers)) {
                headers.set(key, value);
            }
        }
        return headers;
    }

    function getCacheNamespace(input, init) {
        const accountId = mergedHeaders(input, init).get('chatgpt-account-id');
        return accountId ? `account:${accountId}` : null;
    }

    function getRequestMeta(input, init) {
        const rawUrl = input instanceof Request ? input.url : String(input);
        const method = String(
            init?.method || (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();

        let url;
        try {
            url = new URL(rawUrl, location.href);
        } catch {
            return null;
        }

        if (url.origin !== location.origin) return null;

        const namespace = getCacheNamespace(input, init);
        if (!namespace) return null;

        const isNormalList = /^\/backend-api\/conversations\/?$/.test(url.pathname);
        const isProjectList = /^\/backend-api\/gizmos\/[^/]+\/conversations\/?$/.test(url.pathname);
        const isProjectSidebar = /^\/backend-api\/gizmos\/snorlax\/sidebar\/?$/.test(url.pathname);
        const isPins = /^\/backend-api\/pins\/?$/.test(url.pathname);
        const type = isPins ? 'pins' : isProjectSidebar ? 'sidebar' : 'list';

        if (method !== 'GET') {
            const changesSidebar = /^\/backend-api\/(?:conversation(?:s)?|gizmos|pins)(?:\/|$)/.test(url.pathname) &&
                !/^\/backend-api\/conversation\/init\/?$/.test(url.pathname);
            return changesSidebar
                ? { namespace, mutation: true }
                : null;
        }
        if (!isNormalList && !isProjectList && !isProjectSidebar && !isPins) return null;

        const listKind = isNormalList
            ? url.searchParams.get('conversation_origin') ||
              `excluding:${url.searchParams.get('exclude_conversation_origin') || 'none'}`
            : isPins ? url.searchParams.get('item_type') || 'all' : '';

        return {
            url,
            type,
            namespace,
            key: `${namespace}|${url.href}`,
            bucket: `${namespace}|${url.pathname}|${listKind}`,
            signal: init?.signal || (input instanceof Request ? input.signal : undefined),
        };
    }

    function openDb() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(CFG.DB_NAME, CFG.DB_VERSION);

            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CFG.STORE)) {
                    const store = db.createObjectStore(CFG.STORE, { keyPath: 'key' });
                    store.createIndex('namespace', 'namespace', { unique: false });
                    store.createIndex('accessedAt', 'accessedAt', { unique: false });
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        return dbPromise;
    }

    async function idbGet(key) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CFG.STORE, 'readonly');
            const req = tx.objectStore(CFG.STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbPut(record) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CFG.STORE, 'readwrite');
            tx.objectStore(CFG.STORE).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function idbDelete(keys) {
        if (!keys.length) return;

        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CFG.STORE, 'readwrite');
            const store = tx.objectStore(CFG.STORE);
            for (const key of keys) store.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function idbMarkStale(namespace) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CFG.STORE, 'readwrite');
            const cursor = tx.objectStore(CFG.STORE).index('namespace').openCursor(IDBKeyRange.only(namespace));
            cursor.onsuccess = () => {
                const entry = cursor.result;
                if (!entry) return;
                if (entry.value.type !== 'detail') {
                    entry.value.freshUntil = 0;
                    entry.update(entry.value);
                }
                entry.continue();
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getAllRecords() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CFG.STORE, 'readonly');
            const req = tx.objectStore(CFG.STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function serializeResponse(response, info) {
        const clone = response.clone();
        const body = await clone.text();
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch {
            return null;
        }
        if (info.type === 'pins' ? !Array.isArray(parsed) : !Array.isArray(parsed?.items)) {
            return null;
        }
        const headers = {};

        for (const [name, value] of clone.headers.entries()) {
            const lower = name.toLowerCase();
            if (
                lower === 'content-type' ||
                lower === 'cache-control' ||
                lower === 'etag' ||
                lower === 'last-modified'
            ) {
                headers[name] = value;
            }
        }

        return {
            key: info.key,
            namespace: info.namespace,
            type: info.type,
            status: clone.status,
            statusText: clone.statusText,
            headers,
            body,
            bytes: new Blob([body]).size,
            storedAt: Date.now(),
            accessedAt: Date.now(),
            freshUntil: Infinity,
        };
    }

    function responseFromRecord(record, reason) {
        const headers = new Headers(record.headers || {});
        headers.set('x-cachedgpt', reason);

        return new Response(record.body, {
            status: record.status || 200,
            statusText: record.statusText || 'OK',
            headers,
        });
    }

    async function readCache(info) {
        try {
            const record = await idbGet(info.key);
            if (!record) return null;

            return {
                record,
                fresh: record.freshUntil !== 0 &&
                    record.storedAt >= (invalidatedAt.get(info.namespace) || 0) &&
                    Date.now() - record.storedAt <= CFG.LIST_FRESH_MS,
            };
        } catch (error) {
            console.warn('[CachedGPT] Cache read failed', error);
            return null;
        }
    }

    async function saveCache(response, info, startedAt) {
        if (response.status !== 200) return;

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().includes('json')) return;

        try {
            const record = await serializeResponse(response, info);
            if (!record) return;
            if (startedAt < (invalidatedAt.get(info.namespace) || 0)) {
                record.freshUntil = 0;
            }
            await idbPut(record);
        } catch (error) {
            console.warn('[CachedGPT] Cache write failed', error);
        }
    }

    function parseRetryAfter(response) {
        const raw = response.headers.get('retry-after');
        if (!raw) return null;

        const seconds = Number(raw);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

        const timestamp = Date.parse(raw);
        if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());

        return null;
    }

    function getCooldown(bucket) {
        return cooldowns.get(bucket) || {
            until: 0,
            backoffMs: CFG.INITIAL_BACKOFF_MS,
        };
    }

    function setCooldown(bucket, state, broadcast = true) {
        const previous = getCooldown(bucket);
        cooldowns.set(bucket, {
            until: Math.max(previous.until, state.until),
            backoffMs: Math.max(previous.backoffMs, state.backoffMs),
        });
        if (broadcast) channel?.postMessage({ type: 'cooldown', bucket, ...cooldowns.get(bucket) });
    }

    function markCacheStale(namespace, at = Date.now(), broadcast = true) {
        invalidatedAt.set(namespace, Math.max(invalidatedAt.get(namespace) || 0, at));
        void idbMarkStale(namespace).catch(error => console.warn('[CachedGPT] Invalidation failed', error));
        if (broadcast) channel?.postMessage({ type: 'invalidate', namespace, at });
    }

    if (channel) {
        channel.onmessage = ({ data }) => {
            if (!data) return;
            if (data.type === 'cooldown' && typeof data.bucket === 'string' &&
                Number.isFinite(data.until) && Number.isFinite(data.backoffMs)) {
                setCooldown(data.bucket, data, false);
            } else if (data.type === 'invalidate' && typeof data.namespace === 'string' && Number.isFinite(data.at)) {
                markCacheStale(data.namespace, data.at, false);
            }
        };
    }

    function cooldownResponse(info, cached) {
        if (cached?.record) {
            showStatus(`CachedGPT · 429 cooldown · cached ${formatAge(cached.record.storedAt)} ago`);
            return responseFromRecord(cached.record, '429-cooldown');
        }
        const seconds = Math.ceil(Math.max(0, getCooldown(info.bucket).until - Date.now()) / 1000);
        return new Response(JSON.stringify({ detail: 'Rate limited; waiting before retrying.' }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': String(seconds) },
        });
    }

    function formatAge(storedAt) {
        const minutes = Math.floor(Math.max(0, Date.now() - storedAt) / 60_000);
        if (minutes < 1) return 'less than a minute';
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hr`;
        return `${Math.floor(hours / 24)} days`;
    }

    async function queuedNetworkFetch(input, init, info, cached) {
        const work = networkChain
            .catch(() => {})
            .then(async () => {
                if (info.signal?.aborted) {
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }
                if (getCooldown(info.bucket).until > Date.now()) {
                    return cooldownResponse(info, cached);
                }

                const wait = lastNetworkStart + CFG.MIN_NETWORK_GAP_MS - Date.now();
                if (wait > 0) await sleep(wait);

                if (info.signal?.aborted) {
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }
                if (getCooldown(info.bucket).until > Date.now()) {
                    return cooldownResponse(info, cached);
                }

                lastNetworkStart = Date.now();
                const startedAt = lastNetworkStart;
                const response = await nativeFetch(input, init);

                if (response.status === 429) {
                    const retryAfter = parseRetryAfter(response);
                    const backoffMs = getCooldown(info.bucket).backoffMs;
                    const delay = Math.max(retryAfter ?? 0, backoffMs);
                    setCooldown(info.bucket, {
                        until: Date.now() + delay,
                        backoffMs: Math.min(backoffMs * 2, CFG.MAX_BACKOFF_MS),
                    });
                    showStatus(`CachedGPT · 429 · ${Math.ceil(delay / 1000)}s cooldown`);
                } else if (response.ok) {
                    cooldowns.set(info.bucket, { until: 0, backoffMs: CFG.INITIAL_BACKOFF_MS });
                    await saveCache(response, info, startedAt);
                }

                return response;
            });

        networkChain = work.then(() => undefined, () => undefined);
        return work;
    }

    function fetchWithDedupe(input, init, info, cached) {
        if (info.signal) return queuedNetworkFetch(input, init, info, cached);
        const existing = inflight.get(info.key);
        if (existing) return existing.then(response => response.clone());

        const promise = queuedNetworkFetch(input, init, info, cached)
            .finally(() => inflight.delete(info.key));

        inflight.set(info.key, promise);
        return promise.then(response => response.clone());
    }

    window.fetch = async function cachedGptFetch(input, init) {
        const info = getRequestMeta(input, init);
        if (!info) return nativeFetch(input, init);

        if (info.mutation) {
            const response = await nativeFetch(input, init);
            if (response.ok) markCacheStale(info.namespace);
            return response;
        }

        const cached = await readCache(info);

        if (cached?.fresh) {
            return responseFromRecord(cached.record, 'fresh-cache');
        }

        if (getCooldown(info.bucket).until > Date.now()) {
            return cooldownResponse(info, cached);
        }

        try {
            const response = await fetchWithDedupe(input, init, info, cached);

            if (response.status === 429 && cached?.record) {
                showStatus(`CachedGPT · 429 · cached ${formatAge(cached.record.storedAt)} ago`);
                return responseFromRecord(cached.record, '429-fallback');
            }

            return response;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;

            if (cached?.record) {
                showStatus(`CachedGPT · network error · cached ${formatAge(cached.record.storedAt)} ago`);
                return responseFromRecord(cached.record, 'network-fallback');
            }

            throw error;
        }
    };

    let statusElement = null;
    let statusTimer = 0;

    function ensureStatusElement() {
        if (statusElement?.isConnected) return statusElement;
        if (!document.documentElement) return null;

        const el = document.createElement('div');
        el.id = '__cachedgpt_status';

        Object.assign(el.style, {
            position: 'fixed',
            right: '12px',
            bottom: '12px',
            zIndex: '2147483647',
            padding: '5px 8px',
            borderRadius: '7px',
            background: 'rgba(32,32,32,.82)',
            color: '#fff',
            font: '11px/1.25 system-ui, sans-serif',
            boxShadow: '0 1px 5px rgba(0,0,0,.22)',
            opacity: '0',
            transition: 'opacity .15s ease',
            pointerEvents: 'none',
            maxWidth: '360px',
            userSelect: 'none',
        });

        document.documentElement.appendChild(el);
        statusElement = el;
        return el;
    }

    function showStatus(text) {
        if (!CFG.SHOW_STATUS) return;

        const el = ensureStatusElement();
        if (!el) return;

        el.textContent = text;
        el.style.opacity = '1';

        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            if (statusElement) statusElement.style.opacity = '0';
        }, CFG.STATUS_DURATION_MS);
    }

    const RATE_LIMIT_PATTERNS = [
        /요청을 너무 빠르게 보내고 있습니다/i,
        /데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한/i,
        /대화에 대한 액세스가 일시적으로 제한/i,
        /몇 분 후 다시 시도해 주세요/i,
        /you(?:'|’)re making requests too quickly/i,
        /temporarily limited access to your conversations/i,
        /please wait a few minutes before trying again/i,
    ];

    function looksLikeKnownRateLimit(text) {
        return Boolean(text) && RATE_LIMIT_PATTERNS.some(regex => regex.test(text));
    }

    function findDismissTarget(element) {
        if (!(element instanceof Element)) return null;

        const dialog = element.closest('[role="dialog"], [aria-modal="true"], [role="alertdialog"]');
        if (dialog && looksLikeKnownRateLimit(dialog.textContent)) {
            return dialog.closest('[data-radix-portal]') || dialog;
        }

        let current = element;
        for (let i = 0; current && i < 7; i++, current = current.parentElement) {
            const text = current.textContent || '';
            if (text.length === 0 || text.length > 1800 || !looksLikeKnownRateLimit(text)) continue;

            const style = getComputedStyle(current);
            if (style.position === 'fixed' || style.position === 'absolute') return current;
        }

        return null;
    }

    function repairModalLocks() {
        requestAnimationFrame(() => {
            const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alertdialog"]')];
            const otherVisibleDialog = dialogs.some(dialog => {
                if (looksLikeKnownRateLimit(dialog.textContent)) return false;
                const style = getComputedStyle(dialog);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });

            if (otherVisibleDialog || !document.body) return;

            if (document.body.style.pointerEvents === 'none') {
                document.body.style.pointerEvents = '';
            }
            if (document.body.style.overflow === 'hidden') {
                document.body.style.overflow = '';
            }
        });
    }

    function suppressElement(element) {
        if (!(element instanceof Element)) return false;
        if (!looksLikeKnownRateLimit(element.textContent || '')) return false;

        const target = findDismissTarget(element);
        if (!target) return false;

        target.remove();
        repairModalLocks();
        showStatus('CachedGPT · conversation access limited · cache/backoff active');
        return true;
    }

    function scanForKnownModal(root) {
        if (!(root instanceof Element)) return false;
        if (suppressElement(root)) return true;

        for (const dialog of root.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alertdialog"]')) {
            if (suppressElement(dialog)) return true;
        }

        return false;
    }

    window.alert = function cachedGptAlert(message) {
        const text = String(message);
        if (looksLikeKnownRateLimit(text)) {
            showStatus('CachedGPT · conversation access limited · cache/backoff active');
            return;
        }
        return nativeAlert(message);
    };

    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;
                const text = node.textContent || '';
                if (looksLikeKnownRateLimit(text)) scanForKnownModal(node);
            }
        }
    });

    function startObserver() {
        if (!document.documentElement) {
            requestAnimationFrame(startObserver);
            return;
        }

        observer.observe(document.documentElement, { childList: true, subtree: true });
        scanForKnownModal(document.documentElement);
    }

    startObserver();

    async function cleanupCache() {
        try {
            const records = await getAllRecords();
            const obsolete = records
                .filter(record => record.type === 'detail')
                .map(record => record.key);
            await idbDelete(obsolete);

            const obsoleteSet = new Set(obsolete);
            const live = records
                .filter(record => !obsoleteSet.has(record.key))
                .sort((a, b) => (b.accessedAt || b.storedAt) - (a.accessedAt || a.storedAt));

            let totalBytes = live.reduce((sum, record) => sum + (record.bytes || 0), 0);
            const evict = [];

            for (let i = live.length - 1; i >= 0 && totalBytes > CFG.CACHE_MAX_BYTES; i--) {
                evict.push(live[i].key);
                totalBytes -= live[i].bytes || 0;
            }

            await idbDelete(evict);
        } catch (error) {
            console.warn('[CachedGPT] Cache cleanup failed', error);
        }
    }

    setTimeout(() => void cleanupCache(), 10_000);

    console.info('[CachedGPT] active', {
        listCache: `${CFG.LIST_FRESH_MS / 1000}s`,
        maxCache: `${CFG.CACHE_MAX_BYTES / 1024 / 1024} MiB`,
        staleFallback: 'until storage limit',
    });
})();
