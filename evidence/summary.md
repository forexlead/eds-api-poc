# eds-api-poc — evidence pack

- Run: 2026-09-23T14:24:49.289Z
- Site: https://main--eds-api-poc--forexlead.aem.live
- API: https://publish-p24773-e1511008.adobeaemcloud.com
- Pages: 1 cold + 5 warm loads each · API: 20 fetches per mode per route
- Sizes are decoded (uncompressed) body bytes from Resource Timing; wire bytes are in results.json.

## Pattern pages (requests to API origin)

| Page | Load | API requests | Decoded size | Wire (transfer) | TTFB | Duration |
|---|---|---|---|---|---|---|
| /patterns/proxy | cold | 1 | 1.4 KB | 1.7 KB | 290 ms | 364 ms |
| | warm p50 (×5) | 1 | 1.4 KB | 1.7 KB | 15 ms (p95 17 ms) | 16 ms |
| /patterns/aggregate | cold | 1 | 0.9 KB | 1.2 KB | 17 ms | 55 ms |
| | warm p50 (×5) | 1 | 0.9 KB | 1.2 KB | 16 ms (p95 18 ms) | 17 ms |
| /patterns/transform | cold | 1 | 0.2 KB | 0.5 KB | 16 ms | 57 ms |
| | warm p50 (×5) | 1 | 0.2 KB | 0.5 KB | 16 ms (p95 18 ms) | 17 ms |
| /patterns/failover | cold | 1 | 0.1 KB | 0.4 KB | 322 ms | 365 ms |
| | warm p50 (×5) | 1 | 0.1 KB | 0.4 KB | 23 ms (p95 280 ms) | 24 ms |

### Response headers (cold load, first API request)

| Page | server-timing | x-pattern | x-cache-mode | x-fallback | x-original-bytes | x-transformed-bytes | age |
|---|---|---|---|---|---|---|---|
| /patterns/proxy | tmdb;dur=9, edge;dur=11 | proxy | cached | — | — | — | 29 |
| /patterns/aggregate | tmdb;dur=19, weather;dur=442, pokemon;dur=22, edge;dur=451 | aggregate | cached | — | — | — | 113 |
| /patterns/transform | pokemon;dur=29, edge;dur=42 | transform | cached | — | 290912 | 214 | 113 |
| /patterns/failover | upstream;dur=49, edge;dur=49 | failover | — | none | — | — | — |

## Credential check

Searched 4 HAR files (678 entries): request URLs, request headers, request bodies, response headers and response bodies.

| Needle | Hits |
|---|---|
| TMDB token | 0 |
| `Bearer` | 0 |

**Result: PASS — 0 hits**

## API timings — warm (as served) vs fresh (`fresh=1`)

TTFB measured from Node `fetch` (request start → headers), 20 sequential requests per mode, after one unmeasured warm-up request per route (so the TLS handshake isn't counted). Fresh requests also carry a unique `cb` so the CDN can't serve a cached `fresh=1` response.

| Route | Warm p50 | Warm p95 | Fresh p50 | Fresh p95 | X-Cache-Mode (warm / fresh) |
|---|---|---|---|---|---|
| `/api/health` | 24 ms | 58 ms | 21 ms | 52 ms | — / — |
| `/api/movie?id=603` | 16 ms | 19 ms | 85 ms | 462 ms | cached / fresh |
| `/api/movies?q=matrix` | 16 ms | 26 ms | 105 ms | 343 ms | cached / fresh |
| `/api/dashboard` | 17 ms | 23 ms | 535 ms | 829 ms | cached / fresh |
| `/api/lite?id=25` | 16 ms | 29 ms | 127 ms | 383 ms | cached / fresh |

### Server-Timing (last response per mode)

| Route | Warm | Fresh |
|---|---|---|
| `/api/health` | edge;dur=0 | edge;dur=1 |
| `/api/movie?id=603` | tmdb;dur=6, edge;dur=8 | tmdb;dur=3, edge;dur=3 |
| `/api/movies?q=matrix` | tmdb;dur=10, edge;dur=12 | tmdb;dur=3, edge;dur=5 |
| `/api/dashboard` | tmdb;dur=7, weather;dur=438, pokemon;dur=22, edge;dur=449 | tmdb;dur=10, weather;dur=453, pokemon;dur=60, edge;dur=463 |
| `/api/lite?id=25` | pokemon;dur=17, edge;dur=28 | pokemon;dur=101, edge;dur=110 |

How to read these:

- **Warm Server-Timing is replayed, not measured now.** A warm response comes from the CDN, which stored it together with the Server-Timing header from the request that originally populated it. In this run, `/api/dashboard` warm shows `weather;dur=438` while its TTFB p50 was 17 ms: the 438 ms happened when the CDN copy was made.
- **Low fresh backend timings reflect the backend's own CDN.** `fresh=1` bypasses our caches only (the Adobe CDN and the function's fetch cache). The upstream APIs sit behind their own CDNs, so a fresh call can still be fast when the upstream serves it from its edge. In this run: `tmdb;dur=3` on fresh `/api/movie?id=603`.
