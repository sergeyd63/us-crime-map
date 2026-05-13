import AdmZip from "adm-zip";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import xlsx from "xlsx";
import { STATE_BY_ABBR, US_STATES, type UsState } from "./usStates.js";

export type JurisdictionStats = {
  id: string;
  fips: string;
  abbr?: string;
  name: string;
  kind: "state" | "county";
  year: number | null;
  population: number | null;
  totalCrime: number | null;
  violentCrime: number | null;
  propertyCrime: number | null;
  homicide: number | null;
  rape: number | null;
  robbery: number | null;
  aggravatedAssault: number | null;
  burglary: number | null;
  larceny: number | null;
  motorVehicleTheft: number | null;
  arson: number | null;
  totalRate: number | null;
  violentRate: number | null;
  propertyRate: number | null;
  hasData: boolean;
  demographics?: JurisdictionDemographics;
  reportingAgencies?: number;
  caveats?: string | null;
  source: string;
  refreshedAt: string;
};

export type DemographicGroup = {
  key: string;
  label: string;
  count: number | null;
  percent: number | null;
};

export type JurisdictionDemographics = {
  year: number;
  source: string;
  sourceUrl: string;
  raceEthnicity: DemographicGroup[];
  caveats: string[];
};

type CacheEnvelope<T> = {
  refreshedAt: string;
  source: string;
  data: T;
};

type SummarizedResponse = {
  offenses?: {
    actuals?: Record<string, Record<string, unknown>>;
    rates?: Record<string, Record<string, unknown>>;
  };
  populations?: {
    population?: Record<string, Record<string, unknown>>;
  };
};

type CensusApiRow = Record<string, string | undefined>;

type CountyTopology = {
  objects: {
    counties: {
      geometries: Array<{
        id: string | number;
        properties?: {
          name?: string;
        };
      }>;
    };
  };
};

type SummarizedOffenseCode = "V" | "P" | "HOM" | "RPE" | "ROB" | "ASS" | "BUR" | "LAR" | "MVT" | "ARS";

const require = createRequire(import.meta.url);
const countiesTopology = require("us-atlas/counties-10m.json") as CountyTopology;

const API_BASE = (process.env.FBI_API_BASE || "https://api.usa.gov/crime/fbi/cde")
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");
const API_KEY = process.env.FBI_API_KEY || process.env.DATA_GOV_API_KEY || process.env.API_KEY || "";
const CENSUS_API_KEY = process.env.CENSUS_API_KEY || process.env.CENSUS_KEY || "";
const DATA_YEAR = Number(process.env.CRIME_DATA_YEAR || "2024");
const ACS_YEAR = Number(process.env.CENSUS_ACS_YEAR || DATA_YEAR);
const DAILY_CACHE_TTL_MINUTES = 1440;
const configuredCacheTtlMinutes = Number(process.env.CACHE_TTL_MINUTES || DAILY_CACHE_TTL_MINUTES);
const CACHE_TTL_MINUTES =
  Number.isFinite(configuredCacheTtlMinutes) && configuredCacheTtlMinutes > DAILY_CACHE_TTL_MINUTES
    ? configuredCacheTtlMinutes
    : DAILY_CACHE_TTL_MINUTES;
const CACHE_ROOT = path.join(process.cwd(), ".cache", "crime");
const OFFICIAL_SOURCE =
  "FBI Crime Data API, FBI CIUS publication tables, U.S. Census Bureau county population estimates, and U.S. Census Bureau ACS demographics";
const TABLE_10_KEY = "_all/Table10.zip";
const COUNTY_POPULATION_URL =
  process.env.COUNTY_POPULATION_URL ||
  `https://www2.census.gov/programs-surveys/popest/datasets/2020-${DATA_YEAR}/counties/totals/co-est${DATA_YEAR}-alldata.csv`;
const CENSUS_API_BASE = "https://api.census.gov/data";
const ACS_DEMOGRAPHICS_SOURCE = `U.S. Census Bureau ${ACS_YEAR} ACS 5-Year detailed tables B02001 and B03003`;
const ACS_DEMOGRAPHICS_SOURCE_URL = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5`;
const DEMOGRAPHICS_CACHE_MODE = CENSUS_API_KEY ? "with-census-key" : "missing-census-key";
const RACE_ETHNICITY_VARIABLES = [
  "B02001_001E",
  "B02001_002E",
  "B02001_003E",
  "B02001_004E",
  "B02001_005E",
  "B02001_006E",
  "B02001_007E",
  "B02001_008E",
  "B03003_003E"
] as const;

class OfficialApiError extends Error {
  status: number;
  url: string;

  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = "OfficialApiError";
    this.status = status;
    this.url = url;
  }
}

const cachePath = (key: string) => path.join(CACHE_ROOT, `${key}.json`);

const rate = (count: number | null, population: number | null) => {
  if (count == null || population == null || population <= 0) {
    return null;
  }

  return (count / population) * 100000;
};

const numberOrNull = (value: unknown): number | null => {
  if (value == null || value === "") {
    return null;
  }

  const numberValue = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numberValue) ? numberValue : null;
};

const percent = (count: number | null, total: number | null) => {
  if (count == null || total == null || total <= 0) {
    return null;
  }

  return (count / total) * 100;
};

const sumSeries = (series?: Record<string, unknown>): number | null =>
  series ? Object.values(series).reduce<number>((total, value) => total + (numberOrNull(value) || 0), 0) : null;

const latestValue = (series?: Record<string, unknown>) => {
  if (!series) {
    return null;
  }

  const keys = Object.keys(series).sort();
  return numberOrNull(series[keys[keys.length - 1]]);
};

const normalizeName = (value: string) =>
  value
    .toUpperCase()
    .replace(/\bSAINT\b/g, "ST")
    .replace(/\bST\.\b/g, "ST")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const countyFipsByStateAndName = new Map(
  countiesTopology.objects.counties.geometries.map((geometry) => {
    const fips = String(geometry.id).padStart(5, "0");
    return [`${fips.slice(0, 2)}:${normalizeName(geometry.properties?.name || "")}`, fips];
  })
);
const countyNameByFips = new Map(
  countiesTopology.objects.counties.geometries.map((geometry) => [
    String(geometry.id).padStart(5, "0"),
    geometry.properties?.name || String(geometry.id).padStart(5, "0")
  ])
);

const stateNameToRef = new Map(US_STATES.map((state) => [normalizeName(state.name), state]));

const redactUrl = (url: URL) => {
  const copy = new URL(url.toString());
  if (copy.searchParams.has("api_key")) {
    copy.searchParams.set("api_key", "REDACTED");
  }
  if (copy.searchParams.has("API_KEY")) {
    copy.searchParams.set("API_KEY", "REDACTED");
  }
  return copy.toString();
};

const redactCensusUrl = (url: URL) => {
  const copy = new URL(url.toString());
  if (copy.searchParams.has("key")) {
    copy.searchParams.set("key", "REDACTED");
  }
  return copy.toString();
};

const withApiKey = (url: URL) => {
  if (!url.searchParams.has("api_key") && !url.searchParams.has("API_KEY")) {
    url.searchParams.set("API_KEY", API_KEY);
  }
};

const officialUrl = (endpoint: string, params: Record<string, string | number | undefined> = {}) => {
  const url = new URL(`${API_BASE}/${endpoint.replace(/^\/+/, "")}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  withApiKey(url);
  return url;
};

async function fetchOfficial<T>(endpoint: string, params: Record<string, string | number | undefined> = {}) {
  if (!API_KEY) {
    throw new OfficialApiError(
      401,
      "",
      "Missing FBI_API_KEY. Add a data.gov API key to .env before refreshing official FBI crime data."
    );
  }

  const url = officialUrl(endpoint, params);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    const detail =
      response.status === 429
        ? "FBI API rate limit reached. Try after the retry window."
        : body.slice(0, 240) || response.statusText;
    throw new OfficialApiError(response.status, redactUrl(url), detail);
  }

  return (await response.json()) as T;
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/csv,text/plain"
    }
  });

  if (!response.ok) {
    throw new OfficialApiError(response.status, url, `Unable to download official data: ${response.statusText}`);
  }

  return response.text();
}

async function fetchCensusRows(params: Record<string, string>) {
  if (!CENSUS_API_KEY) {
    throw new OfficialApiError(
      401,
      "",
      "Missing CENSUS_API_KEY. Add a Census API key to .env to load official ACS race and ethnicity demographics."
    );
  }

  const url = new URL(`${CENSUS_API_BASE}/${ACS_YEAR}/acs/acs5`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  url.searchParams.set("key", CENSUS_API_KEY);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });
  const body = await response.text();

  if (!response.ok) {
    throw new OfficialApiError(response.status, redactCensusUrl(url), body.slice(0, 240) || response.statusText);
  }

  let table: unknown;
  try {
    table = JSON.parse(body);
  } catch {
    const detail = body.includes("Invalid Key")
      ? "Census API rejected CENSUS_API_KEY."
      : "Census API returned a non-JSON response.";
    throw new OfficialApiError(502, redactCensusUrl(url), detail);
  }

  if (!Array.isArray(table) || table.length === 0 || !Array.isArray(table[0])) {
    throw new OfficialApiError(502, redactCensusUrl(url), "Census API returned an unexpected table shape.");
  }

  const [header, ...rows] = table as string[][];
  return rows.map((row) =>
    Object.fromEntries(header.map((column, index) => [column, row[index]])) as CensusApiRow
  );
}

async function readCache<T>(key: string, _refresh: boolean) {
  try {
    const raw = await readFile(cachePath(key), "utf8");
    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    const ageMs = Date.now() - Date.parse(envelope.refreshedAt);
    const ttlMs = CACHE_TTL_MINUTES * 60 * 1000;

    if (Number.isFinite(ageMs) && ageMs <= ttlMs) {
      return envelope;
    }
  } catch {
    return null;
  }

  return null;
}

async function writeCache<T>(key: string, data: T) {
  await mkdir(CACHE_ROOT, { recursive: true });
  const envelope: CacheEnvelope<T> = {
    refreshedAt: new Date().toISOString(),
    source: OFFICIAL_SOURCE,
    data
  };

  await writeFile(cachePath(key), JSON.stringify(envelope, null, 2));
  return envelope;
}

const getOffenseSeries = (payload: SummarizedResponse, locationName: string) => {
  const key = Object.keys(payload.offenses?.actuals || {}).find(
    (seriesName) => seriesName.includes(locationName) && seriesName.endsWith(" Offenses")
  );

  return key ? payload.offenses?.actuals?.[key] : undefined;
};

const getPopulation = (payload: SummarizedResponse, locationName: string): number | null =>
  latestValue(payload.populations?.population?.[locationName]);

const unavailableDemographics = (caveat: string): JurisdictionDemographics => ({
  year: ACS_YEAR,
  source: ACS_DEMOGRAPHICS_SOURCE,
  sourceUrl: ACS_DEMOGRAPHICS_SOURCE_URL,
  raceEthnicity: [],
  caveats: [caveat]
});

const demographicGroup = (key: string, label: string, count: number | null, total: number | null): DemographicGroup => ({
  key,
  label,
  count,
  percent: percent(count, total)
});

function buildDemographics(row: CensusApiRow): JurisdictionDemographics {
  const total = numberOrNull(row.B02001_001E);

  return {
    year: ACS_YEAR,
    source: ACS_DEMOGRAPHICS_SOURCE,
    sourceUrl: ACS_DEMOGRAPHICS_SOURCE_URL,
    raceEthnicity: [
      demographicGroup("white", "White alone", numberOrNull(row.B02001_002E), total),
      demographicGroup("black", "Black or African American alone", numberOrNull(row.B02001_003E), total),
      demographicGroup(
        "aian",
        "American Indian and Alaska Native alone",
        numberOrNull(row.B02001_004E),
        total
      ),
      demographicGroup("asian", "Asian alone", numberOrNull(row.B02001_005E), total),
      demographicGroup(
        "nhpi",
        "Native Hawaiian and Other Pacific Islander alone",
        numberOrNull(row.B02001_006E),
        total
      ),
      demographicGroup("other", "Some other race alone", numberOrNull(row.B02001_007E), total),
      demographicGroup("twoOrMore", "Two or more races", numberOrNull(row.B02001_008E), total),
      demographicGroup("hispanic", "Hispanic or Latino ethnicity", numberOrNull(row.B03003_003E), total)
    ],
    caveats: [
      "Hispanic or Latino is an ethnicity collected separately from race, so it can overlap with race groups."
    ]
  };
}

async function fetchDemographicsByFips(kind: "state" | "county", refresh: boolean) {
  const cacheKey = `demographics-${kind}-${ACS_YEAR}-${DEMOGRAPHICS_CACHE_MODE}-v2`;
  const cached = await readCache<Record<string, JurisdictionDemographics>>(cacheKey, refresh);
  if (cached) {
    return new Map(Object.entries(cached.data));
  }

  const rows = await fetchCensusRows({
    get: ["NAME", ...RACE_ETHNICITY_VARIABLES].join(","),
    for: kind === "state" ? "state:*" : "county:*",
    ...(kind === "county" ? { in: "state:*" } : {})
  });

  const demographicsByFips = new Map<string, JurisdictionDemographics>();
  rows.forEach((row) => {
    const state = String(row.state || "").padStart(2, "0");
    const county = row.county != null ? String(row.county).padStart(3, "0") : "";
    const fips = kind === "state" ? state : `${state}${county}`;

    if (fips.trim()) {
      demographicsByFips.set(fips, buildDemographics(row));
    }
  });

  await writeCache(cacheKey, Object.fromEntries(demographicsByFips));
  return demographicsByFips;
}

async function withDemographics(
  stats: JurisdictionStats[],
  kind: "state" | "county",
  refresh: boolean
): Promise<JurisdictionStats[]> {
  try {
    const demographicsByFips = await fetchDemographicsByFips(kind, refresh);
    return stats.map((stat) => ({
      ...stat,
      demographics:
        demographicsByFips.get(stat.fips) ||
        unavailableDemographics("Official ACS race and ethnicity demographics were not returned for this area.")
    }));
  } catch (error) {
    const caveat = error instanceof Error ? error.message : "Unable to load official ACS demographics.";
    return stats.map((stat) => ({
      ...stat,
      demographics: unavailableDemographics(caveat)
    }));
  }
}

async function withCountyDemographics(
  stats: JurisdictionStats[],
  refresh: boolean,
  refreshedAt: string
): Promise<JurisdictionStats[]> {
  try {
    const demographicsByFips = await fetchDemographicsByFips("county", refresh);
    const enrichedByFips = new Map<string, JurisdictionStats>();

    stats.forEach((stat) => {
      enrichedByFips.set(stat.fips, {
        ...stat,
        demographics:
          demographicsByFips.get(stat.fips) ||
          unavailableDemographics("Official ACS race and ethnicity demographics were not returned for this area.")
      });
    });

    demographicsByFips.forEach((demographics, fips) => {
      if (enrichedByFips.has(fips) || !countyNameByFips.has(fips)) {
        return;
      }

      enrichedByFips.set(fips, {
        ...countyWithoutCrimeData(fips, countyNameByFips.get(fips) || fips, refreshedAt),
        demographics
      });
    });

    return [...enrichedByFips.values()];
  } catch (error) {
    const caveat = error instanceof Error ? error.message : "Unable to load official ACS demographics.";
    return stats.map((stat) => ({
      ...stat,
      demographics: unavailableDemographics(caveat)
    }));
  }
}

async function fetchStateSummary(state: UsState, offense: SummarizedOffenseCode) {
  return fetchOfficial<SummarizedResponse>(`/summarized/state/${state.abbr}/${offense}`, {
    from: `01-${DATA_YEAR}`,
    to: `12-${DATA_YEAR}`
  });
}

async function fetchStateStat(state: UsState, refreshedAt: string): Promise<JurisdictionStats> {
  const summaries = await Promise.all(
    (["V", "P", "HOM", "RPE", "ROB", "ASS", "BUR", "LAR", "MVT", "ARS"] as SummarizedOffenseCode[]).map(
      async (offense) => [offense, await fetchStateSummary(state, offense)] as const
    )
  );
  const summaryByOffense = new Map<SummarizedOffenseCode, SummarizedResponse>(summaries);
  const offenseTotal = (offense: SummarizedOffenseCode) =>
    sumSeries(getOffenseSeries(summaryByOffense.get(offense) || {}, state.name));
  const violentPayload = summaryByOffense.get("V") || {};
  const propertyPayload = summaryByOffense.get("P") || {};
  const violentCrime = offenseTotal("V");
  const propertyCrime = offenseTotal("P");
  const homicide = offenseTotal("HOM");
  const rape = offenseTotal("RPE");
  const robbery = offenseTotal("ROB");
  const aggravatedAssault = offenseTotal("ASS");
  const burglary = offenseTotal("BUR");
  const larceny = offenseTotal("LAR");
  const motorVehicleTheft = offenseTotal("MVT");
  const arson = offenseTotal("ARS");
  const population = getPopulation(violentPayload, state.name) || getPopulation(propertyPayload, state.name);
  const totalCrime =
    violentCrime != null || propertyCrime != null ? (violentCrime || 0) + (propertyCrime || 0) : null;

  return {
    id: state.fips,
    fips: state.fips,
    abbr: state.abbr,
    name: state.name,
    kind: "state",
    year: DATA_YEAR,
    population,
    totalCrime,
    violentCrime,
    propertyCrime,
    homicide,
    rape,
    robbery,
    aggravatedAssault,
    burglary,
    larceny,
    motorVehicleTheft,
    arson,
    totalRate: rate(totalCrime, population),
    violentRate: rate(violentCrime, population),
    propertyRate: rate(propertyCrime, population),
    hasData: totalCrime != null,
    source: OFFICIAL_SOURCE,
    refreshedAt
  };
}

export async function getStateStats(refresh = false) {
  const cached = await readCache<JurisdictionStats[]>(`states-demographics-${DEMOGRAPHICS_CACHE_MODE}-v2`, refresh);
  if (cached) {
    return cached;
  }

  const refreshedAt = new Date().toISOString();
  const stats: JurisdictionStats[] = [];

  for (const state of US_STATES) {
    stats.push(await fetchStateStat(state, refreshedAt));
  }

  return writeCache(`states-demographics-${DEMOGRAPHICS_CACHE_MODE}-v2`, await withDemographics(stats, "state", refresh));
}

const emptyCounty = (fips: string, name: string, refreshedAt: string): JurisdictionStats => ({
  id: fips,
  fips,
  name,
  kind: "county",
  year: DATA_YEAR,
  population: null,
  totalCrime: 0,
  violentCrime: 0,
  propertyCrime: 0,
  homicide: 0,
  rape: 0,
  robbery: 0,
  aggravatedAssault: 0,
  burglary: 0,
  larceny: 0,
  motorVehicleTheft: 0,
  arson: 0,
  totalRate: null,
  violentRate: null,
  propertyRate: null,
  hasData: false,
  source: OFFICIAL_SOURCE,
  refreshedAt
});

const countyWithoutCrimeData = (fips: string, name: string, refreshedAt: string): JurisdictionStats => ({
  id: fips,
  fips,
  name,
  kind: "county",
  year: DATA_YEAR,
  population: null,
  totalCrime: null,
  violentCrime: null,
  propertyCrime: null,
  homicide: null,
  rape: null,
  robbery: null,
  aggravatedAssault: null,
  burglary: null,
  larceny: null,
  motorVehicleTheft: null,
  arson: null,
  totalRate: null,
  violentRate: null,
  propertyRate: null,
  hasData: false,
  source: OFFICIAL_SOURCE,
  refreshedAt
});

async function getSignedDownloadUrl(key: string) {
  const signed = await fetchOfficial<Record<string, string>>("/s3/signedurl", { key });
  const url = signed[key];
  if (!url) {
    throw new OfficialApiError(502, "", `FBI signed download URL was not returned for ${key}`);
  }

  return url;
}

async function fetchTable10Workbook() {
  const url = await getSignedDownloadUrl(TABLE_10_KEY);
  const response = await fetch(url);
  if (!response.ok) {
    throw new OfficialApiError(response.status, "", `Unable to download FBI CIUS Table 10: ${response.statusText}`);
  }

  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
  const entry = zip
    .getEntries()
    .find((candidate) => candidate.entryName.toLowerCase().endsWith(".xlsx") && candidate.entryName.includes(String(DATA_YEAR)));

  if (!entry) {
    throw new OfficialApiError(502, "", `FBI CIUS Table 10 workbook for ${DATA_YEAR} was not found in the ZIP`);
  }

  return xlsx.read(entry.getData(), { type: "buffer" });
}

async function fetchCountyPopulations() {
  const csv = await fetchText(COUNTY_POPULATION_URL);
  const workbook = xlsx.read(csv, { type: "string" });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null });
  const populationByFips = new Map<string, number>();

  rows.forEach((row) => {
    if (String(row.SUMLEV || "").padStart(3, "0") !== "050") {
      return;
    }

    const state = String(row.STATE || "").padStart(2, "0");
    const county = String(row.COUNTY || "").padStart(3, "0");
    const population = numberOrNull(row[`POPESTIMATE${DATA_YEAR}`]);

    if (population != null) {
      populationByFips.set(`${state}${county}`, population);
    }
  });

  return populationByFips;
}

function applyCountyRates(county: JurisdictionStats) {
  county.totalRate = rate(county.totalCrime, county.population);
  county.violentRate = rate(county.violentCrime, county.population);
  county.propertyRate = rate(county.propertyCrime, county.population);
}

async function parseTable10Rows(refreshedAt: string) {
  const [workbook, populationByFips] = await Promise.all([fetchTable10Workbook(), fetchCountyPopulations()]);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<(string | number | null)[]>(worksheet, {
    header: 1,
    defval: null,
    raw: false
  });

  const counties = new Map<string, JurisdictionStats>();

  rows.slice(5).forEach((row) => {
    const state = stateNameToRef.get(normalizeName(String(row[0] || "")));
    const countyName = String(row[2] || "").trim();
    const offenseCells = row.slice(3, 13);
    const hasReportedData = offenseCells.some((value) => numberOrNull(value) != null);

    if (!state || !countyName || !hasReportedData) {
      return;
    }

    const fips = countyFipsByStateAndName.get(`${state.fips}:${normalizeName(countyName)}`);
    if (!fips) {
      return;
    }

    const county = counties.get(fips) || emptyCounty(fips, countyName, refreshedAt);
    county.population = populationByFips.get(fips) || null;
    county.hasData = true;
    county.violentCrime = (county.violentCrime || 0) + (numberOrNull(row[3]) || 0);
    county.homicide = (county.homicide || 0) + (numberOrNull(row[4]) || 0);
    county.rape = (county.rape || 0) + (numberOrNull(row[5]) || 0);
    county.robbery = (county.robbery || 0) + (numberOrNull(row[6]) || 0);
    county.aggravatedAssault = (county.aggravatedAssault || 0) + (numberOrNull(row[7]) || 0);
    county.propertyCrime = (county.propertyCrime || 0) + (numberOrNull(row[8]) || 0);
    county.burglary = (county.burglary || 0) + (numberOrNull(row[9]) || 0);
    county.larceny = (county.larceny || 0) + (numberOrNull(row[10]) || 0);
    county.motorVehicleTheft = (county.motorVehicleTheft || 0) + (numberOrNull(row[11]) || 0);
    county.arson = (county.arson || 0) + (numberOrNull(row[12]) || 0);
    county.totalCrime = (county.violentCrime || 0) + (county.propertyCrime || 0);
    applyCountyRates(county);
    counties.set(fips, county);
  });

  return [...counties.values()].filter((county) => county.hasData);
}

async function getAllCountyStats(refresh = false) {
  const cached = await readCache<JurisdictionStats[]>(
    `counties-all-population-demographics-${DEMOGRAPHICS_CACHE_MODE}-v2`,
    refresh
  );
  if (cached) {
    return cached;
  }

  const refreshedAt = new Date().toISOString();
  const data = await parseTable10Rows(refreshedAt);
  return writeCache(
    `counties-all-population-demographics-${DEMOGRAPHICS_CACHE_MODE}-v2`,
    await withCountyDemographics(data, refresh, refreshedAt)
  );
}

export async function getCountyStats(stateAbbr: string, refresh = false) {
  const normalizedState = stateAbbr.toUpperCase();
  const state = STATE_BY_ABBR.get(normalizedState);

  if (!state) {
    throw new OfficialApiError(400, "", `Unknown state abbreviation: ${stateAbbr}`);
  }

  const allCounties = await getAllCountyStats(refresh);
  return {
    ...allCounties,
    data: allCounties.data.filter((county) => county.fips.startsWith(state.fips))
  };
}

export function getSourceMeta() {
  return {
    apiBase: API_BASE,
    apiKeyMode: API_KEY ? "configured" : "missing",
    censusApiKeyMode: CENSUS_API_KEY ? "configured" : "missing",
    cacheTtlMinutes: CACHE_TTL_MINUTES,
    dataYear: DATA_YEAR,
    acsYear: ACS_YEAR,
    countyPopulationUrl: COUNTY_POPULATION_URL,
    source: OFFICIAL_SOURCE,
    notes: [
      "State values use the current FBI CDE summarized state endpoint for violent and property offense counts.",
      "County values use the official FBI CIUS Table 10 ZIP. The FBI notes Table 10 is county agency data, not full county totals.",
      "County rows with no reported offense cells are excluded from county calculations and color scaling.",
      "State and county color rates use U.S. Census Bureau population estimates for the selected data year.",
      "Race and ethnicity demographics use U.S. Census Bureau ACS 5-Year tables B02001 and B03003.",
      `Official source data is stored locally under .cache/crime and refreshed at most once every ${CACHE_TTL_MINUTES} minutes.`
    ]
  };
}

export { OfficialApiError };
