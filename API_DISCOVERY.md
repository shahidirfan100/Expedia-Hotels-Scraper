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
| Web GraphQL | Desktop Chrome headers + matching sec-ch-ua | First bootstrap/API replay attempt | selected primary |
| Web GraphQL | Android Chrome mobile web headers + matching MOBILE device context | Early fallback when desktop profile is blocked | selected fallback |
| Web GraphQL | Firefox desktop headers without Chromium client hints | Additional fallback when Chrome profile is blocked | selected fallback |
| Web GraphQL | iOS Safari mobile web headers without Chromium client hints | Later fallback when Chromium-style profiles are blocked | selected fallback |
| Android app style | okhttp-style app headers | Not used against web Hotel-Search/bootstrap flow because Expedia web GraphQL needs browser cookies/page state | rejected for runtime |

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
