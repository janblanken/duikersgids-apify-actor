# Duikersgids.nl Dive Logs Scraper (Apify Actor)

An Apify Actor built with **TypeScript**, **Apify SDK v3**, and **Crawlee (`CheerioCrawler`)** that scrapes dive logs (**logberichten**) and dive spot GPS metadata from [www.duikersgids.nl](https://www.duikersgids.nl/logberichten).

---

## Features

1. **Chronological All-Logs Pagination (`/logberichten`)**
   * Automatically paginates backwards through `/logberichten` using adaptive date windows (`DD-MM-YYYY`).
   * Uses a universal 3-character wildcard (`%25%25%25`) when `searchKeyword` is left blank so **every dive log** is returned in chronological order without needing a specific search keyword.
   * Automatically splits busy date windows if a window reaches the 100-log page cap so zero dive logs are missed.
2. **Instant Dive Spot GPS Enrichment (`getDiveSpots`)**
   * Loads the full Duikersgids directory of **1,868 dive spots** (`stekId`, `reference`, `latitude`, `longitude`, `spotUrl`, `isPremium`) in a single request at startup and enriches every scraped dive log.
3. **Optional Deep Detail Scraping (`scrapeLogDetails: true`)**
   * Optionally visits each individual `/logbericht/<spot>/<id>/<user>` page to extract full-resolution dive photos (`1024x768`), diver profile URLs, avatars, and country/province names.
4. **Specific Dive Spot Scraping (`spotUrls`)**
   * Optionally pass specific dive spot URLs (e.g. `https://www.duikersgids.nl/eiland-4`) to scrape the latest logs for those locations.

---

## Input Parameters

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `maxItems` | `integer` | `200` | Maximum number of dive logs to scrape (`0` = unlimited within date range). |
| `searchKeyword` | `string` | `""` | Optional keyword filter (min 3 chars, e.g. `"zeepaardje"`, `"meerval"`). Leave empty for **all** dive logs. |
| `dateFrom` | `string` | `""` | Earliest dive date (`DD-MM-YYYY`). Defaults to 1 year ago. |
| `dateTo` | `string` | `""` | Latest dive date (`DD-MM-YYYY`). Defaults to today. |
| `windowDays` | `integer` | `7` | Number of days per date-range request window. Automatically subdivides if a window hits 100 logs. |
| `spotUrls` | `array` | `[]` | Optional list of specific dive spot URLs (e.g. `https://www.duikersgids.nl/eiland-4`). |
| `scrapeLogDetails` | `boolean` | `false` | Visit each individual `/logbericht/...` page to fetch attached photos and diver profile links. |
| `enrichWithSpotCoordinates` | `boolean` | `true` | Attach `stekId`, `latitude`, `longitude`, and `spotUrl` from the Duikersgids spots API. |

---

## Sample Output Record

```json
{
  "logId": "57633",
  "hashLogId": "ud43U0qwrkA",
  "date": "2026-10-16",
  "dateRaw": "16-10-26",
  "spotName": "BERGSE DIEPSLUIS OESTERDAM",
  "spotSlug": "bergse-diepsluis-oesterdam",
  "stekId": "13",
  "latitude": 51.516700744629,
  "longitude": 4.172709941864,
  "countryRegion": "Nederland, Zeeland",
  "diverName": "Anja van Dijk",
  "diverProfileUrl": null,
  "diverAvatarUrl": null,
  "ratingStars": 4,
  "visibilityMeters": 4,
  "waterTemperatureCelsius": 15,
  "temperatureDepthMeters": 10,
  "hasPhoto": false,
  "photos": [],
  "remarks": "Zeepaardjes gespot, vele sepia's, gladde wratslakken, gr. wierslakken enz",
  "logUrl": "https://www.duikersgids.nl/logbericht/bergse-diepsluis-oesterdam/57633/anja-van-dijk",
  "spotUrl": "https://www.duikersgids.nl/bergse-diepsluis-oesterdam",
  "scrapedAt": "2026-10-16T18:45:00.000Z"
}
```

---

## Running Locally

```bash
npm install
npm run start
```

Results are stored in `./storage/datasets/default/`.

---

## Deploying to Apify

### Option A: Deploy via GitHub (Recommended)
1. Push this directory to a GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Duikersgids Dive Logs Apify Actor"
   gh repo create duikersgids-apify-actor --public --source=. --remote=origin --push
   ```
2. In **Apify Console** → **Actors** → **Create new** → **Link Git Repository**.
3. Paste your GitHub repository URL and click **Build**.

### Option B: Deploy via Apify CLI
```bash
npx apify-cli login
npx apify-cli push
```
