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
// rows read with readBlockConfig(). Only `proxy` is wired up; the rest are placeholders.

import { readBlockConfig } from '../../scripts/aem.js';
import { getApiBase } from '../../scripts/api-config.js';
import { createMetricsPanel } from '../../scripts/metrics.js';

const VARIANTS = ['proxy', 'aggregate', 'transform', 'failover'];
const DEFAULT_QUERY = 'matrix';

function variantOf(block) {
  return VARIANTS.find((v) => block.classList.contains(v)) || 'proxy';
}

/** `/api/movies?q=matrix` -> `matrix`; falls back to DEFAULT_QUERY when absent/unparsable. */
function queryFromEndpoint(endpoint) {
  if (!endpoint) return DEFAULT_QUERY;
  try {
    const q = new URL(endpoint, window.location.origin).searchParams.get('q');
    return q || DEFAULT_QUERY;
  } catch {
    return DEFAULT_QUERY;
  }
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
  } else {
    decorateStub(block, config, variant);
  }
}
