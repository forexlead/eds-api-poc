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

// Resolves the base URL for the `api-poc` edge function (docs/api-contract.md).
// Kept as a single constant so switching to a same-origin custom domain later is a
// one-line change — every block imports getApiBase() instead of hardcoding an origin.

import { getMetadata } from './aem.js';

/** Local edge function dev server (`aio aem edge-functions serve`, this repo's edge sibling). */
const LOCAL_API_BASE = 'http://127.0.0.1:7676';

/** Deployed sandbox stage environment (program 24773, env e1511008). */
const DEFAULT_API_BASE = 'https://publish-p24773-e1511008.adobeaemcloud.com';

/**
 * Resolves the API base URL. Precedence:
 * 1. Page metadata `api-base` (authored per-page in DA), trailing slash trimmed.
 * 2. `http://127.0.0.1:7676` when the page itself is served from localhost.
 * 3. The deployed sandbox stage origin.
 * @returns {string} an origin with no trailing slash
 */
export function getApiBase() {
  const override = getMetadata('api-base');
  if (override) return override.replace(/\/+$/, '');

  const { hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return LOCAL_API_BASE;

  return DEFAULT_API_BASE;
}

export { LOCAL_API_BASE, DEFAULT_API_BASE };
