# Expedia + impit Playbook

How to bypass Akamai on Expedia.com using impit browser impersonation.
Applies to **Hotels**, **Reviews**, **Car Rental**, **Flights**, **Packages** — any Expedia vertical.

---

## 1. Browser Profiles — Which Actually Work

impit v0.14.3 maps JS strings to Rust fingerprint functions:

| JS string | Real browser | Works on Expedia |
|---|---|---|
| `"chrome"`, `"chrome124"` | Chrome 124 | ✅ |
| `"chrome131"` | Chrome 131 | ✅ |
| `"chrome136"` | Chrome 136 | ✅ |
| `"chrome142"` | Chrome 142 | ✅ |
| `"firefox133"` | Firefox 133 | ✅ |
| `"firefox135"` | Firefox 135 | ✅ |
| `"firefox144"` | Firefox 144 | ✅ |
| `"okhttp3"` | Android OkHttp 3 | ✅ |
| `"okhttp4"` | Android OkHttp 4 | ✅ |
| `"okhttp5"` | Android OkHttp 5 | ✅ |
| `"chrome100"`–`"chrome125"` | Old Chrome (100–125) | ❌ 429 challenge |
| `"firefox"`, `"firefox128"` | Firefox 128 | ❌ connection failures |
| `"ios18"` | iOS 18 Safari | ❌ 429 challenge |

**Rule:** Only the **latest 4 Chrome versions** and **latest 3 Firefox versions** pass Akamai.  
Old versions and iOS Safari from non-iOS IPs are always blocked.

---

## 2. The Two Warmup Requests

Every Expedia session needs **two GET requests** before any GraphQL POST:

```
1. GET https://www.expedia.com/                  (homepage, no referer)
2. GET https://www.expedia.com/Hotel-Search?...   (listing/vertical page, referer: homepage)
```

### Headers for Warmup (GET)

```js
function buildWarmupHeaders({ referer } = {}) {
    return {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'client-info': 'domain-redirect:true',
        'sec-fetch-site': referer ? 'same-origin' : 'none',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-user': '?1',
        'sec-fetch-dest': 'document',
        ...(referer ? { referer } : {}),
    };
}
```

**Do NOT set manually** — impit's browser fingerprint handles these:
- `user-agent`
- `sec-ch-ua`, `sec-ch-ua-platform`, `sec-ch-ua-mobile`, etc.
- `upgrade-insecure-requests`
- `accept-encoding` (impit sends `gzip, deflate, br, zstd`)

**Do NOT set** `accept-encoding` on any request — let impit manage it. Hardcoding `gzip, deflate` without `br`/`zstd` is detectable as non-browser.

---

## 3. GraphQL POST Headers

```js
function buildGraphqlHeaders({ searchUrl, bootstrapData, cookieHeader }) {
    return {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'client-info': bootstrapData.clientInfo,
        'device-user-agent-id': bootstrapData.duaid,
        'x-page-id': bootstrapData.pageId,
        'x-enable-apq': 'true',
        'x-shopping-product-line': 'lodging',       // ← change per vertical
        'ctx-view-id': bootstrapData.ctxViewId,
        origin: 'https://www.expedia.com',
        referer: searchUrl,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
    };
}
```

**Critical headers for Akamai:**
- `sec-fetch-dest: empty` — tells Akamai this is an XHR/fetch, not a navigation
- `sec-fetch-mode: cors` — same-origin CORS fetch
- `sec-fetch-site: same-origin` — same site as the page
- `accept-encoding` — **must not be set**; let impit send the browser-native value
- `cookie` — **must be explicitly sent** from the warmup response; cookieJar alone is not reliable

**Bootstrap values extracted from listing page HTML** (after `replace(/\\"/g, '"')` normalization):
- `applicationName` → not sent as header, used for verification
- `app_version` → used for `client-info` if page header not available
- `pageId` → sent as `x-page-id`
- `searchId` → used in GraphQL payload
- `productOffersId` → used in GraphQL payload
- `DUAID` → sent as `device-user-agent-id`

---

## 4. Device Context

All Expedia GraphQL queries on desktop require:

```js
device: { type: 'DESKTOP' }
```

Mobile device types (`MOBILE`, `TABLET`) are rejected. This is independent of which browser TLS fingerprint you use.

---

## 5. Cookie Management

```js
import { CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();
const impit = new Impit({ browser: 'chrome142', cookieJar });
```

- impit stores `Set-Cookie` in the jar automatically
- But **also extract cookies manually** from warmup response headers and pass them as the `cookie` header in GraphQL requests — the cookieJar is a backup, not the primary mechanism

---

## 6. Proxy Strategy

```js
const proxyStrategies = [
    { label: 'input_proxy_configuration', buildProxyUrl: /* Apify proxy */ },
    { label: 'direct_no_proxy', buildProxyUrl: () => undefined },
];
```

Always append a direct connection fallback after proxy strategies.
For the direct fallback, limit warmup to 2 attempts instead of 8.

---

## 7. Warmup Profile Rotation

```js
const WARMUP_PROFILES = [
    { name: 'chrome142', browser: 'chrome142' },
    { name: 'chrome131', browser: 'chrome131' },
    { name: 'firefox144', browser: 'firefox144' },
];
```

**Do NOT include:** `ios18`, `firefox` (generic), `chrome` (generic), or any `chrome1xx` below `chrome131`.

Rotation logic:
```
attempt 1 → chrome142
attempt 2 → chrome131
attempt 3 → firefox144
attempt 4 → chrome142 (cycle back)
...
```

---

## 8. Applying to Other Expedia Verticals

Each vertical uses the same **warmup** strategy but different **GraphQL** configuration.

### Reviews
- Warmup: `https://www.expedia.com/` + a hotel detail page (not Hotel-Search)
- GraphQL endpoint: `https://www.expedia.com/graphql`
- Query: `PropertyReviewsQuery` (or similar persisted query)
- Headers: same as above, except `x-shopping-product-line: lodging`
- Bootstrap: extract from hotel detail page HTML

### Car Rental
- Warmup: `https://www.expedia.com/` + `https://www.expedia.com/Car-Rental?...`
- GraphQL endpoint: `https://www.expedia.com/graphql`
- Query: `CarSearchQuery` (or similar)
- Headers: same as above, change `x-shopping-product-line: cars`
- Bootstrap: extract from Car-Rental page HTML

### Flights
- Warmup: `https://www.expedia.com/` + `https://www.expedia.com/Flights?...`
- GraphQL endpoint: `https://www.expedia.com/graphql`
- Query: `FlightSearchQuery` (or similar)
- Headers: same, change `x-shopping-product-line: flights`
- Device context: still `DESKTOP`

### Packages (Flight + Hotel)
- Warmup: `https://www.expedia.com/` + `https://www.expedia.com/Packages?...`
- Same pattern — just change the warmup URL and GraphQL operation

**Key insight:** The warmup mechanism (homepage → vertical page → GraphQL) is identical across all verticals. Only the second warmup URL, GraphQL query name/hash, and `x-shopping-product-line` header change.

---

## 9. Common Pitfalls

| Problem | Cause | Fix |
|---|---|---|
| 429 on GraphQL after successful warmup | Missing `sec-fetch-*` fetch context headers on POST | Add `sec-fetch-dest: empty`, `sec-fetch-mode: cors`, `sec-fetch-site: same-origin` |
| 429 on GraphQL after successful warmup | Missing `accept-language` on POST | Add `accept-language: en-US,en;q=0.9` |
| 429 on GraphQL after successful warmup | Missing `cookie` header on POST | Manually pass cookie from warmup response |
| 429 wildcard challenge on warmup | Browser fingerprint too old | Use `chrome142`, `chrome131`, or `firefox144` only |
| 429 wildcard challenge on warmup | iOS/mobile browser from non-iOS IP | Never use `ios18` without an iOS-residential proxy |
| 429 wildcard challenge on warmup | Missing navigation `sec-fetch-*` headers on GET | Add `sec-fetch-mode: navigate`, `sec-fetch-dest: document`, `sec-fetch-user: ?1` |
| 403 on warmup | Missing `client-info`, wrong headers | Ensure `client-info: domain-redirect:true` on warmup GET |
| Proxy 590 tunnel error | Bad proxy | Rotate proxy; always include `direct_no_proxy` fallback |
| `desktop` device type rejected | Wrong payload | Ensure `device: { type: 'DESKTOP' }` in GraphQL variables |
| Cookies not persisting | CookieJar not passed to impit | Pass `cookieJar: new CookieJar()` to `new Impit({...})` |

---

## 10. Quick Start Template

```js
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

const impit = new Impit({
    browser: 'chrome142',       // or 'chrome131' / 'firefox144'
    cookieJar: new CookieJar(),
    ignoreTlsErrors: true,
});

// Step 1: Warmup homepage
const home = await impit.fetch('https://www.expedia.com/', {
    method: 'GET',
    headers: { /* buildWarmupHeaders() with no referer */ },
});

// Step 2: Warmup vertical page
const cookies = extractCookies(home.headers);
const listing = await impit.fetch('https://www.expedia.com/Hotel-Search?...', {
    method: 'GET',
    headers: { /* buildWarmupHeaders() with referer, plus cookie */ },
});

// Step 3: Extract bootstrap data from HTML
const bootstrapData = buildBootstrapData(await listing.text(), cookies);

// Step 4: GraphQL POST
const result = await impit.fetch('https://www.expedia.com/graphql', {
    method: 'POST',
    headers: { /* buildGraphqlHeaders() with bootstrapData + cookie */ },
    body: JSON.stringify([{ /* GraphQL payload */ }]),
});
```
