## What does Expedia Hotels Listings Scraper do?

This Actor extracts structured hotel listing data from Expedia Hotel-Search result pages. Paste an Expedia destination or Hotel-Search URL, and the Actor collects hotel names, nightly and total prices, guest ratings, star ratings, review counts, cancellation signals, property URLs, and search context. The output works for price monitoring, competitive benchmarking, travel dataset building, and offer intelligence workflows.

## Why use Expedia Hotels Listings Scraper?

- **Structured hotel data without manual work** - Skip copy-pasting Expedia search results. Get clean, deduplicated records with hotel IDs, pricing, ratings, and links in one run.
- **Handles messy URLs automatically** - Paste any Expedia Hotel-Search or destination URL. The Actor normalizes wrapper characters, tracking junk, missing dates, stale check-in dates, and missing occupancy defaults before the first request.
- **Resilient Expedia session handling** - If Expedia challenges the session or returns rate-limit responses, the Actor retries with rotated browser profiles and proxy strategies before failing.
- **Automation-ready output** - Export results to JSON, CSV, Excel, or XML. Connect datasets to Google Sheets, Airtable, Looker Studio, or downstream API pipelines.

## What data can you extract from Expedia?

| Field | Description |
|-------|-------------|
| `hotel_name` | Property name from the search card |
| `city` | City or area label shown on the listing |
| `star_rating` | Official hotel star rating |
| `guest_rating` | Guest score out of 10 |
| `review_count` | Total number of guest reviews |
| `review_label` | Rating label such as "Very Good" or "Wonderful" |
| `nightly_price` | Nightly price text from the listing |
| `total_price` | Total stay price for the selected dates |
| `strikeout_price` | Previous price shown as strikethrough when available |
| `free_cancellation` | Whether the listing offers free cancellation |
| `member_price_available` | Whether Expedia member pricing is available |
| `vacation_rental` | Whether the listing is a vacation rental |
| `property_url` | Direct link to the Expedia hotel details page |
| `image_url` | Primary listing image URL |
| `check_in` | Check-in date used for the search |
| `check_out` | Check-out date used for the search |
| `adults` | Number of adult travelers |
| `children` | Child ages when applicable |
| `sort` | Sort mode applied to the search |
| `search_id` | Expedia search session identifier |
| `scraped_at` | ISO timestamp when the record was captured |

## How to use Expedia Hotels Listings Scraper

1. Open the Actor on Apify Store.
2. Paste an Expedia Hotel-Search URL or Expedia destination page URL into the `startUrl` field.
3. Set the maximum number of listings to save and optional page load limit.
4. Run the Actor.
5. Download the dataset or connect it to an integration.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | Yes | - | Expedia Hotel-Search or Expedia destination URL. Messy, partial, or stale URLs are normalized automatically. Missing common search params such as dates, adults, and sort are healed at runtime. |
| `resultsWanted` | Integer | No | `20` | Maximum number of hotel listings to save. |
| `maxPages` | Integer | No | `8` | Maximum result-load rounds to attempt while scrolling or loading more results. |
| `proxyConfiguration` | Object | No | Apify Residential proxy | Proxy settings for stable extraction. Residential routing is recommended for Expedia. |

## Output Data

| Field | Type | Description |
|-------|------|-------------|
| `hotel_id` | String | Expedia hotel ID |
| `hotel_name` | String | Property name from search card |
| `city` | String | City or area label |
| `star_rating` | Number | Official hotel star rating |
| `guest_rating` | Number | Guest score out of 10 |
| `guest_rating_out_of_five` | Number | Guest score out of 5 from analytics payload |
| `review_count` | Integer | Total number of guest reviews |
| `review_label` | String | Rating label such as "Very Good" or "Wonderful" |
| `nightly_price` | String | Nightly price text |
| `total_price` | String | Total stay price text |
| `strikeout_price` | String | Previous price text when available |
| `taxes_and_fees_note` | String | Taxes and fees message |
| `free_cancellation` | Boolean | Whether free cancellation is indicated |
| `member_price_available` | Boolean | Whether member pricing is available |
| `vacation_rental` | Boolean | Whether the listing is a vacation rental |
| `image_url` | String | Primary listing image URL |
| `property_url` | String | Expedia hotel details URL |
| `region_id` | String | Search region ID |
| `region_name` | String | Search region name |
| `check_in` | String | Check-in date in YYYY-MM-DD format |
| `check_out` | String | Check-out date in YYYY-MM-DD format |
| `adults` | Integer | Number of adult travelers |
| `children` | Array | Child ages when applicable |
| `sort` | String | Sort mode used for the search |
| `search_id` | String | Expedia search session identifier |
| `source_url` | String | GraphQL endpoint URL used for extraction |
| `operation_name` | String | GraphQL operation name used |
| `scraped_at` | String | ISO timestamp when the record was captured |

## Usage Examples

### Basic Run

Collect the first set of hotel listings from an Expedia destination:

```json
{
  "startUrl": "https://www.expedia.com/Hotel-Search?regionId=6139104&destination=London%2C%20United%20Kingdom%20%28LON-All%20Airports%29",
  "resultsWanted": 20,
  "maxPages": 8
}
```

### Messy URL Recovery

The Actor strips wrapper characters, tracking junk, and stale URL fragments before the first request. It also injects fresh future dates and sane occupancy defaults when they are missing:

```json
{
  "startUrl": "<https://www.expedia.com/Hotel-Search?destination=London%2C%20United%20Kingdom%20%28LON-All%20Airports%29&regionId=6139104&sort=RECOMMENDED>",
  "resultsWanted": 40,
  "maxPages": 10
}
```

### Higher Volume Collection

Increase the result limit and page depth for destinations with more inventory:

```json
{
  "startUrl": "https://www.expedia.com/Hotel-Search?regionId=6139104&destination=London%2C%20United%20Kingdom%20%28LON-All%20Airports%29",
  "resultsWanted": 100,
  "maxPages": 15
}
```

### Proxy Optimized Run

Residential proxies improve reliability on Expedia result pages:

```json
{
  "startUrl": "https://www.expedia.com/Hotel-Search?regionId=6139104&destination=London%2C%20United%20Kingdom%20%28LON-All%20Airports%29",
  "resultsWanted": 30,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## Sample Output

```json
{
  "hotel_id": "42297074",
  "hotel_name": "Zedwell Piccadilly Circus",
  "city": "West End",
  "star_rating": 3,
  "guest_rating": 7.6,
  "guest_rating_out_of_five": 3.8,
  "review_count": 5892,
  "review_label": "Good",
  "nightly_price": "$142 nightly",
  "total_price": "$171",
  "strikeout_price": "$201",
  "taxes_and_fees_note": "Total with taxes and fees",
  "free_cancellation": false,
  "vacation_rental": false,
  "image_url": "https://images.trvl-media.com/lodging/43000000/42300000/42297100/42297074/63e4ff89.jpg?impolicy=resizecrop&ra=fit&rw=455&rh=455",
  "property_url": "https://www.expedia.com/London-Hotels-Zedwell-Piccadilly-Trocadero.h42297074.Hotel-Information",
  "region_id": "6139104",
  "region_name": "London, United Kingdom (LON-All Airports)",
  "check_in": "2026-08-21",
  "check_out": "2026-08-22",
  "adults": 2,
  "sort": "RECOMMENDED",
  "search_id": "cb481b56-f4b8-4f49-8d4a-9ab98d138245",
  "source_url": "https://www.expedia.com/graphql",
  "operation_name": "RemainderListings",
  "scraped_at": "2026-07-22T16:16:50.038Z"
}
```

## Tips for Best Results

- Start with `resultsWanted: 20` to validate the destination and timing before scaling up.
- Use complete Expedia Hotel-Search URLs. The Actor repairs missing dates and occupancy, but a valid region or destination must be present.
- Residential proxies improve run stability on Expedia search pages. Enable them in `proxyConfiguration` for production runs.
- If pasted dates are missing or already in the past, the Actor shifts them to a safe future stay automatically.
- Not every listing exposes every field. Empty values are removed from dataset records automatically.

## Integrations

- **Google Sheets** - Export pricing and rating snapshots for spreadsheet analysis.
- **Airtable** - Build searchable hotel and destination tracking tables.
- **Looker Studio** - Visualize market trends across city and date combinations.
- **Webhooks** - Trigger downstream enrichment or alerting pipelines.
- **API** - Access datasets programmatically from your own systems.

### Export Formats

- **JSON** - Best for APIs and programmatic pipelines.
- **CSV** - Best for spreadsheet workflows.
- **Excel** - Best for reporting teams.
- **XML** - Best for legacy integrations.

## Frequently Asked Questions

### Can I export the data to CSV or Excel?

Yes. Apify datasets can be downloaded in CSV, Excel, JSON, XML, and other supported formats directly from Apify Console.

### Why are some fields missing in certain records?

Listings do not always expose the same details on every Expedia Hotel-Search page. The Actor keeps only non-empty values in each record.

### Can I scrape multiple Expedia destinations?

Yes. Run one job per destination URL or schedule separate runs with different input payloads.

### How many listings can I collect per run?

It depends on the destination inventory and load depth. Increase `maxPages` and `resultsWanted` for larger collections.

### Does the Actor remove duplicate listings?

Yes. Duplicate listing cards are filtered by hotel ID so each property appears once per run.

### What happens if my Expedia URL is incomplete or messy?

The Actor normalizes Expedia URLs by stripping wrapper characters, tracking parameters, and stale query values. It injects missing dates, default occupancy, and a sort mode. If Expedia rejects the first bootstrap attempt, the Actor retries with a refreshed session.

### Can I run this Actor on a schedule?

Yes. You can schedule the Actor in Apify Console to refresh Expedia hotel data hourly, daily, weekly, or at another interval.

### Is this Actor suitable for non-technical users?

Yes. The Actor can be run from Apify Console with a single URL input, and the output can be downloaded without writing code.

### Is it legal to scrape Expedia hotel data?

Scraping public web data may be legal, but you are responsible for complying with applicable laws, Expedia's terms of service, and responsible data usage practices.

## Related Actors

- [Booking.com Scraper](https://apify.com/shahidirfan/booking-com-scraper)
- [Agoda Hotels Scraper](https://apify.com/shahidirfan/agoda-hotels-scraper)
- [Trivago Hotels Scraper](https://apify.com/shahidirfan/trivago-hotels-scraper)

## Support

For issues, feature requests, or custom Actor work, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor is designed for legitimate data collection from publicly available Expedia search pages. Users are responsible for using the data responsibly and complying with applicable laws and website terms.
