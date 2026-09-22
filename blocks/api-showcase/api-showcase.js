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
// rows read with readBlockConfig(). `proxy`, `aggregate` and `transform` are wired up;
// `failover` is still a placeholder.

import { readBlockConfig } from '../../scripts/aem.js';
import { getApiBase } from '../../scripts/api-config.js';
import { createMetricsPanel, formatBytes, formatMs } from '../../scripts/metrics.js';

const VARIANTS = ['proxy', 'aggregate', 'transform', 'failover'];
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
  const url = `${apiBase}/api/dashboard${query ? `?${query}` : ''}`;

  block.innerHTML = '';
  block.append(buildHeading(config.title || 'Aggregator'));

  const headline = el('div', 'api-showcase-headline');
  const headlineMain = el('p', 'api-showcase-headline-main', '1 browser request instead of 3');
  const headlineDetail = el('p', 'api-showcase-headline-detail', 'Latency = slowest source, not the sum.');
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

  async function load({ fresh = false } = {}) {
    status.textContent = 'Loading…';
    cardList.setAttribute('aria-busy', 'true');
    const startedAt = window.performance.now();

    let resp = null;
    let data = null;
    try {
      ({ resp, data } = await fetchJson(url, fresh));
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
      const okCount = AGGREGATE_SOURCES.filter(({ key }) => sources[key]?.status === 'ok').length;
      const saved = data.sumOfSourcesMs - data.totalMs;
      status.textContent = `${okCount} of ${AGGREGATE_SOURCES.length} sources available`
        + `${Number.isFinite(saved) && saved > 0 ? ` · ${formatMs(saved)} saved by running them in parallel` : ''}.`;
    } else {
      totalValue.textContent = '—';
      sumValue.textContent = '—';
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

function decorateStub(block, config, variant) {
  block.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = config.title || variant;
  block.append(heading);

  const placeholder = document.createElement('p');
  placeholder.className = 'api-showcase-placeholder';
  placeholder.textContent = 'Coming next.';
  block.append(placeholder);
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
  } else {
    decorateStub(block, config, variant);
  }
}
