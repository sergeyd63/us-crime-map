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
  hasData?: boolean;
  demographics?: JurisdictionDemographics;
  reportingAgencies?: number;
  caveats?: string | null;
  source: string;
  refreshedAt: string;
};

export type DemographicMetricKey =
  | "white"
  | "black"
  | "aian"
  | "asian"
  | "nhpi"
  | "other"
  | "twoOrMore"
  | "hispanic";

export type DemographicGroup = {
  key: DemographicMetricKey;
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

export type ApiEnvelope<T> = {
  refreshedAt: string;
  source: string;
  data: T;
};

export type SplitMode = "state" | "county";

export type RateMode = "percent" | "per100k";

export type ColorMetricMode = "crime" | "race";

export type MetricKey = "totalRate" | "violentRate" | "propertyRate";

export type MetricDefinition = {
  key: MetricKey;
  label: string;
  description: string;
};

export type DemographicMetricDefinition = {
  key: DemographicMetricKey;
  label: string;
  description: string;
};
