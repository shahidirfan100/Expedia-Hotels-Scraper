# Expedia Hotels Listings Scraper

Extract structured Expedia hotel listing data from Hotel-Search result pages. Collect prices, ratings, property links, listing metadata, and search context for analysis, monitoring, and travel intelligence workflows.

---

## Features

- **Hotel listings extraction** - Capture Expedia search-result cards with core property metadata.
- **Rich pricing details** - Collect nightly, total, and strikeout prices when available.
- **Rating and review context** - Include stars, guest score, and review counts.
- **Clean output records** - Automatically omit empty values instead of storing null fields.
- **Duplicate-safe collection** - Save each hotel once per run using hotel ID deduplication.

---

## Use Cases

### Price Monitoring
Track hotel prices across destinations and travel windows to identify spikes, drops, and seasonal movement.

### Market Comparison
Benchmark competing properties in the same region by rating, review volume, and price visibility.

### Travel Dataset Building
Generate structured hotel datasets for BI dashboards, forecasting, and internal travel tools.

### Offer Intelligence
Analyze member-price indicators, strikeout price patterns, and cancellation signals at listing level.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | Expedia London Hotel-Search URL | Direct Expedia Hotel-Search URL. If provided, it overrides manual filters. |
| `regionId` | String | No | `6139104` | Expedia region ID used when `startUrl` is not provided. |
| `destination` | String | No | `London, United Kingdom (LON-All Airports)` | Destination label for the search query. |
| `checkInDate` | String | No | `2026-04-19` | Check-in date in `YYYY-MM-DD` format. |
| `checkOutDate` | String | No | `2026-04-20` | Check-out date in `YYYY-MM-DD` format. |
| `adults` | Integer | No | `2` | Number of adults in room 1. |
| `children` | String | No | `""` | Comma-separated child ages for room 1 (for example `4,8`). |
| `sort` | String | No | `RECOMMENDED` | Search sort mode. |
| `results_wanted` | Integer | No | `20` | Maximum number of listings to save. |
| `max_pages` | Integer | No | `8` | Maximum result-load rounds to attempt. |
| `proxyConfiguration` | Object | No | Residential Apify Proxy | Proxy settings for stable extraction. |

---

## Output Data

Each dataset item can contain:

| Field | Type | Description |
|-------|------|-------------|
| `hotel_id` | String | Expedia hotel ID |
| `hotel_name` | String | Property name from search card |
| `city` | String | City or area label |
| `star_rating` | Number | Official hotel star rating |
| `guest_rating` | Number | Guest score shown in listing card |
| `guest_rating_out_of_five` | Number | Guest score in 5-point representation |
| `review_count` | Integer | Number of guest reviews |
| `review_label` | String | Rating label such as "Very Good" |
| `nightly_price` | String | Nightly price text |
| `total_price` | String | Total stay price text |
| `strikeout_price` | String | Previous price text when present |
| `taxes_and_fees_note` | String | Taxes and fees message |
| `free_cancellation` | Boolean | Free cancellation signal when available |
| `member_price_available` | Boolean | Member price indicator |
| `vacation_rental` | Boolean | Vacation rental marker |
| `image_url` | String | Primary listing image URL |
| `property_url` | String | Expedia hotel detail URL |
| `region_id` | String | Search region ID |
| `region_name` | String | Search region name |
| `check_in` | String | Check-in date |
| `check_out` | String | Check-out date |
| `adults` | Integer | Adults in room 1 |
| `children` | Array | Child ages in room 1 |
| `sort` | String | Sort mode used in request |
| `search_id` | String | Expedia search identifier |
| `source_url` | String | Source endpoint URL |
| `operation_name` | String | Listing operation name |
| `scraped_at` | String | ISO timestamp of capture |

---

## Usage Examples

### Basic Run

```json
{
	"startUrl": "https://www.expedia.com/Hotel-Search?regionId=6139104&destination=London%2C%20United%20Kingdom%20%28LON-All%20Airports%29&adults=2&children=&sort=RECOMMENDED&useRewards=false&semdtl=&userIntent=&vip=false&startDate=2026-04-19&endDate=2026-04-20&theme=&latLong&pwaDialog=&daysInFuture&stayLength",
	"results_wanted": 20,
	"max_pages": 8
}
```

### Manual Search Parameters

```json
{
	"regionId": "6139104",
	"destination": "London, United Kingdom (LON-All Airports)",
	"checkInDate": "2026-04-19",
	"checkOutDate": "2026-04-20",
	"adults": 2,
	"children": "6",
	"sort": "RECOMMENDED",
	"results_wanted": 40,
	"max_pages": 10
}
```

### Proxy-Optimized Run

```json
{
	"startUrl": "https://www.expedia.com/Hotel-Search?regionId=6139104&destination=London%2C%20United%20Kingdom%20%28LON-All%20Airports%29&adults=2&children=&sort=RECOMMENDED&useRewards=false&semdtl=&userIntent=&vip=false&startDate=2026-04-19&endDate=2026-04-20&theme=&latLong&pwaDialog=&daysInFuture&stayLength",
	"results_wanted": 30,
	"proxyConfiguration": {
		"useApifyProxy": true,
		"apifyProxyGroups": ["RESIDENTIAL"]
	}
}
```

---

## Sample Output

```json
{
	"hotel_id": "5173526",
	"hotel_name": "Point A London Kings Cross - St Pancras",
	"city": "London",
	"star_rating": 2.5,
	"guest_rating": 8.4,
	"guest_rating_out_of_five": 4.2,
	"review_count": 2888,
	"review_label": "Very Good",
	"nightly_price": "$101 nightly",
	"total_price": "$121",
	"strikeout_price": "$135",
	"taxes_and_fees_note": "Total with taxes and fees",
	"free_cancellation": false,
	"member_price_available": true,
	"vacation_rental": false,
	"image_url": "https://images.trvl-media.com/lodging/6000000/5180000/5173600/5173526/24292dd5.jpg?impolicy=resizecrop&ra=fit&rw=455&rh=455",
	"property_url": "https://www.expedia.com/London-Hotels-Point-A-Hotel-London-Kings-Cross-St-Pancras.h5173526.Hotel-Information?...",
	"region_id": "6139104",
	"region_name": "London, United Kingdom (LON-All Airports)",
	"check_in": "2026-04-19",
	"check_out": "2026-04-20",
	"adults": 2,
	"children": [],
	"sort": "RECOMMENDED",
	"search_id": "5546132f-1251-4ae8-b52a-9ad927c5ee32",
	"source_url": "https://www.expedia.com/graphql",
	"operation_name": "PropertyListingQuery",
	"scraped_at": "2026-04-06T13:32:11.102Z"
}
```

---

## Tips For Best Results

### Start With Default Volume
- Use `results_wanted: 20` first to validate destination and timing.
- Increase volume only after verifying stable output.

### Use Residential Proxies
- Residential routing improves reliability on protected travel pages.
- Keep request volume moderate when collecting large destination sets.

### Keep Dates Valid
- Use valid future check-in/check-out values when building URLs from parameters.
- Ensure check-out is after check-in.

### Expect Field Variance
- Not every listing exposes every field.
- Empty/null fields are removed automatically from dataset records.

---

## Integrations

- **Google Sheets** - Export pricing and rating snapshots for analysts.
- **Airtable** - Build searchable destination and hotel tracking tables.
- **Looker Studio** - Visualize market trends across city/date combinations.
- **Webhooks** - Trigger downstream enrichment or alerting pipelines.

### Export Formats

- **JSON** - Best for APIs and programmatic pipelines.
- **CSV** - Best for spreadsheet workflows.
- **Excel** - Best for reporting teams.
- **XML** - Best for legacy integrations.

---

## Frequently Asked Questions

### Why are some fields missing in certain records?
Listings do not always expose the same details. The actor keeps only non-empty values.

### Can I scrape multiple destinations?
Yes. Run one job per destination URL or schedule separate runs with different input payloads.

### How many listings can I collect?
It depends on destination inventory and load depth. Increase `max_pages` and `results_wanted` as needed.

### Why does proxy matter?
Some Expedia result pages apply request-rate controls. Residential proxies improve run stability.

### Does the actor remove duplicates?
Yes. Duplicate listing cards are filtered by hotel ID.

---

## Support

For issues or feature requests, use Apify Console support channels.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Schedules](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection and analysis workflows. You are responsible for complying with website terms, applicable laws, and responsible data usage practices.