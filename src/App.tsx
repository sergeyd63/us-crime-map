import { extent } from 'd3-array';
import { geoAlbersUsa, geoPath } from 'd3-geo';
import { scaleQuantize } from 'd3-scale';
import {
  ArrowLeft,
  Gauge,
  MapPinned,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { feature } from 'topojson-client';
import countiesTopology from 'us-atlas/counties-10m.json';
import statesTopology from 'us-atlas/states-10m.json';
import type {
  ApiEnvelope,
  JurisdictionStats,
  MetricDefinition,
  MetricKey,
  SplitMode,
} from './types';
import { STATE_BY_FIPS } from './usStates';

type MapFeature = {
  id?: string | number;
  properties?: {
    name?: string;
  };
  type: 'Feature';
  geometry: GeoJSON.Geometry;
};

type FeatureCollection = {
  type: 'FeatureCollection';
  features: MapFeature[];
};

type MapTooltip = {
  x: number;
  y: number;
  name: string;
  metricLabel: string;
  value: string;
};

const WIDTH = 980;
const HEIGHT = 640;
const EMPTY_COLOR = '#d9e0df';
const COLORS = [
  '#d8efe9',
  '#8ed0c3',
  '#f3d36b',
  '#f49b57',
  '#dc5a45',
  '#8d2f55',
];

const metrics: MetricDefinition[] = [
  {
    key: 'totalRate',
    label: 'All tracked',
    description: 'Reported violent plus property offenses as a share of population',
  },
  {
    key: 'violentRate',
    label: 'Violent',
    description:
      'Reported murder, rape, robbery, and aggravated assault as a share of population',
  },
  {
    key: 'propertyRate',
    label: 'Property',
    description:
      'Reported burglary, larceny, motor vehicle theft, and arson as a share of population',
  },
];

const formatNumber = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return 'Not reported';
  }

  return new Intl.NumberFormat('en-US').format(Math.round(value));
};

const formatPopulationPercent = (ratePer100k: number | null | undefined) => {
  if (ratePer100k == null || !Number.isFinite(ratePer100k)) {
    return 'Not reported';
  }

  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(ratePer100k / 1000)}%`;
};

const featureId = (mapFeature: MapFeature, width: number) =>
  String(mapFeature.id ?? '').padStart(width, '0');

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();

const shortenLabel = (name: string, maxChars: number, fallback: string) => {
  if (maxChars >= name.length) {
    return name;
  }

  if (maxChars >= fallback.length) {
    return fallback;
  }

  if (maxChars >= 4) {
    return `${name.slice(0, maxChars - 1).trimEnd()}.`;
  }

  return fallback.slice(0, Math.max(1, maxChars)).toUpperCase();
};

const fetchEnvelope = async <T,>(url: string): Promise<ApiEnvelope<T>> => {
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload.error || `Request failed with status ${response.status}`,
    );
  }

  return payload as ApiEnvelope<T>;
};

const topologyFeatures = (topology: unknown, objectName: string) =>
  (
    feature(
      topology as never,
      (topology as { objects: Record<string, never> }).objects[objectName],
    ) as unknown as FeatureCollection
  ).features;

const getFill = (
  stat: JurisdictionStats | undefined,
  metric: MetricKey,
  colorScale: ReturnType<typeof scaleQuantize<string>>,
) => {
  const value = stat?.[metric];
  return typeof value === 'number' && Number.isFinite(value)
    ? colorScale(value)
    : EMPTY_COLOR;
};

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div className='stat-line'>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailPanel({
  selected,
  hovered,
  metric,
  sourceRefreshedAt,
  error,
}: {
  selected?: JurisdictionStats;
  hovered?: string;
  metric: MetricDefinition;
  sourceRefreshedAt?: string;
  error?: string;
}) {
  const shown = selected;

  return (
    <aside className='detail-panel'>
      <div className='panel-heading'>
        <MapPinned size={20} aria-hidden='true' />
        <div>
          <p>
            {shown?.kind === 'county' ? 'County statistics' : 'Selected area'}
          </p>
          <h2>{shown?.name || hovered || 'Select a state'}</h2>
        </div>
      </div>

      {error ? <div className='error-banner'>{error}</div> : null}

      {shown ? (
        <>
          <div className='rate-hero'>
            <span>{metric.label}</span>
            <strong>{formatPopulationPercent(shown[metric.key])}</strong>
            <small>of population</small>
          </div>

          <div className='stats-grid'>
            <StatLine
              label='Year'
              value={shown.year ? String(shown.year) : 'Not reported'}
            />
            <StatLine
              label='Population'
              value={formatNumber(shown.population)}
            />
            <StatLine
              label='All tracked offenses'
              value={formatNumber(shown.totalCrime)}
            />
            <StatLine
              label='Violent offenses'
              value={formatNumber(shown.violentCrime)}
            />
            <StatLine
              label='Property offenses'
              value={formatNumber(shown.propertyCrime)}
            />
            {shown.reportingAgencies != null ? (
              <StatLine
                label='Reporting agencies'
                value={formatNumber(shown.reportingAgencies)}
              />
            ) : null}
          </div>

          <div className='offense-list'>
            <StatLine label='Homicide' value={formatNumber(shown.homicide)} />
            <StatLine label='Rape' value={formatNumber(shown.rape)} />
            <StatLine label='Robbery' value={formatNumber(shown.robbery)} />
            <StatLine
              label='Aggravated assault'
              value={formatNumber(shown.aggravatedAssault)}
            />
            <StatLine label='Burglary' value={formatNumber(shown.burglary)} />
            <StatLine label='Larceny' value={formatNumber(shown.larceny)} />
            <StatLine
              label='Motor vehicle theft'
              value={formatNumber(shown.motorVehicleTheft)}
            />
            <StatLine label='Arson' value={formatNumber(shown.arson)} />
          </div>
        </>
      ) : (
        <div className='empty-state'>
          <Gauge size={28} aria-hidden='true' />
          <p>
            Choose a state, then switch to county mode and choose a county for
            local statistics.
          </p>
        </div>
      )}

      <div className='source-note'>
        <strong>Source</strong>
        <span>FBI Crime Data API, Uniform Crime Reporting Program</span>
        {sourceRefreshedAt ? (
          <span>Refreshed {new Date(sourceRefreshedAt).toLocaleString()}</span>
        ) : null}
        {shown?.kind === 'county' ? (
          <span>County values come from CIUS Table 10 county agency rows.</span>
        ) : null}
      </div>
    </aside>
  );
}

function App() {
  const [splitMode, setSplitMode] = useState<SplitMode>('state');
  const [metricKey, setMetricKey] = useState<MetricKey>('totalRate');
  const [stateStats, setStateStats] = useState<JurisdictionStats[]>([]);
  const [countyStatsByState, setCountyStatsByState] = useState<
    Record<string, JurisdictionStats[]>
  >({});
  const [selectedStateFips, setSelectedStateFips] = useState<string | null>(
    null,
  );
  const [selectedCountyFips, setSelectedCountyFips] = useState<string | null>(
    null,
  );
  const [hoveredName, setHoveredName] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadingCounty, setLoadingCounty] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [refreshedAt, setRefreshedAt] = useState<string | undefined>();
  const [tooltip, setTooltip] = useState<MapTooltip | null>(null);
  const mapRegionRef = useRef<HTMLDivElement | null>(null);

  const stateFeatures = useMemo(
    () => topologyFeatures(statesTopology, 'states'),
    [],
  );
  const countyFeatures = useMemo(
    () => topologyFeatures(countiesTopology, 'counties'),
    [],
  );
  const stateStatsByFips = useMemo(
    () => new Map(stateStats.map((stat) => [stat.fips, stat])),
    [stateStats],
  );
  const selectedState = selectedStateFips
    ? STATE_BY_FIPS.get(selectedStateFips)
    : undefined;
  const selectedStateStats = selectedStateFips
    ? stateStatsByFips.get(selectedStateFips)
    : undefined;
  const countyStats = selectedState?.abbr
    ? countyStatsByState[selectedState.abbr] || []
    : [];
  const countyStatsByFips = useMemo(
    () => new Map(countyStats.map((stat) => [stat.fips, stat])),
    [countyStats],
  );
  const selectedCountyStats = selectedCountyFips
    ? countyStatsByFips.get(selectedCountyFips)
    : undefined;
  const selectedMetric =
    metrics.find((metric) => metric.key === metricKey) || metrics[0];
  const stateFeature = selectedStateFips
    ? stateFeatures.find(
        (mapFeature) => featureId(mapFeature, 2) === selectedStateFips,
      )
    : undefined;

  const visibleFeatures =
    splitMode === 'county' && selectedStateFips
      ? countyFeatures.filter((mapFeature) =>
          featureId(mapFeature, 5).startsWith(selectedStateFips),
        )
      : stateFeatures;

  const selectedStats = selectedCountyStats || selectedStateStats;
  const currentStatsMap =
    splitMode === 'county' && selectedStateFips
      ? countyStatsByFips
      : stateStatsByFips;
  const metricValues = [...currentStatsMap.values()]
    .map((stat) => stat[metricKey])
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    );
  const metricExtent = extent(metricValues);
  const colorScale = scaleQuantize<string>()
    .domain([Math.max(0, metricExtent[0] || 0), metricExtent[1] || 1])
    .range(COLORS);

  const projection = useMemo(() => {
    const projectionInstance = geoAlbersUsa();
    const collection: FeatureCollection = {
      type: 'FeatureCollection',
      features:
        splitMode === 'state' && stateFeature
          ? [stateFeature]
          : visibleFeatures.length > 0
            ? visibleFeatures
            : stateFeatures,
    };

    projectionInstance.fitExtent(
      [
        [24, 24],
        [WIDTH - 24, HEIGHT - 24],
      ],
      collection as never,
    );

    return projectionInstance;
  }, [splitMode, stateFeature, stateFeatures, visibleFeatures]);

  const pathGenerator = useMemo(() => geoPath(projection), [projection]);

  const getFeatureLabel = (
    mapFeature: MapFeature,
    id: string,
    name: string,
  ) => {
    const centroid = pathGenerator.centroid(mapFeature as never);
    const bounds = pathGenerator.bounds(mapFeature as never);
    const width = bounds[1][0] - bounds[0][0];
    const height = bounds[1][1] - bounds[0][1];

    if (
      !Number.isFinite(centroid[0]) ||
      !Number.isFinite(centroid[1]) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }

    const isCounty = splitMode === 'county' && Boolean(selectedStateFips);
    const fontSize = isCounty
      ? clamp(Math.min(width / 4.4, height / 2.8, 11), 7, 11)
      : clamp(Math.min(width / 5.8, height / 2.5, 15), 8, 15);
    const maxChars = Math.max(1, Math.floor((width * 0.9) / (fontSize * 0.58)));
    const fallback = isCounty
      ? initials(name) || name.slice(0, 3).toUpperCase()
      : STATE_BY_FIPS.get(id)?.abbr || initials(name);

    return {
      x: centroid[0],
      y: centroid[1],
      text: shortenLabel(name, maxChars, fallback),
      fontSize,
    };
  };

  const loadStates = async (refresh = false) => {
    setLoading(true);
    setError(undefined);
    try {
      const envelope = await fetchEnvelope<JurisdictionStats[]>(
        `/api/crime/states${refresh ? '?refresh=1' : ''}`,
      );
      setStateStats(envelope.data);
      setRefreshedAt(envelope.refreshedAt);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load state statistics',
      );
    } finally {
      setLoading(false);
    }
  };

  const loadCounties = async (stateAbbr: string, refresh = false) => {
    setLoadingCounty(true);
    setError(undefined);
    try {
      const envelope = await fetchEnvelope<JurisdictionStats[]>(
        `/api/crime/states/${stateAbbr}/counties${refresh ? '?refresh=1' : ''}`,
      );
      setCountyStatsByState((current) => ({
        ...current,
        [stateAbbr]: envelope.data,
      }));
      setRefreshedAt(envelope.refreshedAt);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load county statistics',
      );
    } finally {
      setLoadingCounty(false);
    }
  };

  useEffect(() => {
    loadStates();
  }, []);

  useEffect(() => {
    if (
      splitMode === 'county' &&
      selectedState?.abbr &&
      !countyStatsByState[selectedState.abbr]
    ) {
      loadCounties(selectedState.abbr);
    }
  }, [countyStatsByState, selectedState?.abbr, splitMode]);

  const handleFeatureClick = (mapFeature: MapFeature) => {
    if (splitMode === 'county' && selectedStateFips) {
      const countyFips = featureId(mapFeature, 5);
      setSelectedCountyFips((current) =>
        current === countyFips ? null : countyFips,
      );
      return;
    }

    const fips = featureId(mapFeature, 2);
    setSelectedStateFips(fips);
    setSelectedCountyFips(null);

    if (splitMode === 'county') {
      const state = STATE_BY_FIPS.get(fips);
      if (state?.abbr && !countyStatsByState[state.abbr]) {
        loadCounties(state.abbr);
      }
    }
  };

  const resetView = () => {
    setSelectedStateFips(null);
    setSelectedCountyFips(null);
  };

  const refreshVisibleData = () => {
    if (splitMode === 'county' && selectedState?.abbr) {
      loadCounties(selectedState.abbr, true);
      return;
    }

    loadStates(true);
  };

  const updateTooltip = (
    event: MouseEvent<SVGPathElement>,
    name: string,
    stat?: JurisdictionStats,
  ) => {
    const rect = mapRegionRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    setTooltip({
      x: clamp(
        event.clientX - rect.left + 14,
        10,
        Math.max(10, rect.width - 210),
      ),
      y: clamp(
        event.clientY - rect.top + 14,
        10,
        Math.max(10, rect.height - 92),
      ),
      name,
      metricLabel: selectedMetric.label,
      value: formatPopulationPercent(stat?.[metricKey]),
    });
  };

  const clearHover = () => {
    setHoveredName(undefined);
    setTooltip(null);
  };

  return (
    <main className='app-shell'>
      <header className='toolbar'>
        <div className='brand-block'>
          <h1>US Crime Statistics Map</h1>
          <p>Official FBI UCR data by state and county rollup</p>
        </div>

        <div className='toolbar-controls'>
          <div className='segmented' aria-label='Map split'>
            <button
              className={splitMode === 'state' ? 'active' : ''}
              onClick={() => {
                setSplitMode('state');
                setSelectedCountyFips(null);
              }}
            >
              State
            </button>
            <button
              className={splitMode === 'county' ? 'active' : ''}
              onClick={() => setSplitMode('county')}
            >
              County
            </button>
          </div>

          <select
            value={metricKey}
            onChange={(event) => setMetricKey(event.target.value as MetricKey)}
          >
            {metrics.map((metric) => (
              <option value={metric.key} key={metric.key}>
                {metric.label}
              </option>
            ))}
          </select>

          <button
            className='icon-button'
            title='Refresh official data'
            onClick={refreshVisibleData}
          >
            <RefreshCw size={18} aria-hidden='true' />
          </button>
        </div>
      </header>

      <section className='workspace'>
        <div className='map-region' ref={mapRegionRef}>
          <div className='map-actions'>
            {splitMode === 'county' && selectedState ? (
              <button className='text-button' onClick={resetView}>
                <ArrowLeft size={16} aria-hidden='true' />
                States
              </button>
            ) : (
              <button
                className='text-button'
                onClick={resetView}
                disabled={!selectedStateFips}
              >
                <RotateCcw size={16} aria-hidden='true' />
                Reset
              </button>
            )}
            <span>{selectedMetric.description}</span>
          </div>

          <svg
            className='crime-map'
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role='img'
            aria-label='Crime choropleth map'
          >
            <rect width={WIDTH} height={HEIGHT} className='map-background' />
            <g>
              {visibleFeatures.map((mapFeature) => {
                const id = featureId(
                  mapFeature,
                  splitMode === 'county' && selectedStateFips ? 5 : 2,
                );
                const stat = currentStatsMap.get(id);
                const name =
                  stat?.name ||
                  mapFeature.properties?.name ||
                  STATE_BY_FIPS.get(id)?.name ||
                  id;
                const selected =
                  id === selectedStateFips || id === selectedCountyFips;

                return (
                  <path
                    key={id}
                    className={`map-shape${selected ? ' selected' : ''}`}
                    d={pathGenerator(mapFeature as never) || undefined}
                    fill={getFill(stat, metricKey, colorScale)}
                    onClick={() => handleFeatureClick(mapFeature)}
                    onMouseEnter={(event) => {
                      setHoveredName(name);
                      updateTooltip(event, name, stat);
                    }}
                    onMouseMove={(event) => updateTooltip(event, name, stat)}
                    onMouseLeave={clearHover}
                  >
                    <title>{`${name}: ${formatPopulationPercent(stat?.[metricKey])} of population`}</title>
                  </path>
                );
              })}
            </g>
            <g className='map-label-layer' aria-hidden='true'>
              {visibleFeatures.map((mapFeature) => {
                const id = featureId(
                  mapFeature,
                  splitMode === 'county' && selectedStateFips ? 5 : 2,
                );
                const stat = currentStatsMap.get(id);
                const name =
                  stat?.name ||
                  mapFeature.properties?.name ||
                  STATE_BY_FIPS.get(id)?.name ||
                  id;
                const label = getFeatureLabel(mapFeature, id, name);

                if (!label) {
                  return null;
                }

                return (
                  <text
                    key={`${id}-label`}
                    className='map-label'
                    x={label.x}
                    y={label.y}
                    style={{ fontSize: label.fontSize }}
                  >
                    {label.text}
                  </text>
                );
              })}
            </g>
          </svg>

          {tooltip ? (
            <div
              className='map-tooltip'
              style={{ left: tooltip.x, top: tooltip.y }}
            >
              <strong>{tooltip.name}</strong>
              <span>
                {tooltip.metricLabel}: {tooltip.value}
              </span>
            </div>
          ) : null}

          <div className='legend' aria-label='Color legend'>
            <small>Lower</small>
            {COLORS.map((color, index) => (
              <span
                style={{ background: color }}
                key={color}
                title={`Band ${index + 1}`}
              />
            ))}
            <small>Higher</small>
          </div>

          {loading || loadingCounty ? (
            <div className='loading-strip'>
              {loading ? 'Loading state data' : 'Loading county data'}
            </div>
          ) : null}
        </div>

        <DetailPanel
          selected={selectedStats}
          hovered={hoveredName}
          metric={selectedMetric}
          sourceRefreshedAt={refreshedAt}
          error={error}
        />
      </section>
    </main>
  );
}

export default App;
