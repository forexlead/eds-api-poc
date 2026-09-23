#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-console, no-await-in-loop, import/no-extraneous-dependencies */

// Evidence pack for the eds-api-poc (CLAUDE.md "Evidence tooling"; docs/api-contract.md).
//
//   Part A — pattern pages: 1 cold + WARM_LOADS warm loads each, HAR + screenshot per page,
//            API-origin request metrics and exposed response headers.
//   Part B — credential check: every HAR (URLs, request/response headers, bodies) is searched for
//            the TMDB token and for "Bearer". Must be 0; the run exits non-zero otherwise.
//   Part C — API timings: direct fetches per route, warm (as served) vs fresh=1, p50/p95 TTFB.
//
// Env: SITE_URL, API_BASE, TMDB_TOKEN (falls back to ../eds-api-poc-edge/.env). The token is only
// ever used as a search needle — it is never printed or written to the outputs.
//
// Usage: node tools/evidence/run.mjs   → evidence/{results.json,summary.md,screenshots/,har/}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'evidence');
const SHOTS = join(OUT, 'screenshots');
const HARS = join(OUT, 'har');

const SITE_URL = (process.env.SITE_URL || 'https://main--eds-api-poc--forexlead.aem.live').replace(/\/+$/, '');
const API_BASE = (process.env.API_BASE || 'https://publish-p24773-e1511008.adobeaemcloud.com').replace(/\/+$/, '');

const PAGES = ['/patterns/proxy', '/patterns/aggregate', '/patterns/transform', '/patterns/failover'];
const WARM_LOADS = 5;
const API_ROUTES = ['/api/health', '/api/movie?id=603', '/api/movies?q=matrix', '/api/dashboard', '/api/lite?id=25'];
const API_RUNS = 20;
const HEADERS = ['server-timing', 'x-pattern', 'x-cache-mode', 'x-fallback', 'x-original-bytes', 'x-transformed-bytes', 'age'];
/** Time given to a block's async API calls after the page's own load settles. */
const SETTLE_MS = 1500;

/* ---------- helpers ---------- */

async function loadToken() {
  if (process.env.TMDB_TOKEN) return process.env.TMDB_TOKEN.trim();
  const envFile = resolve(ROOT, '../eds-api-poc-edge/.env');
  if (!existsSync(envFile)) return '';
  const line = (await readFile(envFile, 'utf8')).split('\n').find((l) => /^\s*TMDB_TOKEN\s*=/.test(l));
  return line ? line.replace(/^\s*TMDB_TOKEN\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

/** Nearest-rank percentile. */
function pct(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const kb = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1024).toFixed(1)} KB` : '—');
const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '—');
const cell = (v) => (v == null || v === '' ? '—' : String(v).replace(/\|/g, '\\|'));
const slug = (path) => path.replace(/^\/+/, '').replace(/[^a-z0-9]+/gi, '-');

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

function withParams(route, params) {
  const url = new URL(route, API_BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

/* ---------- Part A: pattern pages ---------- */

/**
 * Loads the page once and returns the API-origin requests it made. Resource Timing is readable
 * cross-origin because the function sends `Timing-Allow-Origin: *`; headers come from Playwright.
 */
async function measureLoad(page, url, doLoad) {
  const headersByUrl = new Map();
  const onResponse = async (resp) => {
    if (!resp.url().startsWith(API_BASE)) return;
    try {
      headersByUrl.set(resp.url(), await resp.allHeaders());
    } catch {
      // response went away (navigation); timing entry still covers it
    }
  };
  page.on('response', onResponse);

  const start = Date.now();
  const resp = await doLoad(url);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  page.off('response', onResponse);

  const entries = await page.evaluate((origin) => performance.getEntriesByType('resource')
    .filter((e) => e.name.startsWith(origin))
    .map((e) => ({
      url: e.name,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize,
      ttfb: e.responseStart - e.requestStart,
      duration: e.responseEnd - e.startTime,
    })), API_BASE);

  const requests = entries.map((e) => {
    const h = headersByUrl.get(e.url) || {};
    return { ...e, headers: Object.fromEntries(HEADERS.map((k) => [k, h[k] ?? null])) };
  });

  return {
    status: resp?.status() ?? null,
    wallMs: Date.now() - start,
    apiRequests: requests.length,
    transferSize: requests.reduce((s, r) => s + (r.transferSize || 0), 0),
    encodedBodySize: requests.reduce((s, r) => s + (r.encodedBodySize || 0), 0),
    decodedBodySize: requests.reduce((s, r) => s + (r.decodedBodySize || 0), 0),
    ttfb: pct(requests.map((r) => r.ttfb), 50),
    duration: pct(requests.map((r) => r.duration), 50),
    requests,
  };
}

async function runPage(browser, path) {
  const url = `${SITE_URL}${path}`;
  const probe = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (probe.status === 404) {
    console.log(`  ${path}: 404, skipped`);
    return {
      path, url, skipped: true, reason: 'HTTP 404',
    };
  }

  const harPath = join(HARS, `${slug(path)}.har`);
  // Fresh context = empty HTTP cache, so the first load is genuinely cold.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordHar: { path: harPath, content: 'embed' },
  });
  const page = await context.newPage();

  const cold = await measureLoad(page, url, (u) => page.goto(u, { waitUntil: 'load' }));
  console.log(`  ${path}: cold — ${cold.apiRequests} API req, TTFB ${ms(cold.ttfb)}`);
  await page.screenshot({ path: join(SHOTS, `${slug(path)}.png`), fullPage: true });

  const warm = [];
  for (let i = 0; i < WARM_LOADS; i += 1) {
    warm.push(await measureLoad(page, url, () => page.reload({ waitUntil: 'load' })));
  }
  const warmTtfbs = warm.flatMap((w) => w.requests.map((r) => r.ttfb));
  console.log(`  ${path}: warm ×${WARM_LOADS} — TTFB p50 ${ms(pct(warmTtfbs, 50))}`);

  await context.close(); // flushes the HAR
  return {
    path,
    url,
    skipped: false,
    har: harPath.slice(ROOT.length + 1),
    screenshot: join(SHOTS, `${slug(path)}.png`).slice(ROOT.length + 1),
    cold,
    warm,
    warmSummary: {
      apiRequestsPerLoad: pct(warm.map((w) => w.apiRequests), 50),
      decodedBodySizePerLoad: pct(warm.map((w) => w.decodedBodySize), 50),
      ttfbP50: pct(warmTtfbs, 50),
      ttfbP95: pct(warmTtfbs, 95),
      durationP50: pct(warm.flatMap((w) => w.requests.map((r) => r.duration)), 50),
    },
  };
}

/* ---------- Part B: credential check ---------- */

async function scanHar(file, token) {
  const har = JSON.parse(await readFile(join(ROOT, file), 'utf8'));
  const hits = { token: 0, bearer: 0, where: [] };
  const check = (text, where) => {
    const t = countOccurrences(text, token);
    const b = countOccurrences(text, 'Bearer');
    if (t || b) hits.where.push({ where, token: t, bearer: b });
    hits.token += t;
    hits.bearer += b;
  };
  const headerText = (list) => (list || []).map((h) => `${h.name}: ${h.value}`).join('\n');

  har.log.entries.forEach(({ request, response }, i) => {
    const at = `${file}#${i} ${request.url}`;
    check(request.url, `${at} request.url`);
    check(headerText(request.headers), `${at} request.headers`);
    check(request.postData?.text, `${at} request.body`);
    check(headerText(response.headers), `${at} response.headers`);
    const { text, encoding } = response.content || {};
    const body = text && encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text;
    check(body, `${at} response.body`);
  });
  return { file, entries: har.log.entries.length, ...hits };
}

/* ---------- Part C: API timings ---------- */

/** TTFB = request start → response headers received (fetch resolves on headers). */
async function timeFetch(url) {
  const start = performance.now();
  const resp = await fetch(url); // Node fetch has no HTTP cache, so every call reaches the edge
  const ttfb = performance.now() - start;
  await resp.arrayBuffer(); // drain so the connection is reused
  const headers = Object.fromEntries(HEADERS.map((k) => [k, resp.headers.get(k)]));
  return { ttfb, status: resp.status, headers };
}

async function runApiRoute(route) {
  const modes = {};
  // warm: exactly as served (CDN + fetch cache in play).
  // fresh: fresh=1 skips the function's backend fetch cache; a unique cb makes every request
  // miss the CDN's cached response too, otherwise fresh=1 itself would be CDN-cached after the
  // first call and only 1 of 20 runs would be fresh.
  const modeUrls = {
    warm: () => withParams(route, {}),
    fresh: (i) => withParams(route, { fresh: '1', cb: `${Date.now()}-${i}` }),
  };
  // Throwaway warm-up so connection setup (DNS/TLS) isn't billed to the first measured run.
  await timeFetch(withParams(route, {}));

  const modeNames = Object.keys(modeUrls);
  for (let m = 0; m < modeNames.length; m += 1) {
    const mode = modeNames[m];
    const urlFor = modeUrls[mode];
    const runs = [];
    for (let i = 0; i < API_RUNS; i += 1) runs.push(await timeFetch(urlFor(i)));
    const last = runs[runs.length - 1];
    modes[mode] = {
      runs: runs.map((r) => ({ ttfb: round(r.ttfb), status: r.status, cacheMode: r.headers['x-cache-mode'] })),
      p50: round(pct(runs.map((r) => r.ttfb), 50)),
      p95: round(pct(runs.map((r) => r.ttfb), 95)),
      statuses: [...new Set(runs.map((r) => r.status))],
      lastServerTiming: last.headers['server-timing'],
      lastCacheMode: last.headers['x-cache-mode'],
    };
  }
  console.log(`  ${route}: warm p50 ${modes.warm.p50} ms · fresh p50 ${modes.fresh.p50} ms`);
  return { route, ...modes };
}

/** Backend (non-`edge`) entries of a Server-Timing header, e.g. [{ name: 'tmdb', dur: 12 }]. */
function backendTimings(header) {
  return (header || '').split(',').map((part) => {
    const [name, ...params] = part.trim().split(';');
    const dur = Number(params.map((x) => x.trim()).find((x) => x.startsWith('dur='))?.slice(4));
    return { name: name.trim(), dur };
  }).filter((t) => t.name && t.name !== 'edge' && Number.isFinite(t.dur));
}

/** This run's clearest replayed case: largest warm backend dur vs. that route's warm TTFB p50. */
function warmExample(api) {
  const best = api.flatMap((r) => backendTimings(r.warm.lastServerTiming)
    .map((t) => ({ route: r.route, ...t, ttfb: r.warm.p50 })))
    .filter((t) => t.dur > t.ttfb)
    .sort((a, b) => b.dur - a.dur)[0];
  return best
    ? ` In this run, \`${best.route}\` warm shows \`${best.name};dur=${best.dur}\` while its TTFB p50 was ${best.ttfb} ms: the ${best.dur} ms happened when the CDN copy was made.`
    : '';
}

/** This run's fastest fresh backend call. */
function freshExample(api) {
  const best = api.flatMap((r) => backendTimings(r.fresh.lastServerTiming)
    .map((t) => ({ route: r.route, ...t })))
    .sort((a, b) => a.dur - b.dur)[0];
  return best ? ` In this run: \`${best.name};dur=${best.dur}\` on fresh \`${best.route}\`.` : '';
}

/* ---------- summary.md ---------- */

function renderSummary(results) {
  const { pages, credentialCheck: cc, api } = results;
  const out = [];
  out.push('# eds-api-poc — evidence pack', '');
  out.push(`- Run: ${results.generatedAt}`);
  out.push(`- Site: ${results.config.siteUrl}`);
  out.push(`- API: ${results.config.apiBase}`);
  out.push(`- Pages: 1 cold + ${WARM_LOADS} warm loads each · API: ${API_RUNS} fetches per mode per route`);
  out.push('- Sizes are decoded (uncompressed) body bytes from Resource Timing; wire bytes are in results.json.', '');

  out.push('## Pattern pages (requests to API origin)', '');
  out.push('| Page | Load | API requests | Decoded size | Wire (transfer) | TTFB | Duration |');
  out.push('|---|---|---|---|---|---|---|');
  pages.forEach((p) => {
    if (p.skipped) {
      out.push(`| ${p.path} | skipped (${p.reason}) | | | | | |`);
      return;
    }
    const w = p.warmSummary;
    out.push(`| ${p.path} | cold | ${p.cold.apiRequests} | ${kb(p.cold.decodedBodySize)} | ${kb(p.cold.transferSize)} | ${ms(p.cold.ttfb)} | ${ms(p.cold.duration)} |`);
    out.push(`| | warm p50 (×${WARM_LOADS}) | ${w.apiRequestsPerLoad} | ${kb(w.decodedBodySizePerLoad)} | ${kb(pct(p.warm.map((x) => x.transferSize), 50))} | ${ms(w.ttfbP50)} (p95 ${ms(w.ttfbP95)}) | ${ms(w.durationP50)} |`);
  });
  out.push('');

  out.push('### Response headers (cold load, first API request)', '');
  out.push(`| Page | ${HEADERS.join(' | ')} |`);
  out.push(`|---|${HEADERS.map(() => '---').join('|')}|`);
  pages.filter((p) => !p.skipped).forEach((p) => {
    const h = p.cold.requests[0]?.headers || {};
    out.push(`| ${p.path} | ${HEADERS.map((k) => cell(h[k])).join(' | ')} |`);
  });
  out.push('');

  out.push('## Credential check', '');
  out.push(`Searched ${cc.harFiles.length} HAR files (${cc.entries} entries): request URLs, request headers, request bodies, response headers and response bodies.`, '');
  out.push('| Needle | Hits |', '|---|---|');
  out.push(`| TMDB token | ${cc.tokenHits} |`);
  out.push(`| \`Bearer\` | ${cc.bearerHits} |`);
  out.push('', `**Result: ${cc.pass ? 'PASS — 0 hits' : 'FAIL'}**`, '');
  if (!cc.pass) {
    out.push('Hits:', '');
    cc.hits.forEach((h) => out.push(`- ${h.where} (token ${h.token}, Bearer ${h.bearer})`));
    out.push('');
  }

  out.push('## API timings — warm (as served) vs fresh (`fresh=1`)', '');
  out.push(`TTFB measured from Node \`fetch\` (request start → headers), ${API_RUNS} sequential requests per mode, after one unmeasured warm-up request per route (so the TLS handshake isn't counted). Fresh requests also carry a unique \`cb\` so the CDN can't serve a cached \`fresh=1\` response.`, '');
  out.push('| Route | Warm p50 | Warm p95 | Fresh p50 | Fresh p95 | X-Cache-Mode (warm / fresh) |');
  out.push('|---|---|---|---|---|---|');
  api.forEach((r) => {
    out.push(`| \`${r.route}\` | ${ms(r.warm.p50)} | ${ms(r.warm.p95)} | ${ms(r.fresh.p50)} | ${ms(r.fresh.p95)} | ${cell(r.warm.lastCacheMode)} / ${cell(r.fresh.lastCacheMode)} |`);
  });
  out.push('', '### Server-Timing (last response per mode)', '');
  out.push('| Route | Warm | Fresh |', '|---|---|---|');
  api.forEach((r) => out.push(`| \`${r.route}\` | ${cell(r.warm.lastServerTiming)} | ${cell(r.fresh.lastServerTiming)} |`));
  out.push('', 'How to read these:', '');
  out.push(`- **Warm Server-Timing is replayed, not measured now.** A warm response comes from the CDN, which stored it together with the Server-Timing header from the request that originally populated it.${warmExample(api)}`);
  out.push(`- **Low fresh backend timings reflect the backend's own CDN.** \`fresh=1\` bypasses our caches only (the Adobe CDN and the function's fetch cache). The upstream APIs sit behind their own CDNs, so a fresh call can still be fast when the upstream serves it from its edge.${freshExample(api)}`);
  out.push('');
  return out.join('\n');
}

/* ---------- main ---------- */

async function main() {
  const token = await loadToken();
  if (!token) {
    // Without the token the credential check can't prove anything — refuse rather than report 0.
    console.error('✖ TMDB_TOKEN not set and not found in ../eds-api-poc-edge/.env — cannot run the credential check.');
    process.exit(2);
  }
  await mkdir(SHOTS, { recursive: true });
  await mkdir(HARS, { recursive: true });

  console.log(`Part A — pages on ${SITE_URL}`);
  const browser = await chromium.launch();
  const pages = [];
  try {
    for (let i = 0; i < PAGES.length; i += 1) pages.push(await runPage(browser, PAGES[i]));
  } finally {
    await browser.close();
  }

  console.log('Part B — credential check');
  const scans = [];
  const scanned = pages.filter((x) => !x.skipped);
  for (let i = 0; i < scanned.length; i += 1) scans.push(await scanHar(scanned[i].har, token));
  const credentialCheck = {
    harFiles: scans.map((s) => s.file),
    entries: scans.reduce((s, x) => s + x.entries, 0),
    tokenHits: scans.reduce((s, x) => s + x.token, 0),
    bearerHits: scans.reduce((s, x) => s + x.bearer, 0),
    // locations only — never the matched text
    hits: scans.flatMap((s) => s.where),
  };
  credentialCheck.pass = credentialCheck.tokenHits === 0 && credentialCheck.bearerHits === 0;
  console.log(`  token hits ${credentialCheck.tokenHits} · Bearer hits ${credentialCheck.bearerHits}`);

  console.log(`Part C — API timings on ${API_BASE}`);
  const api = [];
  for (let i = 0; i < API_ROUTES.length; i += 1) api.push(await runApiRoute(API_ROUTES[i]));

  const results = {
    generatedAt: new Date().toISOString(),
    config: {
      siteUrl: SITE_URL, apiBase: API_BASE, warmLoads: WARM_LOADS, apiRuns: API_RUNS,
    },
    pages,
    credentialCheck,
    api,
  };
  await writeFile(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(join(OUT, 'summary.md'), renderSummary(results));
  console.log('Wrote evidence/results.json, evidence/summary.md, evidence/screenshots/, evidence/har/');

  if (!credentialCheck.pass) {
    console.error('\n✖✖✖ CREDENTIAL CHECK FAILED ✖✖✖');
    console.error(`TMDB token hits: ${credentialCheck.tokenHits} · "Bearer" hits: ${credentialCheck.bearerHits}`);
    credentialCheck.hits.forEach((h) => console.error(`  - ${h.where}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
