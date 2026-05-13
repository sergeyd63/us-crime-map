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

export type ApiEnvelope<T> = {
  refreshedAt: string;
  source: string;
  data: T;
};

export type SplitMode = "state" | "county";

export type MetricKey = "totalRate" | "violentRate" | "propertyRate";

export type MetricDefinition = {
  key: MetricKey;
  label: string;
  description: string;
};
