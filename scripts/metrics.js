/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// Shared metrics panel for api-showcase variants (CLAUDE.md "The block: api-showcase").
// Two data sources, both requiring the edge function's response headers
// (docs/api-contract.md "Common response rules"):
//   - performance.getEntriesByType('resource'), which only carries cross-origin byte/timing
//     detail because the function sets `Timing-Allow-Origin: *`.
//   - the response headers it exposes via `Access-Control-Expose-Headers`.
// The panel is built up front with every row it can ever show, filled with placeholders —
// record() only ever replaces text content, so rendering data never changes its height.

/** Headers the edge function exposes cross-origin (docs/api-contract.md). */
const EXPOSED_HEADERS = [
  'Server-Timing',
  'X-Pattern',
  'X-Fallback',
  'X-Original-Bytes',
  'X-Transformed-Bytes',
  'X-Fetched-At',
  'X-Backend-Age',
  'X-Cache-Mode',
  'Age',
];

const PLACEHOLDER = '—';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return PLACEHOLDER;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatMs(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms)} ms` : PLACEHOLDER;
}

/** `tmdb;dur=142, edge;dur=151` -> [{ name: 'tmdb', ms: 142 }, { name: 'edge', ms: 151 }] */
function parseServerTiming(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(';');
      const name = parts[0].trim();
      const durPart = parts.find((p) => p.trim().startsWith('dur='));
      const ms = durPart ? Number(durPart.trim().slice(4)) : null;
      return name ? { name, ms } : null;
    })
    .filter(Boolean);
}

/** Most recent Resource Timing entry for `url` started at or after `sinceTs`. */
function latestResourceEntry(url, sinceTs) {
  const entries = window.performance
    .getEntriesByType('resource')
    .filter((e) => e.name === url && e.startTime >= sinceTs);
  return entries[entries.length - 1] || null;
}

function buildRow(label) {
  const row = document.createElement('tr');
  const th = document.createElement('th');
  th.scope = 'row';
  th.textContent = label;
  const td = document.createElement('td');
  td.textContent = PLACEHOLDER;
  row.append(th, td);
  return row;
}

function buildStat(label) {
  const stat = document.createElement('div');
  stat.className = 'api-metrics-stat';
  const dt = document.createElement('span');
  dt.className = 'api-metrics-stat-label';
  dt.textContent = label;
  const dd = document.createElement('span');
  dd.className = 'api-metrics-stat-value';
  dd.textContent = PLACEHOLDER;
  stat.append(dt, dd);
  return { stat, valueEl: dd };
}

/**
 * Builds a metrics panel for one api-showcase variant instance.
 * @param {string} apiOrigin Origin the panel measures requests against (label only).
 * @param {string[]} [timingLabels] Known `Server-Timing` entry names for this route, in
 *   order (e.g. `['tmdb', 'edge']`), so those rows can be pre-rendered and reserve height.
 *   Extra entries the response actually carries beyond this list are appended live.
 * @returns {{ element: HTMLElement, record: (resp: Response, sinceTs: number) => void,
 *   onRunAgain: (cb: () => void) => void }}
 */
export function createMetricsPanel(apiOrigin, { timingLabels = [] } = {}) {
  let requestCount = 0;

  const element = document.createElement('div');
  element.className = 'api-metrics';

  const caption = document.createElement('p');
  caption.className = 'api-metrics-caption';
  caption.textContent = `Metrics — requests to ${apiOrigin}`;
  element.append(caption);

  const summary = document.createElement('div');
  summary.className = 'api-metrics-summary';
  const count = buildStat('Requests');
  const transfer = buildStat('Transfer size');
  const ttfb = buildStat('TTFB');
  const duration = buildStat('Duration');
  count.valueEl.textContent = '0';
  summary.append(count.stat, transfer.stat, ttfb.stat, duration.stat);
  element.append(summary);

  const headersTable = document.createElement('table');
  headersTable.className = 'api-metrics-headers';
  headersTable.setAttribute('aria-label', 'Response headers');
  const headersBody = document.createElement('tbody');
  const headerRows = new Map(EXPOSED_HEADERS.map((name) => [name, buildRow(name)]));
  headerRows.forEach((row) => headersBody.append(row));
  headersTable.append(headersBody);
  element.append(headersTable);

  const timingTable = document.createElement('table');
  timingTable.className = 'api-metrics-timing';
  timingTable.setAttribute('aria-label', 'Server timing');
  const timingBody = document.createElement('tbody');
  const timingRows = new Map(timingLabels.map((name) => [name, buildRow(name)]));
  timingRows.forEach((row) => timingBody.append(row));
  timingTable.append(timingBody);
  element.append(timingTable);

  const rerun = document.createElement('button');
  rerun.type = 'button';
  rerun.className = 'api-metrics-rerun';
  rerun.textContent = 'Run again';
  const actions = document.createElement('div');
  actions.className = 'api-metrics-actions';
  actions.append(rerun);
  element.append(actions);

  /**
   * Updates the panel from a completed fetch. `sinceTs` (a `performance.now()` timestamp
   * taken right before the fetch) picks out the matching Resource Timing entry, so a
   * repeated "Run again" call against the same URL doesn't re-read a stale one.
   */
  function record(response, sinceTs) {
    requestCount += 1;
    count.valueEl.textContent = String(requestCount);

    const entry = latestResourceEntry(response.url, sinceTs);
    transfer.valueEl.textContent = entry ? formatBytes(entry.transferSize) : PLACEHOLDER;
    ttfb.valueEl.textContent = entry
      ? formatMs(entry.responseStart - entry.requestStart)
      : PLACEHOLDER;
    duration.valueEl.textContent = entry
      ? formatMs(entry.responseEnd - entry.startTime)
      : PLACEHOLDER;

    EXPOSED_HEADERS.forEach((name) => {
      const value = response.headers.get(name);
      headerRows.get(name).lastElementChild.textContent = value ?? PLACEHOLDER;
    });

    const seen = new Set();
    parseServerTiming(response.headers.get('Server-Timing')).forEach(({ name, ms }) => {
      seen.add(name);
      let row = timingRows.get(name);
      if (!row) {
        row = buildRow(name);
        timingRows.set(name, row);
        timingBody.append(row);
      }
      row.lastElementChild.textContent = formatMs(ms);
    });
    // Entries this response didn't carry (e.g. a backend that timed out) fall back to the
    // placeholder rather than showing a stale ms value from a previous run.
    timingRows.forEach((row, name) => {
      if (!seen.has(name)) row.lastElementChild.textContent = PLACEHOLDER;
    });
  }

  function onRunAgain(callback) {
    rerun.addEventListener('click', callback);
  }

  /** Adds a variant-specific control (e.g. a checkbox) next to the "Run again" button. */
  function addControl(node) {
    actions.append(node);
  }

  return {
    element, record, onRunAgain, addControl,
  };
}

export {
  EXPOSED_HEADERS, parseServerTiming, formatBytes, formatMs,
};
