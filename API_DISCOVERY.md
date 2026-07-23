# API Discovery Notes

## Selected API
- Endpoint: https://www.expedia.com/graphql
- Method: POST
- Operation: PropertyListingQuery
- Persisted Query Hash: 82abb7da6738db4c904e4d10130072236a751b5a315f6dfaf92474793597bc33
- Auth: Anonymous session plus anti-bot cookies from a prior Hotel-Search page request
- Pagination: resultsStartingIndex and resultsSize in criteria.secondary.counts
- Listing Data Path: data.propertySearch.propertySearchListings (LodgingCard items)
- Analytics Enrichment Path: extensions.analytics[0].tealiumUtagData.entity.hotels.results.results

## Discovery Evidence
- Live browser network capture showed PropertyListingQuery calls to https://www.expedia.com/graphql for Hotel-Search pages.
- Direct HTTP replay of PropertyListingQuery without bootstrap cookies returned 403.
- Direct got-scraping request to the Hotel-Search page returned valid Akamai/session cookies and HTML state containing searchId, productOffersId, app version, region, and pageId.
- Replaying PropertyListingQuery with those bootstrap cookies plus derived client-info and page headers returned hotel listings JSON with HTTP 200.
- Pagination works directly by incrementing resultsStartingIndex while reusing the same bootstrap session.
- Bootstrap and GraphQL replay must keep a coherent browser profile. Do not mix mobile user agents with desktop client hints, and do not rotate the GraphQL profile independently from the cookie/session profile that succeeded at bootstrap.

## Request Profile Matrix
| Candidate | Header profile | Use | Decision |
|---|---|---|---|
| Web GraphQL | iOS Safari navigation warmup + same warmed cookies for GraphQL | Selected hotel-listing request pattern | selected primary |
| Web GraphQL | Desktop Chrome headers + matching sec-ch-ua | Older bootstrap/API replay attempt | rejected because mixing Chromium hints with Safari fallback cookies caused inconsistent sessions |
| Web GraphQL | Android Chrome mobile web headers + matching MOBILE device context | Older fallback when desktop profile was blocked | rejected for current listing actor because request context remains DESKTOP |
| Android app style | okhttp-style app headers | Not used against web Hotel-Search/bootstrap flow because Expedia web GraphQL needs browser cookies/page state | rejected for runtime |

## Rotating Hotel Listing Warmup Ladder (July 22, 2026)

Selected sequence for Expedia hotel listing sessions:
1. GET `https://www.expedia.com/`
2. GET the clean canonical Hotel-Search/listing URL first.
3. If needed, retry with the full original Hotel-Search/listing URL on the next fresh session.
4. POST `PropertyListingQuery` to `https://www.expedia.com/graphql` with warmed cookies, `DUAID` as `device-user-agent-id`, `origin: https://www.expedia.com`, listing URL as `referer`, warmed `x-page-id`/`client-info` when present, `accept: application/json`, and `DESKTOP` device context (required by this GraphQL query regardless of transport level browser profile).

Warmup profiles rotate per attempt and then cycle:

| Attempt | Profile | Transport | Notes |
|---:|---|---|---|
| 1 | `chrome142` | impit chrome | Desktop Chrome TLS fingerprint. Device context: DESKTOP. |
| 2 | `ios18` | impit ios18 | iOS 18 system TLS fingerprint (matches Safari, Chrome iOS, Firefox iOS — all use NSURLSession). Device context: DESKTOP in GraphQL. |
| 3 | `firefox144` | impit firefox | Firefox Desktop TLS fingerprint. Device context: DESKTOP. |
| 4 | `chrome142` | impit chrome | Cycle repeats from attempt 1 |
| Any | any profile | any | rejected when status is 429 and `x-page-id` is `wildcard-challenge-handler` |

Implementation notes:
- `impit` clients are cached by both browser transport and proxy URL, for example `${browser}:${proxyUrl || '__direct__'}`.
- Each impit instance has a `tough-cookie` CookieJar for automatic cookie persistence across requests — no manual cookie extraction or merging needed for session continuity.
- Only app-specific headers are set manually (`content-type`, `client-info`, `x-page-id`, `origin`, `referer`, `device-user-agent-id`, `x-enable-apq`, `x-shopping-product-line`, `ctx-view-id`). All browser fingerprint headers (`user-agent`, `accept`, `accept-language`, `sec-fetch-*`, etc.) are generated automatically by impit for TLS+HTTP consistency.
- Residential proxy warmup allows 8 attempts; direct/no-proxy warmup allows 2 attempts.
- Each residential retry uses a fresh Apify proxy session id shaped as `expedia_${uuidWithoutHyphens}` to satisfy Apify session id rules.
- Challenge cookies from homepage, listing, or GraphQL responses are discarded immediately and are not sent to data requests.
- Residential proxy exhaustion fails the actor clearly. Direct/no-proxy challenge exits cleanly with a residential proxy recommendation.

## Selected Response Fields
- hotel_id
- hotel_name
- city
- star_rating
- guest_rating
- guest_rating_out_of_five
- review_count
- nightly_price
- total_price
- strikeout_price
- free_cancellation
- member_price_available
- vacation_rental
- image_url
- property_url
- region_id
- region_name
- check_in
- check_out
- adults
- children
- sort
- search_id

## API Selection Score
| Score Factor | Points |
|---|---|
| Returns JSON directly | +30 |
| Has >15 unique fields | +25 |
| No auth required | +0 |
| Has pagination support | +15 |
| Matches or extends current fields | +10 |
| **Total** | **80** |

## Final Decision
Use got-scraping to fetch the Hotel-Search page, derive session/bootstrap values from HTML and cookies, then call PropertyListingQuery directly for paginated hotel listings. Save only non-empty fields and deduplicate by hotel_id.
