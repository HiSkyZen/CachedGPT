// ==UserScript==
// @name         CachedGPT
// @namespace    https://github.com/HiSkyZen/CachedGPT
// @version      1.0.0
// @description  Cache and deduplicate ChatGPT conversation requests, back off on 429 responses, and replace intrusive rate-limit dialogs with a quiet status indicator.
// @description:ko ChatGPT 대화 요청을 캐시·중복 제거하고 429 응답 시 백오프하며, 방해되는 대화 접근 제한 알림을 조용한 상태 표시로 대체합니다.
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
        DETAIL_FRESH_MS: 3_000,
        MIN_NETWORK_GAP_MS: 1_500,
        INITIAL_BACKOFF_MS: 15_000,
        MAX_BACKOFF_MS: 120_000,
        CACHE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
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
    let cooldownUntil = 0;
    let backoffMs = CFG.INITIAL_BACKOFF_MS;

    const inflight = new Map();

    const tabNamespace = (() => {
        const key = '__cachedgpt_namespace';
        let value = sessionStorage.getItem(key);

        if (!value) {
            value = crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random()}`;
            sessionStorage.setItem(key, value);
        }

        return value;
    })();

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
        const headers = mergedHeaders(input, init);
        const accountId = headers.get('chatgpt-account-id');
        return accountId ? `account:${accountId}` : `tab:${tabNamespace}`;
    }

    function getRequestMeta(input, init) {
        const rawUrl = input instanceof Request ? input.url : String(input);
        const method = String(
            init?.method || (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();

        if (method !== 'GET') return null;

        let url;
        try {
            url = new URL(rawUrl, location.href);
        } catch {
            return null;
        }

        if (url.origin !== location.origin) return null;

        const isNormalList = /^\/backend-api\/conversations\/?$/.test(url.pathname);
        const isProjectList = /^\/backend-api\/gizmos\/[^/]+\/conversations\/?$/.test(url.pathname);
        const isDetail = /^\/backend-api\/conversation\/[^/]+\/?$/.test(url.pathname);

        if (!isNormalList && !isProjectList && !isDetail) return null;

        const namespace = getCacheNamespace(input, init);
        const type = isDetail ? 'detail' : 'list';

        return {
            url,
            type,
            namespace,
            key: `${namespace}|${url.href}`,
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

    async function readCache(key, freshMs = Infinity) {
        try {
            const record = await idbGet(key);
            if (!record) return null;

            const age = Date.now() - record.storedAt;
            if (age > CFG.CACHE_MAX_AGE_MS) {
                await idbDelete([key]);
                return null;
            }

            record.accessedAt = Date.now();
            void idbPut(record).catch(() => {});

            return {
                record,
                fresh: age <= freshMs,
            };
        } catch (error) {
            console.warn('[CachedGPT] Cache read failed', error);
            return null;
        }
    }

    async function saveCache(response, info) {
        if (!response.ok) return;

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().includes('json')) return;

        try {
            const record = await serializeResponse(response, info);
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

    async function queuedNetworkFetch(input, init, info) {
        const work = networkChain
            .catch(() => {})
            .then(async () => {
                const nextAllowed = Math.max(
                    lastNetworkStart + CFG.MIN_NETWORK_GAP_MS,
                    cooldownUntil
                );

                if (nextAllowed > Date.now()) {
                    await sleep(nextAllowed - Date.now());
                }

                const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
                if (signal?.aborted) {
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }

                lastNetworkStart = Date.now();
                const response = await nativeFetch(input, init);

                if (response.status === 429) {
                    const retryAfter = parseRetryAfter(response);
                    const delay = Math.max(retryAfter || 0, backoffMs);
                    cooldownUntil = Date.now() + delay;
                    backoffMs = Math.min(backoffMs * 2, CFG.MAX_BACKOFF_MS);
                    showStatus(`CachedGPT · 429 · ${Math.ceil(delay / 1000)}s cooldown · cache fallback`);
                } else if (response.ok) {
                    cooldownUntil = 0;
                    backoffMs = CFG.INITIAL_BACKOFF_MS;
                    void saveCache(response, info);
                }

                return response;
            });

        networkChain = work.then(() => undefined, () => undefined);
        return work;
    }

    function fetchWithDedupe(input, init, info) {
        const existing = inflight.get(info.key);
        if (existing) return existing.then(response => response.clone());

        const promise = queuedNetworkFetch(input, init, info)
            .finally(() => inflight.delete(info.key));

        inflight.set(info.key, promise);
        return promise.then(response => response.clone());
    }

    window.fetch = async function cachedGptFetch(input, init) {
        const info = getRequestMeta(input, init);
        if (!info) return nativeFetch(input, init);

        const freshMs = info.type === 'list' ? CFG.LIST_FRESH_MS : CFG.DETAIL_FRESH_MS;
        const cached = await readCache(info.key, freshMs);

        if (cached?.fresh) {
            return responseFromRecord(cached.record, 'fresh-cache');
        }

        try {
            const response = await fetchWithDedupe(input, init, info);

            if (response.status === 429 && cached?.record) {
                return responseFromRecord(cached.record, '429-fallback');
            }

            return response;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;

            if (cached?.record) {
                showStatus('CachedGPT · network error · using last cached response');
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
            const now = Date.now();

            const expired = records
                .filter(record => now - record.storedAt > CFG.CACHE_MAX_AGE_MS)
                .map(record => record.key);

            await idbDelete(expired);

            const expiredSet = new Set(expired);
            const live = records
                .filter(record => !expiredSet.has(record.key))
                .sort((a, b) => b.accessedAt - a.accessedAt);

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
        detailCache: `${CFG.DETAIL_FRESH_MS / 1000}s`,
        maxCache: `${CFG.CACHE_MAX_BYTES / 1024 / 1024} MiB`,
        staleFallback: `${CFG.CACHE_MAX_AGE_MS / 86_400_000} days`,
    });
})();
