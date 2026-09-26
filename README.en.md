# CachedGPT

[한국어](./README.md)

CachedGPT is a browser userscript that caches ChatGPT sidebar lists, deduplicates overlapping requests, and reduces 429 (Too Many Requests) failures. When a 429 occurs, it keeps showing previously cached lists where available.

> **Unofficial project.** This project is not affiliated with, endorsed by, or sponsored by OpenAI or ChatGPT. Internal ChatGPT endpoints and DOM structures may change at any time.

## Install

**[▶ Install CachedGPT userscript](https://raw.githubusercontent.com/HiSkyZen/CachedGPT/main/cachedgpt.user.js)**

The link above points directly to a `.user.js` file. With Tampermonkey or Violentmonkey installed, it should normally open the userscript installation screen automatically.

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Click the **Install CachedGPT userscript** link above.
3. Approve the installation in your userscript manager.
4. Reload `https://chatgpt.com/`.

Direct install URL:

```text
https://raw.githubusercontent.com/HiSkyZen/CachedGPT/main/cachedgpt.user.js
```

## Features

- **Sidebar caching**: caches recent conversations, project conversation lists, the project sidebar, and pinned items for 30 seconds by default.
- **Refresh after changes**: successful conversation, project, and pin mutations mark cached lists stale while retaining them for fallback.
- **Request deduplication**: concurrent requests for the same URL share one network operation.
- **Request serialization**: protected API requests are spaced apart instead of being fired in a burst.
- **429 backoff**: honors `Retry-After` when present and otherwise applies exponential backoff.
- **Stale-cache fallback**: on 429 or network failure, the last successful cached response can be returned to the ChatGPT UI.
- **Persistent IndexedDB cache**: keeps successful list responses up to 128 MiB and evicts the oldest entries when full. Older conversation-detail cache entries are removed.
- **Non-blocking rate-limit notice**: replaces the intrusive conversation-access warning modal/alert with a small status indicator.
- **Automatic userscript updates**: `@updateURL` and `@downloadURL` point to the latest script on GitHub.

## Default configuration

Edit the `CFG` object near the top of the userscript.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `LIST_FRESH_MS` | `30000` | Conversation-list cache TTL |
| `MIN_NETWORK_GAP_MS` | `500` | Minimum delay between protected requests |
| `INITIAL_BACKOFF_MS` | `15000` | Initial 429 backoff |
| `MAX_BACKOFF_MS` | `120000` | Maximum backoff |
| `CACHE_MAX_BYTES` | 128 MiB | Maximum IndexedDB cache size |
| `SHOW_STATUS` | `true` | Show the quiet bottom-right status indicator |

For completely silent operation:

```js
SHOW_STATUS: false,
```

## How it works

If the ChatGPT client fires four identical conversation-list requests at once, CachedGPT merges them into one network request.

```text
4 identical requests
        ↓
     dedupe
        ↓
1 network request
        ↓
IndexedDB cache
```

While a cached response is fresh, CachedGPT serves it without touching the server. Once the fresh TTL expires, it attempts the network request again. On a 429, it returns the last successful cached response where available. During the cooldown, it serves stored lists of the affected kind immediately without sending another request. A 429 for task history therefore does not block ordinary conversation history. The status indicator shows the age of the cached response.

CachedGPT is not intended to bypass rate limits or increase request volume. Its purpose is the opposite: reduce unnecessary requests and respect server-provided `Retry-After` values and backoff periods.

## Limitations

- ChatGPT internal endpoints and DOM structures are not a public API and may change without notice.
- During stale-cache fallback, displayed data may be older than the latest server state.
- POST/PATCH/DELETE and other write requests pass through to the server; their response bodies are not cached.
- Cached data is stored locally in the browser's IndexedDB.
- Requests without an account identifier in their headers are not cached. Each account has a separate cache namespace.
- A stored list can be old during fallback. A request that has never succeeded cannot be restored from cache.

## Privacy and security

CachedGPT does not send analytics or cached conversation data to an external server. Cached JSON responses remain in the current browser profile's IndexedDB. The userscript only matches `https://chatgpt.com/*`.

Avoid using persistent conversation caching on shared computers, or clear ChatGPT site data afterward.

## Updates

Tampermonkey and Violentmonkey can use the metadata block to check for updates automatically. You can also reopen the direct install link to install the latest version manually.

## License

MIT License. See [`LICENSE`](./LICENSE).
