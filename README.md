# US Crime Statistics Map

Interactive React/TypeScript map with a Node/Express proxy for official FBI Crime Data API refreshes.

## Data Source

- State statistics use the current FBI Crime Data API summarized state endpoints:
  `https://api.usa.gov/crime/fbi/cde/summarized/state/{STATE}/{OFFENSE}`
- County statistics use the official FBI CIUS Table 10 ZIP from the CDE signed-download endpoint:
  `https://api.usa.gov/crime/fbi/cde/s3/signedurl?key=_all/Table10.zip`
- County population uses the U.S. Census Bureau county population estimates CSV:
  `https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv`
- Color coding uses each selected offense count as a percentage of the state or county population. The FBI notes Table 10 is county agency data, not complete county totals.

The FBI API requires a data.gov API key for normal use. `DEMO_KEY` is too limited for a full 51-state refresh.

## Run Locally

```bash
npm install
cp .env.example .env
```

Add your API key to `.env`:

```bash
FBI_API_KEY=your_api_data_gov_key
```

Start the app:

```bash
npm run dev
```

Open `http://localhost:5173`.

## Refresh Behavior

- The UI refresh button calls the backend with `?refresh=1` and pulls from the official FBI API again.
- Normal loads use `.cache/crime/*.json` for `CACHE_TTL_MINUTES`, defaulting to 24 hours.
- Set `CACHE_TTL_MINUTES=0` if you want browser reloads to always refresh from the FBI API.
- Set `CRIME_DATA_YEAR` if the FBI publishes a newer CIUS table and you want to target it.
- Set `COUNTY_POPULATION_URL` if the Census publishes a newer county population file with a different path.

## Interaction

- State split: click a state to zoom the map to it and show statistics in the right panel.
- County split: click a state first to zoom into counties, then click a county to show county statistics.
- Hovering any state or county slightly enlarges it and shows the mapped rate in the native SVG tooltip.
