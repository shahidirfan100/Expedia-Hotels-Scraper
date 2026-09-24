# API Discovery Notes

## Selected API
- Endpoint: https://www.expedia.com/graphql
- Method: POST
- Operation: RemainderListings
- Persisted Query Hash: 657c1c854b7f6469e603e5fc4f03aa9a99bd2df9796bfd5daa8820113cdb39e8
- Auth: Anonymous session plus anti-bot cookies from a prior Hotel-Search page request
- Pagination: resultsStartingIndex and resultsSize in criteria.secondary.counts
- Listing Data Path: data.propertySearch.propertySearchListings (LodgingCard items)
- Analytics Enrichment Path: extensions.analytics[0].tealiumUtagData.entity.hotels.results.results

## Discovery Evidence
- A live browser capture on 2026-09-24 showed Hotel-Search using `RemainderListings` at https://www.expedia.com/graphql with persisted-query hash `657c1c854b7f6469e603e5fc4f03aa9a99bd2df9796bfd5daa8820113cdb39e8`.
- The captured operation returned HTTP 200 and `data.propertySearch.propertySearchListings` with `LodgingCard` items. Its variables include `searchId`, sort, rewards mode, `resultsStartingIndex`, and `resultsSize`; it does not use `productOffersId`.
- The previous `PropertyListingQuery` hash `82abb7da6738db4c904e4d10130072236a751b5a315f6dfaf92474793597bc33` returned `PersistedQueryNotFound` during Apify QA on 2026-09-24. This is a stale/unknown APQ operation, not a session-cookie failure; warming a new session and resending that hash does not recover it.
- Direct HTTP replay without bootstrap cookies returned 403. The working flow warms the homepage and Hotel-Search page, then sends the GraphQL request with those cookies plus matching app and fetch-context headers.
- Pagination works by incrementing `resultsStartingIndex` while reusing the warmed session.
- Bootstrap and GraphQL replay must keep a coherent browser profile. Do not mix mobile user agents with desktop client hints, and do not rotate the GraphQL profile independently from the cookie/session profile that succeeded at bootstrap.

## Request Profile Matrix
| Candidate | Header profile | Use | Decision |
|---|---|---|---|
| Web GraphQL | Impit Chrome 151/142/131 or Firefox 144 warmup + same warmed cookies for GraphQL | Current hotel-listing request pattern; Chrome 151 returned 50 listings in the September 24 local smoke test | selected primary |
| Web GraphQL | iOS Safari navigation warmup + same warmed cookies for GraphQL | Older prototype, inconsistent with current non-iOS proxy guidance | rejected |
| Web GraphQL | Desktop Chrome headers + matching sec-ch-ua | Older bootstrap/API replay attempt | rejected because mixing Chromium hints with Safari fallback cookies caused inconsistent sessions |
| Web GraphQL | Android Chrome mobile web headers + matching MOBILE device context | Older fallback when desktop profile was blocked | rejected for current listing actor because request context remains DESKTOP |
| Android app style | okhttp-style app headers | Not used against web Hotel-Search/bootstrap flow because Expedia web GraphQL needs browser cookies/page state | rejected for runtime |

## Rotating Hotel Listing Warmup Ladder (updated September 24, 2026)

Selected sequence for Expedia hotel listing sessions:
1. GET `https://www.expedia.com/`
2. GET the clean canonical Hotel-Search/listing URL first.
3. If needed, retry with the full original Hotel-Search/listing URL on the next fresh session.
4. POST `RemainderListings` to `https://www.expedia.com/graphql` with warmed cookies, `DUAID` as `device-user-agent-id`, `origin: https://www.expedia.com`, listing URL as `referer`, warmed `x-page-id`/`client-info` when present, `accept: application/json`, and `DESKTOP` device context (required by this GraphQL query regardless of transport-level browser profile).

Warmup profiles rotate per attempt and then cycle:

| Attempt | Profile | Transport | Notes |
|---:|---|---|---|
| 1 | `chrome151` | impit chrome | Current supported Impit Chrome fingerprint; local actor smoke test returned 50 listings. |
| 2 | `chrome142` | impit chrome | Known Expedia-compatible fallback. |
| 3 | `chrome131` | impit chrome | Known Expedia-compatible fallback. |
| 4 | `firefox144` | impit firefox | Known Expedia-compatible fallback. |
| 5 | `chrome151` | impit chrome | Cycle repeats from attempt 1 |
| Any | any profile | any | rejected when status is 429 and `x-page-id` is `wildcard-challenge-handler` |

Implementation notes:
- `impit` clients are cached by both browser transport and proxy URL, for example `${browser}:${proxyUrl || '__direct__'}`.
- Each impit instance has a `tough-cookie` CookieJar for cookie persistence. The actor also extracts the warmed cookies and explicitly sends them on GraphQL requests, as required by the Expedia + impit playbook.
- The actor sets the Expedia/API headers and documented fetch context manually, including `accept`, `accept-language`, `sec-fetch-*`, and `cookie`, as required by the playbook. Impit generates the browser fingerprint headers (`user-agent`, `sec-ch-ua*`) and `accept-encoding` so they stay consistent with the selected TLS profile.
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
Use Impit to fetch the homepage and Hotel-Search page with a coherent browser/proxy session, derive session/bootstrap values from HTML and cookies, then call the currently discovered `RemainderListings` persisted query for paginated hotel listings. If Expedia returns `PersistedQueryNotFound`, refresh the operation name/hash from a live Hotel-Search request rather than retrying the unchanged hash with new cookies. Save only non-empty fields and deduplicate by hotel_id.
