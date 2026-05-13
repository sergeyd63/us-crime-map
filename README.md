# US Crime Statistics Map

Interactive React/TypeScript map with a Node/Express proxy for official FBI Crime Data API refreshes.

## Data Source

- State statistics use the current FBI Crime Data API summarized state endpoints:
  `https://api.usa.gov/crime/fbi/cde/summarized/state/{STATE}/{OFFENSE}`
- County statistics use the official FBI CIUS Table 10 ZIP from the CDE signed-download endpoint:
  `https://api.usa.gov/crime/fbi/cde/s3/signedurl?key=_all/Table10.zip`
- County population uses the U.S. Census Bureau county population estimates CSV:
  `https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv`
- Race and ethnicity demographics use U.S. Census Bureau ACS 5-Year detailed tables `B02001` and `B03003`.
- Color coding can use either a selected crime rate or the dominant race/ethnicity group by population share. Crime rates can be shown as a percentage of population or per 100,000 people.
- County rows with no reported Table 10 offense cells are excluded from county calculations and color scaling. Reported zeroes are still included. The FBI notes Table 10 is county agency data, not complete county totals.

The FBI API requires a data.gov API key for normal use. `DEMO_KEY` is too limited for a full 51-state refresh. ACS demographic refreshes require a Census API key.

## Run Locally

```bash
npm install
cp .env.example .env
```

Add your API key to `.env`:

```bash
FBI_API_KEY=your_api_data_gov_key
CENSUS_API_KEY=your_census_api_key
```

Start the app:

```bash
npm run dev
```

Open `http://localhost:5173`.

## Refresh Behavior

- Official source responses are stored locally in `.cache/crime/*.json`.
- The backend reuses local data for at least 24 hours, including when the UI refresh button is clicked.
- Set `CACHE_TTL_MINUTES` above `1440` only if you want a longer local cache window.
- Set `CRIME_DATA_YEAR` if the FBI publishes a newer CIUS table and you want to target it.
- Set `CENSUS_ACS_YEAR` to change the ACS 5-year vintage used for race and ethnicity demographics.
- Set `COUNTY_POPULATION_URL` if the Census publishes a newer county population file with a different path.
- Set `VITE_BUYMEACOFFEE_URL` to your Buy Me a Coffee profile URL for the toolbar support link.

## Interaction

- State split: click a state to zoom the map to it and show statistics in the right panel.
- County split: click a state first to zoom into counties, then click a county to show county statistics.
- Hovering any state or county slightly enlarges it and shows the mapped value. Use the `Crime` / `Race` toggle to switch the color source; race mode shows a categorical color legend for each race/ethnicity group.
- The right panel includes race/ethnicity demographics when `CENSUS_API_KEY` is configured.
