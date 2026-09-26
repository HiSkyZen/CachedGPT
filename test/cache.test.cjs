const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createIndexedDb() {
    const records = new Map();
    const asyncRequest = (transaction, operation) => {
        const request = {};
        queueMicrotask(() => {
            request.result = operation();
            request.onsuccess?.();
            if (transaction) queueMicrotask(() => transaction.oncomplete?.());
        });
        return request;
    };
    const db = {
        objectStoreNames: { contains: () => false },
        createObjectStore: () => ({ createIndex() {} }),
        transaction() {
            const transaction = {
                objectStore: () => ({
                    get: key => asyncRequest(null, () => records.get(key)),
                    getAll: () => asyncRequest(null, () => [...records.values()]),
                    put: record => asyncRequest(transaction, () => records.set(record.key, { ...record })),
                    delete: key => asyncRequest(transaction, () => records.delete(key)),
                    index: () => ({
                        openCursor: namespace => {
                            const request = {};
                            const entries = [...records.entries()].filter(([, record]) => record.namespace === namespace);
                            let index = 0;
                            const next = () => queueMicrotask(() => {
                                const entry = entries[index++];
                                request.result = entry ? {
                                    value: { ...entry[1] },
                                    update(value) { records.set(entry[0], { ...value }); },
                                    continue: next,
                                } : null;
                                request.onsuccess?.();
                                if (!entry) queueMicrotask(() => transaction.oncomplete?.());
                            });
                            next();
                            return request;
                        },
                    }),
                }),
            };
            return transaction;
        },
    };
    return {
        records,
        open() {
            const request = {};
            queueMicrotask(() => {
                request.result = db;
                request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };
}

function createHarness() {
    const indexedDB = createIndexedDb();
    const calls = [];
    let now = 1_000_000;
    let responder = () => new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
    const nativeFetch = async (input, init) => {
        calls.push({ input, init });
        return responder(input, init);
    };
    const window = { fetch: nativeFetch, alert() {} };
    class FakeDate extends Date {
        static now() { return now; }
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'cachedgpt.user.js'), 'utf8')
        .replace('SHOW_STATUS: true,', 'SHOW_STATUS: false,');
    vm.runInNewContext(source, {
        window,
        indexedDB,
        IDBKeyRange: { only: value => value },
        URL,
        Headers,
        Request,
        Response,
        Blob,
        DOMException,
        Date: FakeDate,
        Element: class {},
        MutationObserver: class { observe() {} },
        document: { documentElement: {} },
        location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
        requestAnimationFrame() {},
        setTimeout(fn, ms) {
            if (ms < 7_000) {
                now += ms;
                queueMicrotask(fn);
            }
            return 1;
        },
        clearTimeout() {},
        console: { info() {}, warn(error) { throw error; } },
    });
    const headers = account => ({ 'ChatGPT-Account-Id': account });
    return {
        fetch: window.fetch,
        calls,
        headers,
        advance(ms) { now += ms; },
        respondWith(fn) { responder = fn; },
        records: indexedDB.records,
    };
}

test('caches the current sidebar endpoints and leaves conversation bodies alone', async () => {
    const h = createHarness();
    const urls = [
        '/backend-api/conversations?limit=20&offset=0',
        '/backend-api/gizmos/snorlax/sidebar?limit=20',
        '/backend-api/gizmos/g-p-123/conversations?limit=5',
        '/backend-api/pins?item_type=conversation',
    ];
    h.respondWith(input => new Response(
        JSON.stringify(String(input).includes('/pins?') ? [] : { items: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    for (const url of urls) {
        await h.fetch(url, { headers: h.headers('account-a') });
        const cached = await h.fetch(url, { headers: h.headers('account-a') });
        assert.equal(cached.headers.get('x-cachedgpt'), 'fresh-cache');
    }
    assert.equal(h.calls.length, urls.length);
    await h.fetch('/backend-api/conversation/123', { headers: h.headers('account-a') });
    await h.fetch('/backend-api/conversation/123', { headers: h.headers('account-a') });
    assert.equal(h.calls.length, urls.length + 2);
});

test('429 returns stale data and suppresses further server requests during cooldown', async () => {
    const h = createHarness();
    const url = '/backend-api/conversations?limit=20&offset=0';
    await h.fetch(url, { headers: h.headers('account-a') });
    h.advance(31_000);
    h.respondWith(() => new Response('{}', { status: 429, headers: { 'retry-after': '40' } }));
    const fallback = await h.fetch(url, { headers: h.headers('account-a') });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get('x-cachedgpt'), '429-fallback');
    const duringCooldown = await h.fetch(url, { headers: h.headers('account-a') });
    assert.equal(duringCooldown.headers.get('x-cachedgpt'), '429-cooldown');
    assert.equal(h.calls.length, 2);
});

test('a 429 on task history does not block ordinary conversation history', async () => {
    const h = createHarness();
    h.respondWith(input => new URL(String(input), 'https://chatgpt.com').searchParams.get('conversation_origin') === 'tpp'
        ? new Response('{}', { status: 429 })
        : new Response(JSON.stringify({ items: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        }));
    const tasks = '/backend-api/conversations?conversation_origin=tpp&limit=20';
    const chats = '/backend-api/conversations?exclude_conversation_origin=tpp&limit=20';
    assert.equal((await h.fetch(tasks, { headers: h.headers('account-a') })).status, 429);
    assert.equal((await h.fetch(tasks, { headers: h.headers('account-a') })).status, 429);
    assert.equal((await h.fetch(chats, { headers: h.headers('account-a') })).status, 200);
    assert.equal(h.calls.length, 2);
});

test('deduplicates simultaneous identical list requests', async () => {
    const h = createHarness();
    const url = '/backend-api/conversations?limit=20&offset=0';
    const responses = await Promise.all(Array.from({ length: 4 }, () =>
        h.fetch(url, { headers: h.headers('account-a') })));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(await Promise.all(responses.map(response => response.json())),
        Array.from({ length: 4 }, () => ({ items: [], total: 0 })));
});

test('separates accounts, bypasses unidentified requests, and invalidates after writes', async () => {
    const h = createHarness();
    const url = '/backend-api/conversations?limit=20&offset=0';
    await h.fetch(url, { headers: h.headers('account-a') });
    await h.fetch(url, { headers: h.headers('account-b') });
    assert.equal(h.calls.length, 2);
    await h.fetch(url);
    await h.fetch(url);
    assert.equal(h.calls.length, 4);
    await h.fetch('/backend-api/conversation/123', {
        method: 'PATCH', headers: h.headers('account-b'),
    });
    await h.fetch(url, { headers: h.headers('account-b') });
    assert.equal(h.calls.length, 6);
    assert.equal(h.records.size, 2);
});

test('conversation initialization on page load does not invalidate the sidebar', async () => {
    const h = createHarness();
    const url = '/backend-api/conversations?limit=20&offset=0';
    await h.fetch(url, { headers: h.headers('account-a') });
    await h.fetch('/backend-api/conversation/init', {
        method: 'POST', headers: h.headers('account-a'),
    });
    const cached = await h.fetch(url, { headers: h.headers('account-a') });
    assert.equal(cached.headers.get('x-cachedgpt'), 'fresh-cache');
    assert.equal(h.calls.length, 2);
});

test('does not cache a successful response with the wrong sidebar shape', async () => {
    const h = createHarness();
    h.respondWith(() => new Response(JSON.stringify({ error: 'not a list' }), {
        status: 200, headers: { 'content-type': 'application/json' },
    }));
    await h.fetch('/backend-api/conversations', { headers: h.headers('account-a') });
    await h.fetch('/backend-api/conversations', { headers: h.headers('account-a') });
    assert.equal(h.calls.length, 2);
    assert.equal(h.records.size, 0);
});
