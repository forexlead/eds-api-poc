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

// api-showcase — demonstrates the `api-poc` edge function's four integration patterns
// (CLAUDE.md "The block: api-showcase"; contract in docs/api-contract.md).
// Authored as a key/value table: `API Showcase (<variant>)` header, then `endpoint`/`title`
// rows read with readBlockConfig().

import { readBlockConfig } from '../../scripts/aem.js';
import { getApiBase } from '../../scripts/api-config.js';
import {
  createMetricsPanel, formatBytes, formatMs, parseServerTiming,
} from '../../scripts/metrics.js';

const VARIANTS = ['proxy', 'aggregate', 'transform', 'failover', 'cache-lab'];
const DEFAULT_QUERY = 'matrix';

function variantOf(block) {
  return VARIANTS.find((v) => block.classList.contains(v)) || 'proxy';
}

/** `/api/movies?q=matrix` -> URLSearchParams { q: 'matrix' }; empty when absent/unparsable. */
function paramsFromEndpoint(endpoint) {
  if (!endpoint) return new URLSearchParams();
  try {
    return new URL(endpoint, window.location.origin).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** `/api/movies?q=matrix` -> `matrix`; falls back to DEFAULT_QUERY when absent/unparsable. */
function queryFromEndpoint(endpoint) {
  return paramsFromEndpoint(endpoint).get('q') || DEFAULT_QUERY;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildHeading(text) {
  return el('h3', null, text);
}

function buildStatus() {
  const status = el('p', 'api-showcase-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  return status;
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/**
 * Fetches JSON from the edge function. Resolves to `{ resp, data }` even on non-2xx so callers
 * can still record metrics; throws only when there's no response at all (network/CORS).
 */
async function fetchJson(url, fresh) {
  const resp = await fetch(url, fresh ? { cache: 'no-store' } : undefined);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    // non-JSON body: leave data null, callers treat it like any other failure
  }
  return { resp, data };
}

function buildResultCard(movie) {
  const li = document.createElement('li');
  li.className = 'api-showcase-result';

  if (movie.poster) {
    const img = document.createElement('img');
    img.src = movie.poster;
    img.alt = movie.title;
    img.width = 185;
    img.height = 278;
    img.loading = 'lazy';
    li.append(img);
  } else {
    const noPoster = document.createElement('div');
    noPoster.className = 'api-showcase-result-noposter';
    noPoster.setAttribute('aria-hidden', 'true');
    noPoster.textContent = 'No poster';
    li.append(noPoster);
  }

  const body = document.createElement('div');
  body.className = 'api-showcase-result-body';
  const title = document.createElement('p');
  title.className = 'api-showcase-result-title';
  title.textContent = movie.year ? `${movie.title} (${movie.year})` : movie.title;
  body.append(title);
  if (movie.rating != null) {
    const rating = document.createElement('p');
    rating.className = 'api-showcase-result-rating';
    rating.textContent = `★ ${movie.rating}`;
    body.append(rating);
  }
  li.append(body);

  return li;
}

/**
 * Wires up the Pattern 01 Secure Proxy variant: a search box against `/api/movies?q=`,
 * a results grid, the shared metrics panel, and a "0 credentials in the browser" badge.
 */
function decorateProxy(block, config) {
  const apiBase = getApiBase();
  const initialQuery = queryFromEndpoint(config.endpoint);

  block.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = config.title || 'Secure Proxy';
  block.append(heading);

  const badge = document.createElement('p');
  badge.className = 'api-showcase-badge';
  badge.textContent = 'Credentials in browser: 0';
  block.append(badge);

  const form = document.createElement('form');
  form.className = 'api-showcase-search';
  form.setAttribute('role', 'search');

  const label = document.createElement('label');
  const inputId = 'api-showcase-q';
  label.htmlFor = inputId;
  label.className = 'api-showcase-search-label';
  label.textContent = 'Search movies';

  const input = document.createElement('input');
  input.type = 'search';
  input.id = inputId;
  input.name = 'q';
  input.value = initialQuery;
  input.placeholder = 'Search movies…';
  input.required = true;
  input.minLength = 1;
  input.maxLength = 100;
  input.autocomplete = 'off';

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Search';

  form.append(label, input, submit);
  block.append(form);

  const status = document.createElement('p');
  status.className = 'api-showcase-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  block.append(status);

  const list = document.createElement('ul');
  list.className = 'api-showcase-results';
  list.setAttribute('role', 'list');
  block.append(list);

  const metrics = createMetricsPanel(apiBase, { timingLabels: ['tmdb', 'edge'] });
  block.append(metrics.element);

  async function search(query, { fresh = false } = {}) {
    const trimmed = query.trim();
    if (!trimmed) return;

    status.textContent = 'Loading…';
    list.setAttribute('aria-busy', 'true');

    const url = `${apiBase}/api/movies?q=${encodeURIComponent(trimmed)}`;
    const startedAt = window.performance.now();

    try {
      const resp = await fetch(url, fresh ? { cache: 'no-store' } : undefined);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || `Request failed (${resp.status})`);

      list.innerHTML = '';
      if (data.results.length === 0) {
        status.textContent = `No results for "${trimmed}".`;
      } else {
        const count = data.results.length;
        status.textContent = `${count} result${count === 1 ? '' : 's'} for "${trimmed}".`;
        data.results.forEach((movie) => list.append(buildResultCard(movie)));
      }
      metrics.record(resp, startedAt);
    } catch (err) {
      status.textContent = `Could not load results: ${err.message}`;
      // eslint-disable-next-line no-console
      console.error('api-showcase proxy search failed', err);
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    search(input.value);
  });

  metrics.onRunAgain(() => search(input.value, { fresh: true }));

  // Fire the first search without awaiting it: the skeleton above is already on the page,
  // so this must not block decoration/page rendering while the network call is pending.
  search(input.value);
}

/* ---------- aggregate (Pattern 02) ---------- */

/** Source keys in `/api/dashboard` `sources`, in display order (docs/api-contract.md). */
const AGGREGATE_SOURCES = [
  { key: 'tmdb', label: 'TMDB trending' },
  { key: 'weather', label: 'Weather' },
  { key: 'pokemon', label: 'Pokémon' },
];

/** WMO weather codes (Open-Meteo `weather_code`) -> short description. */
const WEATHER_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
};

function renderTmdbSource(body, data) {
  const list = el('ol', 'api-showcase-trending');
  data.slice(0, 5).forEach((movie) => {
    const li = el('li');
    if (movie.poster) {
      const img = el('img');
      img.src = movie.poster;
      img.alt = '';
      img.width = 32;
      img.height = 48;
      img.loading = 'lazy';
      li.append(img);
    }
    li.append(el('span', null, movie.title));
    list.append(li);
  });
  body.append(list);
}

function renderWeatherSource(body, data) {
  const temp = Number.isFinite(data.tempC) ? `${Math.round(data.tempC)} °C` : '—';
  body.append(el('p', 'api-showcase-source-figure', temp));
  body.append(el('p', null, WEATHER_CODES[data.code] || `Weather code ${data.code ?? '—'}`));
  if (Number.isFinite(data.windKph)) body.append(el('p', null, `Wind ${data.windKph} km/h`));
}

// The contract leaves `sources.pokemon.data` unspecified; render the /api/lite field names
// (name, id, sprite, types) when present and degrade to whatever is there.
function renderPokemonSource(body, data) {
  if (data.sprite) {
    const img = el('img', 'api-showcase-sprite');
    img.src = data.sprite;
    img.alt = data.name || '';
    img.width = 96;
    img.height = 96;
    img.loading = 'lazy';
    body.append(img);
  }
  const name = capitalize(data.name) || 'Unknown';
  body.append(el('p', 'api-showcase-source-figure', data.id ? `${name} #${data.id}` : name));
  if (Array.isArray(data.types) && data.types.length) body.append(el('p', null, data.types.join(' · ')));
}

const SOURCE_RENDERERS = {
  tmdb: renderTmdbSource,
  weather: renderWeatherSource,
  pokemon: renderPokemonSource,
};

function buildSourceCard({ label }) {
  const card = el('li', 'api-showcase-source');
  const header = el('div', 'api-showcase-source-header');
  header.append(el('h4', null, label));
  const pill = el('span', 'api-showcase-source-status', 'loading');
  header.append(pill);
  const body = el('div', 'api-showcase-source-body');
  card.append(header, body);
  return { card, pill, body };
}

/**
 * Fills one source card. Anything other than a usable `status: "ok"` payload renders the
 * neutral "unavailable" state — a failed backend is expected behaviour here, not an error.
 */
function fillSourceCard(ui, key, source) {
  const { card, pill, body } = ui;
  body.innerHTML = '';
  const ok = source?.status === 'ok' && source.data != null;
  const ms = Number.isFinite(source?.ms) ? ` · ${formatMs(source.ms)}` : '';

  card.classList.toggle('unavailable', !ok);
  pill.textContent = `${ok ? 'ok' : 'unavailable'}${ms}`;

  if (ok) {
    try {
      SOURCE_RENDERERS[key](body, source.data);
      return;
    } catch {
      // unexpected payload shape: fall through to the unavailable state
      card.classList.add('unavailable');
      pill.textContent = `unavailable${ms}`;
      body.innerHTML = '';
    }
  }
  body.append(el('p', 'api-showcase-source-unavailable', 'This source is unavailable right now; the other sources still rendered.'));
}

const HEADLINE_PARALLEL = '1 browser request instead of 3';
const HEADLINE_PARALLEL_DETAIL = 'Latency = slowest source, not the sum.';
const HEADLINE_CACHED = 'All sources served from edge cache — parallelism savings show on a cold fetch';
const HEADLINE_CACHED_DETAIL = 'Each source took only a few ms (see Server-Timing), so fixed edge overhead outweighs the parallel saving.';

/**
 * Wires up the Pattern 02 Aggregator variant: one call to `/api/dashboard` fans out to three
 * backends at the edge. Shows a card per source plus totalMs vs sumOfSourcesMs.
 */
function decorateAggregate(block, config) {
  const apiBase = getApiBase();
  const params = paramsFromEndpoint(config.endpoint);
  const query = ['lat', 'lon']
    .filter((k) => params.get(k))
    .map((k) => `${k}=${encodeURIComponent(params.get(k))}`)
    .join('&');
  const baseUrl = `${apiBase}/api/dashboard${query ? `?${query}` : ''}`;
  /**
   * `fresh=1` tells the function to skip its backend fetch cache (reported back as
   * `X-Cache-Mode: fresh`); the unique `cb` param also misses the CDN's cached response.
   */
  const buildUrl = (bypassCache) => (bypassCache
    ? `${baseUrl}${query ? '&' : '?'}fresh=1&cb=${Date.now()}`
    : baseUrl);

  block.innerHTML = '';
  block.append(buildHeading(config.title || 'Aggregator'));

  const headline = el('div', 'api-showcase-headline');
  const headlineMain = el('p', 'api-showcase-headline-main', HEADLINE_PARALLEL);
  const headlineDetail = el('p', 'api-showcase-headline-detail', HEADLINE_PARALLEL_DETAIL);
  const comparison = el('dl', 'api-showcase-comparison');
  const totalValue = el('dd', null, '—');
  const sumValue = el('dd', null, '—');
  comparison.append(
    el('dt', null, 'Edge total (parallel)'),
    totalValue,
    el('dt', null, 'Sum of sources (if sequential)'),
    sumValue,
  );
  headline.append(headlineMain, headlineDetail, comparison);
  block.append(headline);

  const status = buildStatus();
  block.append(status);

  const cardList = el('ul', 'api-showcase-sources');
  cardList.setAttribute('role', 'list');
  const cards = new Map(AGGREGATE_SOURCES.map((src) => {
    const ui = buildSourceCard(src);
    cardList.append(ui.card);
    return [src.key, ui];
  }));
  block.append(cardList);

  const metrics = createMetricsPanel(apiBase, { timingLabels: ['tmdb', 'weather', 'pokemon', 'edge'] });
  block.append(metrics.element);

  const forceFresh = el('label', 'api-metrics-toggle');
  const forceFreshInput = el('input');
  forceFreshInput.type = 'checkbox';
  forceFresh.append(forceFreshInput, ' Force fresh (bypass cache)');
  metrics.addControl(forceFresh);

  /**
   * On a warm edge every source is a fetch-cache hit, so the parallel total is dominated by
   * fixed edge overhead and can meet or exceed the (near-zero) sum — a "backwards" comparison.
   * Say so instead of claiming a saving; both numbers stay visible either way.
   */
  function setHeadline(totalMs, sumMs) {
    const allCached = Number.isFinite(totalMs) && Number.isFinite(sumMs) && totalMs >= sumMs;
    headlineMain.textContent = allCached ? HEADLINE_CACHED : HEADLINE_PARALLEL;
    headlineDetail.textContent = allCached ? HEADLINE_CACHED_DETAIL : HEADLINE_PARALLEL_DETAIL;
  }

  async function load({ fresh = false } = {}) {
    status.textContent = 'Loading…';
    cardList.setAttribute('aria-busy', 'true');
    const startedAt = window.performance.now();

    let resp = null;
    let data = null;
    try {
      ({ resp, data } = await fetchJson(buildUrl(forceFreshInput.checked), fresh));
      metrics.record(resp, startedAt);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('api-showcase aggregate: dashboard request failed', err);
    }

    const sources = resp?.ok && data?.sources ? data.sources : {};
    AGGREGATE_SOURCES.forEach(({ key }) => fillSourceCard(cards.get(key), key, sources[key]));

    if (resp?.ok && data) {
      totalValue.textContent = formatMs(data.totalMs);
      sumValue.textContent = formatMs(data.sumOfSourcesMs);
      setHeadline(data.totalMs, data.sumOfSourcesMs);
      const okCount = AGGREGATE_SOURCES.filter(({ key }) => sources[key]?.status === 'ok').length;
      const saved = data.sumOfSourcesMs - data.totalMs;
      status.textContent = `${okCount} of ${AGGREGATE_SOURCES.length} sources available`
        + `${Number.isFinite(saved) && saved > 0 ? ` · ${formatMs(saved)} saved by running them in parallel` : ''}.`;
    } else {
      totalValue.textContent = '—';
      sumValue.textContent = '—';
      setHeadline(NaN, NaN);
      status.textContent = `Dashboard unavailable right now${resp ? ` (HTTP ${resp.status})` : ''}.`;
    }
    cardList.removeAttribute('aria-busy');
  }

  metrics.onRunAgain(() => load({ fresh: true }));

  // Not awaited: the skeleton is already on the page; the fetch must not block rendering.
  load();
}

/* ---------- transform (Pattern 03) ---------- */

const DEFAULT_POKEMON_ID = 25;
const MAX_POKEMON_ID = 1025;
const POKEMON_PRESETS = [
  { id: 25, label: 'Pikachu' },
  { id: 6, label: 'Charizard' },
  { id: 150, label: 'Mewtwo' },
  { id: 143, label: 'Snorlax' },
  { id: 1025, label: 'Pecharunt' },
];
/** Stat bars are scaled against the highest possible base stat. */
const MAX_BASE_STAT = 255;

function clampPokemonId(value) {
  const id = Math.trunc(Number(value));
  return Number.isFinite(id) && id >= 1 && id <= MAX_POKEMON_ID ? id : null;
}

function renderPokemonCard(card, data) {
  card.innerHTML = '';

  const img = el('img', 'api-showcase-sprite');
  img.alt = data.name || '';
  img.width = 96;
  img.height = 96;
  if (data.sprite) img.src = data.sprite;
  card.append(img);

  const info = el('div', 'api-showcase-pokemon-info');
  const title = el('p', 'api-showcase-pokemon-name', capitalize(data.name));
  title.append(el('span', 'api-showcase-pokemon-id', ` #${data.id}`));
  info.append(title);

  const types = el('ul', 'api-showcase-types');
  (data.types || []).forEach((type) => types.append(el('li', `type-${type}`, type)));
  info.append(types);

  const stats = el('dl', 'api-showcase-stats');
  Object.entries(data.stats || {}).forEach(([name, value]) => {
    const bar = el('dd');
    const fill = el('span');
    fill.style.width = `${Math.min(100, (value / MAX_BASE_STAT) * 100)}%`;
    bar.append(fill, el('b', null, String(value)));
    stats.append(el('dt', null, name), bar);
  });
  info.append(stats);

  card.append(info);
}

/**
 * Wires up the Pattern 03 Transformer variant: `/api/lite?id=` returns a trimmed Pokémon
 * record; the edge reports raw vs transformed size in X-Original-Bytes / X-Transformed-Bytes.
 */
function decorateTransform(block, config) {
  const apiBase = getApiBase();
  const initialId = clampPokemonId(paramsFromEndpoint(config.endpoint).get('id'))
    || DEFAULT_POKEMON_ID;

  block.innerHTML = '';
  block.append(buildHeading(config.title || 'Transformer'));

  const savings = el('div', 'api-showcase-savings');
  const savingsFigure = el('p', 'api-showcase-savings-figure', 'raw — → —');
  const savingsNote = el('p', 'api-showcase-savings-note', 'PokeAPI response vs. what the edge sends to the browser');
  savings.append(savingsFigure, savingsNote);
  block.append(savings);

  const form = el('form', 'api-showcase-search api-showcase-picker');
  const label = el('label', 'api-showcase-search-label', 'Pokémon id (1–1025)');
  const inputId = 'api-showcase-id';
  label.htmlFor = inputId;
  const input = el('input');
  input.type = 'number';
  input.id = inputId;
  input.name = 'id';
  input.min = '1';
  input.max = String(MAX_POKEMON_ID);
  input.required = true;
  input.value = String(initialId);
  const submit = el('button', null, 'Load');
  submit.type = 'submit';
  form.append(label, input, submit);
  block.append(form);

  const presets = el('div', 'api-showcase-presets');
  POKEMON_PRESETS.forEach(({ id, label: name }) => {
    const btn = el('button', 'api-showcase-preset', `${name} #${id}`);
    btn.type = 'button';
    btn.dataset.id = String(id);
    presets.append(btn);
  });
  block.append(presets);

  const status = buildStatus();
  block.append(status);

  const card = el('div', 'api-showcase-pokemon');
  block.append(card);

  const metrics = createMetricsPanel(apiBase, { timingLabels: ['pokemon', 'edge'] });
  block.append(metrics.element);

  let currentId = initialId;

  async function load(id, { fresh = false } = {}) {
    currentId = id;
    input.value = String(id);
    status.textContent = 'Loading…';
    card.setAttribute('aria-busy', 'true');
    const startedAt = window.performance.now();

    try {
      const { resp, data } = await fetchJson(`${apiBase}/api/lite?id=${id}`, fresh);
      metrics.record(resp, startedAt);
      if (id !== currentId) return; // a newer request superseded this one
      if (!resp.ok || !data) throw new Error(data?.error?.message || `HTTP ${resp.status}`);

      const raw = Number(resp.headers.get('X-Original-Bytes'));
      const lite = Number(resp.headers.get('X-Transformed-Bytes'));
      const hasSizes = resp.headers.has('X-Original-Bytes') && resp.headers.has('X-Transformed-Bytes') && raw > 0;
      savingsFigure.textContent = hasSizes
        ? `raw ${formatBytes(raw)} → ${formatBytes(lite)} (${((1 - lite / raw) * 100).toFixed(1)}% smaller)`
        : 'raw — → — (size headers missing)';

      renderPokemonCard(card, data);
      status.textContent = `Loaded ${capitalize(data.name)} #${data.id}.`;
    } catch (err) {
      if (id !== currentId) return;
      savingsFigure.textContent = 'raw — → —';
      card.innerHTML = '';
      status.textContent = `Could not load Pokémon #${id}: ${err.message}`;
      // eslint-disable-next-line no-console
      console.error('api-showcase transform load failed', err);
    } finally {
      if (id === currentId) card.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = clampPokemonId(input.value);
    if (id) load(id);
  });

  presets.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-id]');
    if (btn) load(Number(btn.dataset.id));
  });

  metrics.onRunAgain(() => load(currentId, { fresh: true }));

  // Not awaited: the skeleton is already on the page; the fetch must not block rendering.
  load(initialId);
}

/* ---------- failover (Pattern 04) ---------- */

/** `/api/resilient?mode=` values (docs/api-contract.md), in button order. */
const FAILOVER_MODES = [
  { mode: 'ok', label: 'Normal' },
  { mode: 'fail', label: 'Backend down' },
  { mode: 'slow', label: 'Backend slow' },
];

function buildFailoverRow(list, term) {
  const value = el('dd', null, '—');
  list.append(el('dt', null, term), value);
  return value;
}

/**
 * Wires up the Pattern 04 Failover variant: Normal / Backend down / Backend slow buttons
 * against `/api/resilient?mode=`. The function always answers 200 — live data or its bundled
 * static snapshot — so every outcome renders as a normal card. A fallback is expected
 * behaviour: it gets a neutral badge and a small note, never an error state.
 */
function decorateFailover(block, config) {
  const apiBase = getApiBase();
  const endpointMode = paramsFromEndpoint(config.endpoint).get('mode');
  const initialMode = FAILOVER_MODES.some(({ mode }) => mode === endpointMode) ? endpointMode : 'ok';

  block.innerHTML = '';
  block.append(buildHeading(config.title || 'Failover'));

  const modes = el('div', 'api-showcase-presets api-showcase-modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'Backend scenario');
  const modeButtons = FAILOVER_MODES.map(({ mode, label }) => {
    const btn = el('button', 'api-showcase-preset', label);
    btn.type = 'button';
    btn.dataset.mode = mode;
    btn.setAttribute('aria-pressed', 'false');
    modes.append(btn);
    return btn;
  });
  block.append(modes);

  const status = buildStatus();
  block.append(status);

  const card = el('div', 'api-showcase-failover-card');
  const cardHeader = el('div', 'api-showcase-source-header');
  const cardTitle = el('h4', null, 'The Matrix');
  const badge = el('span', 'api-showcase-source-status', 'loading');
  cardHeader.append(cardTitle, badge);
  const facts = el('dl', 'api-showcase-comparison');
  const servedValue = buildFailoverRow(facts, 'Served');
  const fallbackValue = buildFailoverRow(facts, 'X-Fallback');
  const reasonValue = buildFailoverRow(facts, 'Reason');
  const timeValue = buildFailoverRow(facts, 'Response time');
  const note = el('p', 'api-showcase-failover-note');
  note.hidden = true;
  card.append(cardHeader, facts, note);
  block.append(card);

  const metrics = createMetricsPanel(apiBase, { timingLabels: ['upstream', 'edge'] });
  block.append(metrics.element);

  let currentMode = initialMode;
  let requestSeq = 0;

  async function load(mode, { fresh = false } = {}) {
    currentMode = mode;
    requestSeq += 1;
    const seq = requestSeq;
    modeButtons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode)));
    const { label } = FAILOVER_MODES.find((m) => m.mode === mode);
    status.textContent = `${label}: requesting…`;
    card.setAttribute('aria-busy', 'true');
    const startedAt = window.performance.now();

    let resp = null;
    let data = null;
    try {
      ({ resp, data } = await fetchJson(`${apiBase}/api/resilient?mode=${mode}`, fresh));
      metrics.record(resp, startedAt);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('api-showcase failover: resilient request failed', err);
    }
    if (seq !== requestSeq) return; // a newer click superseded this one
    const elapsed = window.performance.now() - startedAt;

    const usable = resp?.ok && data?.data;
    const fromFallback = usable && data.served !== 'live';
    const movie = usable ? data.data : null;

    cardTitle.textContent = movie?.year ? `${movie.title} (${movie.year})` : (movie?.title || 'The Matrix');
    card.classList.toggle('fallback', !usable || fromFallback);
    badge.textContent = usable ? data.served || 'unknown' : 'no response';
    servedValue.textContent = usable ? data.served || '—' : '—';
    fallbackValue.textContent = resp?.headers.get('X-Fallback') ?? '—';
    reasonValue.textContent = usable ? data.reason ?? 'none' : '—';
    timeValue.textContent = formatMs(elapsed);

    // Still neutral when nothing usable came back: the demo shows resilience, not failure.
    note.hidden = usable && !fromFallback;
    if (!usable) {
      note.textContent = 'No response from the edge right now. Try again in a moment.';
    } else if (fromFallback) {
      note.textContent = `Served from fallback: the backend ${data.reason === 'timeout' ? 'was too slow' : 'was down'}, so the edge returned its bundled snapshot.`;
    }
    status.textContent = `${label}: ${usable ? `served ${data.served}` : 'no response'} in ${formatMs(elapsed)}.`;
    card.removeAttribute('aria-busy');
  }

  modes.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (btn) load(btn.dataset.mode);
  });

  metrics.onRunAgain(() => load(currentMode, { fresh: true }));

  // Not awaited: the skeleton is already on the page; the fetch must not block rendering.
  load(initialMode);
}

/* ---------- cache-lab (Cache Lab, eds-api-poc-edge docs/cache-lab.md) ---------- */

const LAB_PRODUCT_IDS = [603, 550];
const LAB_STOCK_SKU = 1;
const LAB_VISITOR_TIERS = ['gold', 'silver', 'bronze', 'gold', 'silver'];
const LAB_INGREDIENTS = [
  { key: 'product', label: 'Product' },
  { key: 'prices', label: 'Prices' },
  { key: 'topSellers', label: 'Top sellers' },
];
/** quote's Surrogate-Control max-age (docs/cache-lab.md). */
const LAB_QUOTE_TTL_S = 10;
const LAB_PURGE_CDN = './scripts/purge.sh key product-603';
const LAB_PURGE_FETCH_CACHE = 'aio aem edge-functions purge-cache api-poc -k product-603 --soft';
/** Card A's operator steps: the layers are cleared separately to show they do different things. */
const LAB_PURGE_STEPS = [
  {
    title: 'CDN cache only',
    command: LAB_PURGE_CDN,
    effect: 'after Load, age is back to 0 but the upstream timestamp has not moved. The CDN dropped its copy and refetched from the function, which still had the data. The response looks fresh and isn\'t.',
  },
  {
    title: 'Function fetch cache only',
    command: LAB_PURGE_FETCH_CACHE,
    effect: 'after Load, nothing changes. The CDN is still answering, so the request never reaches the function.',
  },
  {
    title: 'Both, inner layer first',
    command: `${LAB_PURGE_FETCH_CACHE}\n${LAB_PURGE_CDN}`,
    effect: 'after Load, age is 0 and the timestamp jumps to now. Both layers were empty, so the request went CDN to function to backend.',
  },
];
/**
 * Cache headers shown under each card's code. Surrogate-Control and Surrogate-Key never reach
 * the browser (the CDN strips them). Card C shows its backend-call count from the body's
 * per-ingredient HIT/MISS instead of X-Backend-Calls; both come from the same Fastly signal.
 */
const LAB_CODE_HEADERS = ['Age', 'Cache-Control', 'X-Cache-Mode', 'X-Fetched-At', 'Server-Timing'];
const KEY_LINE_MARK = '// <-- this line';

let labCodeSeq = 0;

/** `Age` header as seconds: null when absent, NaN when unreadable. */
function ageOf(resp) {
  const raw = resp.headers.get('Age');
  return raw == null ? null : Number.parseInt(raw, 10);
}

/**
 * The fetch-cache hit signal on single-upstream routes: the function made at least one backend
 * fetch (Server-Timing has an entry besides `edge`) and none of them left Fastly's cache.
 * Returns null when the headers needed to tell aren't there.
 */
function fetchCacheHit(resp) {
  const calls = resp.headers.get('X-Backend-Calls');
  if (calls == null || !/^\d+$/.test(calls)) return null;
  const fetches = parseServerTiming(resp.headers.get('Server-Timing'))
    .filter(({ name }) => name !== 'edge');
  return fetches.length > 0 && Number(calls) === 0;
}

/**
 * "Reading from": Age > 0 → the Adobe CDN answered. Otherwise the function answered, either
 * from its fetch cache (`hit` true) or with a live backend call (`hit` false). Anything the
 * headers don't settle is "unknown".
 */
function readingFrom(resp, hit) {
  const age = ageOf(resp);
  if (Number.isNaN(age)) return 'unknown';
  if (age > 0) return `Adobe CDN (age ${age}s)`;
  if (hit == null) return 'unknown';
  return hit ? 'Edge function cache' : 'Live backend call';
}

/** `Tue, 29 Sep 2026 18:07:59 GMT` → `18:07:59 UTC`; unparsable values are shown as-is. */
function formatClock(httpDate) {
  if (!httpDate) return '—';
  const date = new Date(httpDate);
  return Number.isNaN(date.getTime()) ? httpDate : `${date.toISOString().slice(11, 19)} UTC`;
}

/**
 * Runs a Cache Lab request. Resolves to `{ resp, data, ms, startedAt }` even on non-2xx;
 * throws only when there's no response at all (network/CORS).
 */
async function fetchLab(url, { headers, fresh = false } = {}) {
  const init = {};
  if (headers) init.headers = headers;
  if (fresh) init.cache = 'no-store';
  const startedAt = window.performance.now();
  const resp = await fetch(url, init);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    // non-JSON body (e.g. the CDN's HTML error page for a 5xx): callers see data === null
  }
  return {
    resp, data, ms: window.performance.now() - startedAt, startedAt,
  };
}

function buildLabButtons(labels) {
  const group = el('div', 'api-showcase-presets cache-lab-controls');
  const buttons = labels.map((label) => {
    const btn = el('button', 'api-showcase-preset', label);
    btn.type = 'button';
    group.append(btn);
    return btn;
  });
  return { group, buttons };
}

/** The three-line readout every card carries: Age, Reading from, Upstream timestamp. */
function buildReadout() {
  const list = el('dl', 'api-showcase-comparison cache-lab-readout');
  const age = buildFailoverRow(list, 'Age');
  const from = buildFailoverRow(list, 'Reading from');
  const timestamp = buildFailoverRow(list, 'Upstream timestamp');

  function fill(resp, { hit = null, timestampText } = {}) {
    if (!resp) {
      age.textContent = '—';
      from.textContent = 'unknown';
      timestamp.textContent = '—';
      return;
    }
    const seconds = ageOf(resp);
    if (seconds == null) age.textContent = 'absent';
    else age.textContent = Number.isNaN(seconds) ? 'unknown' : `${seconds}s`;
    from.textContent = readingFrom(resp, hit);
    timestamp.textContent = timestampText ?? formatClock(resp.headers.get('X-Fetched-At'));
  }

  return { element: list, fill };
}

function renderSnippet(code, snippet) {
  code.textContent = '';
  snippet.split('\n').forEach((line) => {
    const isKey = line.trimEnd().endsWith(KEY_LINE_MARK);
    code.append(el('span', `cache-lab-code-line${isKey ? ' is-key' : ''}`, line || ' '));
  });
}

/**
 * "Show the code" toggle: the card's edge source (blocks/api-showcase/cache-snippets.js, loaded
 * the first time it's opened) with the key line tinted, then the card's last cache headers.
 */
function buildCodePanel(snippetName) {
  labCodeSeq += 1;
  const panelId = `cache-lab-code-${labCodeSeq}`;
  const wrap = el('div', 'cache-lab-code');

  const toggle = el('button', 'cache-lab-code-toggle', 'Show the code');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);

  const panel = el('div', 'cache-lab-code-panel');
  panel.id = panelId;
  panel.hidden = true;
  const pre = el('pre');
  const code = el('code', null, 'Loading…');
  pre.append(code);

  const table = el('table', 'api-metrics-headers');
  table.setAttribute('aria-label', 'Cache headers from the last response');
  const tbody = el('tbody');
  const rows = new Map(LAB_CODE_HEADERS.map((name) => {
    const row = el('tr');
    const th = el('th', null, name);
    th.scope = 'row';
    const td = el('td', null, '—');
    row.append(th, td);
    tbody.append(row);
    return [name, td];
  }));
  table.append(tbody);

  panel.append(
    pre,
    el('p', 'cache-lab-code-caption', 'Cache headers from this card\'s last response'),
    table,
    el('p', 'cache-lab-note', 'Surrogate-Control and Surrogate-Key never reach the browser: the CDN strips them. The policy is in the code above.'),
  );
  wrap.append(toggle, panel);

  let loaded = false;
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide the code' : 'Show the code';
    panel.hidden = !open;
    if (open && !loaded) {
      loaded = true;
      import('./cache-snippets.js')
        .then((snippets) => renderSnippet(code, snippets[snippetName]))
        .catch(() => {
          loaded = false;
          code.textContent = 'Could not load the code snippet.';
        });
    }
  });

  function record(resp) {
    rows.forEach((td, name) => {
      td.textContent = resp?.headers.get(name) ?? (name === 'Age' ? 'absent' : '—');
    });
  }

  return { element: wrap, record };
}

function buildLabCard(title, intro) {
  const card = el('section', 'cache-lab-card');
  card.append(el('h4', null, title));
  if (intro) card.append(el('p', 'cache-lab-intro', intro));
  return card;
}

/** Card A: long TTL at both layers; a purge of both layers resets one item. */
function buildProductCard(apiBase, lab) {
  const card = buildLabCard(
    'Catalogue: long TTL, purge one item',
    'Product records are cached for an hour, at the Adobe CDN and in the function\'s fetch cache. Load one repeatedly: the age climbs, the upstream timestamp stays put.',
  );
  const { group, buttons } = buildLabButtons(LAB_PRODUCT_IDS.map((id) => `Load product ${id}`));

  const item = el('div', 'cache-lab-product');
  item.append(el('p', 'cache-lab-placeholder', 'Loading product…'));
  const readout = buildReadout();
  const status = buildStatus();

  const purge = el('div', 'cache-lab-purge');
  purge.append(
    el('p', 'cache-lab-purge-title', 'Reset product 603 (operator only)'),
    el('p', null, 'A purge needs the CDN purge key, an operator credential, so it can\'t and mustn\'t run from this page. Run these in a terminal in the edge repo.'),
  );
  const steps = el('ol', 'cache-lab-purge-steps');
  LAB_PURGE_STEPS.forEach(({ title, command, effect }) => {
    const step = el('li');
    const commandRow = el('div', 'cache-lab-command');
    const commandCode = el('code', null, command);
    const copy = el('button', 'api-showcase-preset', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', `Copy the command: ${title}`);
    commandRow.append(commandCode, copy);
    step.append(el('p', 'cache-lab-purge-title', title), commandRow, el('p', null, `Effect: ${effect}`));
    steps.append(step);

    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        copy.textContent = 'Copied';
      } catch {
        // clipboard blocked (permissions/insecure context): select it for a manual copy instead
        window.getSelection().selectAllChildren(commandCode);
        copy.textContent = 'Press ⌘C / Ctrl+C';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    });
  });
  purge.append(
    steps,
    el('p', null, 'Order matters. Clear the CDN first and the next request refills it from the fetch cache you are about to empty. Product 550 is untouched throughout.'),
  );

  const code = buildCodePanel('product');
  card.append(group, item, readout.element, status, purge, code.element);

  let seq = 0;
  async function load(id, opts) {
    seq += 1;
    const mine = seq;
    status.textContent = `Loading product ${id}…`;
    let result = null;
    try {
      result = await fetchLab(`${apiBase}/api/cache/product?id=${id}`, opts);
      lab.record(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('api-showcase cache-lab: product request failed', err);
    }
    if (mine !== seq) return;
    const { resp, data, ms } = result || {};
    readout.fill(resp, { hit: resp ? fetchCacheHit(resp) : null });
    code.record(resp);

    item.textContent = '';
    if (resp?.ok && data) {
      if (data.poster) {
        const img = el('img');
        img.src = data.poster;
        img.alt = '';
        img.width = 62;
        img.height = 93;
        img.loading = 'lazy';
        item.append(img);
      }
      const text = el('div');
      text.append(
        el('p', 'cache-lab-product-title', data.year ? `${data.title} (${data.year})` : data.title),
        el('p', null, `Product ${data.id}`),
      );
      item.append(text);
      status.textContent = `Product ${id} in ${formatMs(ms)}.`;
    } else {
      item.append(el('p', 'cache-lab-placeholder', 'No product data.'));
      status.textContent = `Product ${id} unavailable${resp ? ` (HTTP ${resp.status})` : ''}.`;
    }
  }

  buttons.forEach((btn, i) => btn.addEventListener('click', () => {
    const id = LAB_PRODUCT_IDS[i];
    lab.setLast((opts) => load(id, opts));
    load(id);
  }));

  function start() {
    const [id] = LAB_PRODUCT_IDS;
    lab.setLast((opts) => load(id, opts));
    load(id);
  }

  return { element: card, start };
}

/** Card B: short TTL + stale-while-revalidate; the reading is generated by the function. */
function buildStockCard(apiBase, lab) {
  const card = buildLabCard(
    'Stock: short TTL with stale-while-revalidate',
    'The function takes a stock reading each time it builds a response. Click Read stock repeatedly: a cached copy keeps its old reading, a refreshed one shows a new reading and time.',
  );
  const { group, buttons: [readBtn] } = buildLabButtons(['Read stock']);

  const reading = el('div', 'cache-lab-reading');
  const level = el('p', 'cache-lab-figure', '—');
  const takenAt = el('p', 'cache-lab-figure-sub', 'reading taken —');
  const change = el('p', 'cache-lab-change', '');
  reading.append(level, takenAt, change);

  const policy = el('p', 'cache-lab-policy', 'Policy: 20s fresh, 120s stale-while-revalidate.');
  const readout = buildReadout();
  const status = buildStatus();
  const code = buildCodePanel('stock');
  card.append(group, reading, policy, readout.element, status, code.element);

  let previousReadingAt = null;

  async function read(opts) {
    status.textContent = 'Reading stock…';
    let result = null;
    try {
      result = await fetchLab(`${apiBase}/api/cache/stock?id=${LAB_STOCK_SKU}`, opts);
      lab.record(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('api-showcase cache-lab: stock request failed', err);
    }
    const { resp, data, ms } = result || {};
    readout.fill(resp, { hit: resp ? fetchCacheHit(resp) : null });
    code.record(resp);

    if (!resp?.ok || !data) {
      status.textContent = `Stock unavailable${resp ? ` (HTTP ${resp.status})` : ''}.`;
      return;
    }
    level.textContent = `${data.level} in stock`;
    takenAt.textContent = `reading taken ${formatClock(data.readingAt)}`;
    if (previousReadingAt == null) {
      change.textContent = 'First reading.';
    } else if (data.readingAt === previousReadingAt) {
      change.textContent = 'Same reading as last time: a cached copy.';
    } else {
      change.textContent = 'New reading since last time.';
    }
    change.classList.toggle('is-new', previousReadingAt != null && data.readingAt !== previousReadingAt);
    previousReadingAt = data.readingAt;
    status.textContent = `Stock read in ${formatMs(ms)}.`;
  }

  readBtn.addEventListener('click', () => {
    lab.setLast(read);
    read();
  });

  return { element: card, start: () => read() };
}

/** Card C: an uncached personalised response composed from cached, shared ingredients. */
function buildMypageCard(apiBase, lab) {
  const card = buildLabCard(
    'Personalised page, cached ingredients',
    'Every visitor gets a page built for their tier, and that page is never cached. The ingredients behind it (product, prices, top sellers) are the same for everyone, so the function caches those.',
  );
  const { group, buttons: [runBtn] } = buildLabButtons([`Simulate ${LAB_VISITOR_TIERS.length} visitors`]);

  const headline = el('p', 'cache-lab-headline', 'Simulate the visitors to see how many backend calls they cost.');
  const detail = el('p', 'cache-lab-note', '');
  const tableWrap = el('div', 'cache-lab-table-wrap');
  const table = el('table', 'cache-lab-table');
  const head = el('tr');
  ['#', 'Tier', 'Response time', ...LAB_INGREDIENTS.map(({ label }) => label)]
    .forEach((label) => {
      const th = el('th', null, label);
      th.scope = 'col';
      head.append(th);
    });
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  table.append(thead, tbody);
  tableWrap.append(table);
  const timestampsNote = el('p', 'cache-lab-note', 'Ingredient columns: Fastly\'s cache state for that fetch, then its upstream Date as supporting detail. Date can move on a cache hit, so it doesn\'t prove two visitors got the same copy; HIT/MISS does.');
  const neverCached = el('p', 'cache-lab-policy', '');
  const readout = buildReadout();
  const status = buildStatus();
  const code = buildCodePanel('mypage');
  card.append(
    group,
    headline,
    detail,
    tableWrap,
    timestampsNote,
    neverCached,
    readout.element,
    status,
    code.element,
  );

  function summarise(visits) {
    const ok = visits.filter((v) => v.resp?.ok && v.data?.ingredients);
    const pages = new Set(ok.map((v) => v.data.tier)).size;
    // Each ingredient's `cache` is Fastly's own HIT/MISS for that fetch (docs/cache-lab.md,
    // "How X-Backend-Calls is counted"); a MISS is a call that went on to the backend.
    const states = ok.flatMap((v) => LAB_INGREDIENTS
      .map(({ key }) => v.data.ingredients[key]?.cache));
    const known = states.length > 0 && states.every((s) => s === 'hit' || s === 'miss');
    const calls = states.filter((s) => s === 'miss').length;
    const callText = known ? `${calls} backend call${calls === 1 ? '' : 's'}` : 'backend calls unknown';
    headline.textContent = `${visits.length} visitor${visits.length === 1 ? '' : 's'}, `
      + `${pages} response${pages === 1 ? '' : 's'}, ${callText}`;
    detail.textContent = ok.length
      ? `Out of ${states.length} ingredient fetches, ${states.filter((s) => s === 'hit').length} were answered by Fastly's cache (HIT) and ${calls} went to the backend (MISS). Per ingredient: `
        + `${LAB_INGREDIENTS.map(({ key, label }) => `${label.toLowerCase()} ${ok.filter((v) => v.data.ingredients[key]?.cache === 'miss').length}`).join(' · ')}.`
        + `${ok.length < visits.length ? ` ${visits.length - ok.length} visitor(s) got no page.` : ''}`
      : 'No visitor got a page.';

    const answered = visits.filter((v) => v.resp);
    const cachedOnes = answered.filter((v) => v.resp.headers.has('Age')
      || !/\bno-store\b/i.test(v.resp.headers.get('Cache-Control') || ''));
    if (!answered.length) {
      neverCached.textContent = '';
    } else if (!cachedOnes.length) {
      neverCached.textContent = `All ${answered.length} responses: no Age header, Cache-Control: no-store. The page itself was never cached.`;
    } else {
      neverCached.textContent = `${cachedOnes.length} of ${answered.length} responses carried an Age header or lacked Cache-Control: no-store.`;
    }
  }

  function addRow(n, tier, visit) {
    const row = el('tr');
    row.append(el('td', null, String(n)), el('td', null, capitalize(tier)));
    if (!visit.resp?.ok || !visit.data?.ingredients) {
      row.append(el('td', null, visit.resp ? `HTTP ${visit.resp.status}` : 'no response'));
      LAB_INGREDIENTS.forEach(() => row.append(el('td', null, '—')));
    } else {
      row.append(el('td', null, formatMs(visit.ms)));
      LAB_INGREDIENTS.forEach(({ key }) => {
        const ing = visit.data.ingredients[key];
        const state = ing?.cache === 'hit' || ing?.cache === 'miss' ? ing.cache.toUpperCase() : '?';
        const td = el('td', null, ing?.status === 'ok' ? `${state} · ${formatClock(ing.fetchedAt)}` : `${state} · error`);
        if (ing?.fetchedAt) td.title = ing.fetchedAt;
        row.append(td);
      });
    }
    tbody.append(row);
  }

  let running = false;
  async function simulate(opts) {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    tbody.textContent = '';
    const visits = [];
    for (let i = 0; i < LAB_VISITOR_TIERS.length; i += 1) {
      const tier = LAB_VISITOR_TIERS[i];
      status.textContent = `Visitor ${i + 1} of ${LAB_VISITOR_TIERS.length} (${tier})…`;
      let visit = { resp: null, data: null, ms: NaN };
      try {
        // Sequential on purpose: each visitor arrives after the previous one was served.
        // eslint-disable-next-line no-await-in-loop
        visit = await fetchLab(`${apiBase}/api/cache/mypage?tier=${tier}`, opts);
        lab.record(visit);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('api-showcase cache-lab: mypage request failed', err);
      }
      visits.push(visit);
      addRow(i + 1, tier, visit);
    }
    summarise(visits);

    const last = visits[visits.length - 1];
    const ings = last.data?.ingredients ? Object.values(last.data.ingredients) : [];
    // The body's own per-ingredient cache state; unknown unless every ingredient reports one.
    const hit = ings.length && ings.every((x) => x.cache === 'hit' || x.cache === 'miss')
      ? ings.every((x) => x.cache === 'hit')
      : null;
    readout.fill(last.resp, { hit, timestampText: 'per ingredient, in the table' });
    code.record(last.resp);
    status.textContent = 'Done.';
    runBtn.disabled = false;
    running = false;
  }

  runBtn.addEventListener('click', () => {
    lab.setLast(simulate);
    simulate();
  });

  return { element: card };
}

/** Card D: stale-if-error — the CDN serves its stale copy while the origin fails. */
function buildQuoteCard(apiBase, lab) {
  const card = buildLabCard(
    'Backend outage: stale-if-error',
    'The quote is fresh for 10s. After that, if the backend fails, the CDN may keep serving its last good copy for up to a day.',
  );
  const { group, buttons: [loadBtn, breakBtn, againBtn] } = buildLabButtons(['Load quote', 'Break the backend', 'Load again']);
  breakBtn.setAttribute('aria-pressed', 'false');

  const quoteBox = el('div', 'cache-lab-reading');
  const price = el('p', 'cache-lab-figure', '—');
  const quotedAt = el('p', 'cache-lab-figure-sub', 'quoted at —');
  quoteBox.append(price, quotedAt);
  const backend = el('p', 'cache-lab-backend', 'Backend: healthy');
  const outcome = el('p', 'cache-lab-change', '');
  const readout = buildReadout();
  const status = buildStatus();
  const contrast = el('p', 'cache-lab-note', 'Contrast with pattern 04 (Failover): there the function substitutes a bundled fallback when nothing is cached. Here the CDN covers for a failing origin with its own stale copy.');
  const code = buildCodePanel('quote');
  card.append(group, quoteBox, backend, outcome, readout.element, status, contrast, code.element);

  let broken = false;
  let lastGoodQuotedAt = null;

  function describeBroken(resp, data) {
    if (!resp) {
      return 'The browser got no readable response: either the CDN had no stale copy and passed the backend\'s error through, or the browser\'s CORS preflight refused the X-Break header.';
    }
    if (!resp.ok || !data?.quotedAt) {
      return `No stale copy to serve: the backend's error came through (HTTP ${resp.status}).`;
    }
    const age = ageOf(resp);
    const unchanged = lastGoodQuotedAt != null && data.quotedAt === lastGoodQuotedAt;
    if (Number.isFinite(age) && age > LAB_QUOTE_TTL_S && unchanged) {
      return `Stale copy served: the data is unchanged (quoted at ${formatClock(data.quotedAt)}), the age is ${age}s, past the ${LAB_QUOTE_TTL_S}s TTL, and the backend is failing. The client still got a 200.`;
    }
    if (Number.isFinite(age) && age <= LAB_QUOTE_TTL_S) {
      return `Age ${age}s is still inside the ${LAB_QUOTE_TTL_S}s TTL, so the CDN hasn't asked the backend yet. Wait until the age passes ${LAB_QUOTE_TTL_S}s, then load again.`;
    }
    return `HTTP ${resp.status}, age ${Number.isFinite(age) ? `${age}s` : 'absent'}, quoted at ${formatClock(data.quotedAt)}: this doesn't match the measured stale-if-error behaviour.`;
  }

  async function load(opts) {
    status.textContent = broken ? 'Loading with the backend broken…' : 'Loading quote…';
    let result = null;
    try {
      result = await fetchLab(`${apiBase}/api/cache/quote`, {
        ...opts,
        ...(broken ? { headers: { 'X-Break': '1' } } : {}),
      });
      lab.record(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('api-showcase cache-lab: quote request failed', err);
    }
    const { resp, data, ms } = result || {};
    // quote has no backend fetch: with Age 0 the function generated it just now.
    readout.fill(resp, { hit: resp ? false : null });
    code.record(resp);

    if (resp?.ok && data?.quotedAt) {
      price.textContent = `${data.symbol} ${Number(data.price).toFixed(2)}`;
      quotedAt.textContent = `quoted at ${formatClock(data.quotedAt)}`;
      if (!broken) lastGoodQuotedAt = data.quotedAt;
    }
    outcome.textContent = broken ? describeBroken(resp, data) : '';
    status.textContent = resp ? `HTTP ${resp.status} in ${formatMs(ms)}.` : 'No response.';
  }

  function run() {
    lab.setLast(load);
    load();
  }

  loadBtn.addEventListener('click', run);
  againBtn.addEventListener('click', run);
  breakBtn.addEventListener('click', () => {
    broken = !broken;
    breakBtn.setAttribute('aria-pressed', String(broken));
    breakBtn.textContent = broken ? 'Backend broken (click to fix)' : 'Break the backend';
    backend.textContent = broken
      ? 'Backend: failing. Every request now sends X-Break: 1, so the function answers 503.'
      : 'Backend: healthy';
    card.classList.toggle('is-broken', broken);
    outcome.textContent = '';
  });

  return { element: card, start: () => load() };
}

/**
 * Wires up the Cache Lab variant: four cards, each showing one CDN caching behaviour of the
 * `/api/cache/*` routes (eds-api-poc-edge docs/cache-lab.md), sharing one metrics panel whose
 * "Run again" repeats the last card action.
 */
function decorateCacheLab(block, config) {
  const apiBase = getApiBase();

  block.innerHTML = '';
  block.append(buildHeading(config.title || 'Cache Lab'));

  const metrics = createMetricsPanel(apiBase, {
    timingLabels: ['tmdb', 'product', 'prices', 'topSellers', 'edge'],
  });
  let last = null;
  const lab = {
    record: ({ resp, startedAt }) => metrics.record(resp, startedAt),
    setLast: (action) => { last = action; },
  };
  metrics.onRunAgain(() => last?.({ fresh: true }));

  const cards = [
    buildProductCard(apiBase, lab),
    buildStockCard(apiBase, lab),
    buildMypageCard(apiBase, lab),
    buildQuoteCard(apiBase, lab),
  ];
  const grid = el('div', 'cache-lab-grid');
  cards.forEach(({ element }) => grid.append(element));
  block.append(grid, metrics.element);

  // Not awaited: the cards are already on the page; the fetches must not block rendering.
  // mypage waits for its button: five visitors on page load would muddy the demo.
  cards.forEach(({ start }) => start?.());
}

export default function decorate(block) {
  const config = readBlockConfig(block);
  const variant = variantOf(block);
  block.classList.add(`api-showcase-${variant}`);

  if (variant === 'proxy') {
    decorateProxy(block, config);
  } else if (variant === 'aggregate') {
    decorateAggregate(block, config);
  } else if (variant === 'transform') {
    decorateTransform(block, config);
  } else if (variant === 'cache-lab') {
    decorateCacheLab(block, config);
  } else {
    decorateFailover(block, config);
  }
}
