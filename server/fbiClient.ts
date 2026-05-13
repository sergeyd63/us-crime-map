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
  reportingAgencies?: number;
  caveats?: string | null;
  source: string;
  refreshedAt: string;
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
const DATA_YEAR = Number(process.env.CRIME_DATA_YEAR || "2024");
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || "1440");
const CACHE_ROOT = path.join(process.cwd(), ".cache", "crime");
const OFFICIAL_SOURCE =
  "FBI Crime Data API, FBI CIUS publication tables, and U.S. Census Bureau county population estimates";
const TABLE_10_KEY = "_all/Table10.zip";
const COUNTY_POPULATION_URL =
  process.env.COUNTY_POPULATION_URL ||
  `https://www2.census.gov/programs-surveys/popest/datasets/2020-${DATA_YEAR}/counties/totals/co-est${DATA_YEAR}-alldata.csv`;

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

async function readCache<T>(key: string, refresh: boolean) {
  if (refresh) {
    return null;
  }

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
    source: OFFICIAL_SOURCE,
    refreshedAt
  };
}

export async function getStateStats(refresh = false) {
  const cached = await readCache<JurisdictionStats[]>("states", refresh);
  if (cached) {
    return cached;
  }

  const refreshedAt = new Date().toISOString();
  const stats: JurisdictionStats[] = [];

  for (const state of US_STATES) {
    stats.push(await fetchStateStat(state, refreshedAt));
  }

  return writeCache("states", stats);
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
      if (!state || !countyName) {
        return;
      }

      const fips = countyFipsByStateAndName.get(`${state.fips}:${normalizeName(countyName)}`);
      if (!fips) {
        return;
      }

      const county = counties.get(fips) || emptyCounty(fips, countyName, refreshedAt);
      county.population = populationByFips.get(fips) || null;
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

    return [...counties.values()];
}

async function getAllCountyStats(refresh = false) {
  const cached = await readCache<JurisdictionStats[]>("counties-all-population-v2", refresh);
  if (cached) {
    return cached;
  }

  const refreshedAt = new Date().toISOString();
  const data = await parseTable10Rows(refreshedAt);
  return writeCache("counties-all-population-v2", data);
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
    cacheTtlMinutes: CACHE_TTL_MINUTES,
    dataYear: DATA_YEAR,
    countyPopulationUrl: COUNTY_POPULATION_URL,
    source: OFFICIAL_SOURCE,
    notes: [
      "State values use the current FBI CDE summarized state endpoint for violent and property offense counts.",
      "County values use the official FBI CIUS Table 10 ZIP. The FBI notes Table 10 is county agency data, not full county totals.",
      "State and county color percentages use U.S. Census Bureau population estimates for the selected data year."
    ]
  };
}

export { OfficialApiError };
