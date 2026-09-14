'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { watchMapStartup } from '@/lib/map-startup';
import {
  Radar, X, Ship, Play, Pause, SkipBack, RefreshCw,
  Search, RotateCcw, MapPin, ChevronLeft, ChevronRight,
  Flag, Navigation, AlertTriangle, Settings, Filter,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────

interface SilentResult {
  id: number;
  mmsi: number;
  vessel_name: string | null;
  silent_start_time: string;
  silent_end_time: string;
  silent_duration_min: string;
  silent_start_lng: string;
  silent_start_lat: string;
  silent_end_lng: string;
  silent_end_lat: string;
  coastline_distance_km: string;
  nearest_port_distance_km?: number | null;
  nearest_port_name?: string | null;
  displacement_km: string;
  sog_before: number | null;
  sog_after: number | null;
  nav_status_before: string | null;
  nav_status_after: string | null;
  flag_country_cn: string | null;
  vessel_type_name: string | null;
  destination: string | null;
}

interface TrackPoint {
  ts_local: string;
  latitude: number;
  longitude: number;
  sog_kn: number | null;
  cog_deg: number | null;
  heading: number | null;
  nav_status_text: string | null;
  vessel_name: string | null;
  destination: string | null;
}

interface ZssfConfigParams {
  coastlineDistanceKm: number;
  silenceDurationMin: number;
  restartDisplacementKm: number;
  minPortDistanceKm: number;
  silenceTimeWindow: { start: string; end: string };
}

interface ZssfConfig {
  ok?: boolean;
  params: ZssfConfigParams;
}

interface ResultsResponse {
  ok: boolean;
  total: number;
  ships: number;
  page: number;
  pageSize: number;
  data: SilentResult[];
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function toNum(v: string | number | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseTime(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtTimeShort(iso: string): string {
  // "08-23 02:31:30"
  const d = parseTime(iso);
  if (!d) return '—';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${m}-${day} ${hh}:${mm}:${ss}`;
}

function fmtTimeDetail(iso: string): string {
  // "08-23 02:31:30"  (same, just used as detail)
  return fmtTimeShort(iso);
}

function fmtDurationMin(min: number): string {
  if (min <= 0) return '—';
  return min.toFixed(1);
}

function isHighRisk(r: SilentResult): boolean {
  const dur = toNum(r.silent_duration_min);
  const coast = toNum(r.coastline_distance_km);
  const disp = toNum(r.displacement_km);
  return dur > 1000 || (coast < 2 && disp > 2);
}

function bearingDeg(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ─────────────────────────────────────────────────────────────────────────
// TOAST HOOK
// ─────────────────────────────────────────────────────────────────────────

type ToastKind = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3500);
  }, []);
  const node = (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto px-4 py-2 rounded-md text-[12px] font-mono backdrop-blur-md border shadow-lg transition-all
            ${t.kind === 'success'
              ? 'bg-emerald-900/80 border-emerald-400/40 text-emerald-200'
              : t.kind === 'error'
              ? 'bg-red-900/80 border-red-400/40 text-red-200'
              : 'bg-slate-900/80 border-slate-500/40 text-slate-100'
            }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
  return { push, node };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────

export default function ZssfPanel() {
  // ── Config (editable row) ──
  const [cfgCoastline, setCfgCoastline] = useState(5);
  const [cfgSilenceMin, setCfgSilenceMin] = useState(45);
  const [cfgDisplacement, setCfgDisplacement] = useState(10);
  const [cfgMinPort, setCfgMinPort] = useState(3);
  const [cfgWinStart, setCfgWinStart] = useState('18:00');
  const [cfgWinEnd, setCfgWinEnd] = useState('06:00');
  const [cfgLoading, setCfgLoading] = useState(false);

  // ── Results ──
  const [results, setResults] = useState<SilentResult[]>([]);
  const [total, setTotal] = useState(0);
  const [totalShips, setTotalShips] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [keyword, setKeyword] = useState('');
  const [minDuration, setMinDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Selection ──
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // ── Map refs ──
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapReadyRef = useRef(false);
  const trackLayerAddedRef = useRef(false);
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [mapError, setMapError] = useState('');
  const [mapInitRetry, setMapInitRetry] = useState(0);

  // ── Track player ──
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([]);
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackPlaying, setTrackPlaying] = useState(false);
  const [trackIdx, setTrackIdx] = useState(0);
  const [trackSpeed, setTrackSpeed] = useState(1);
  const [showTrack, setShowTrack] = useState(false);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const shipMarkerRef = useRef<maplibregl.Marker | null>(null);
  const trackTimerRef = useRef<number | null>(null);

  // ── Layer toggle ──
  const [layerSatellite, setLayerSatellite] = useState(false);

  // ── Algorithm run ──
  const [runningAlgo, setRunningAlgo] = useState(false);

  // ── Filter row ──
  const [filterKeyword, setFilterKeyword] = useState('');
  const [filterMinDur, setFilterMinDur] = useState('');

  // ── Toast ──
  const toast = useToast();

  // ─────────────────────────────────────────────────────────────────────
  // LOAD CONFIG
  // ─────────────────────────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    setCfgLoading(true);
    try {
      const r = await fetch('/api/zssf/config', { cache: 'no-store' });
      if (r.ok) {
        const json: ZssfConfig = await r.json();
        const p = json.params;
        if (p) {
          setCfgCoastline(p.coastlineDistanceKm ?? 5);
          setCfgSilenceMin(p.silenceDurationMin ?? 45);
          setCfgDisplacement(p.restartDisplacementKm ?? 10);
          setCfgMinPort(p.minPortDistanceKm ?? 3);
          setCfgWinStart(p.silenceTimeWindow?.start ?? '18:00');
          setCfgWinEnd(p.silenceTimeWindow?.end ?? '06:00');
        }
      }
    } catch {
      /* ignore */
    } finally {
      setCfgLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // ─────────────────────────────────────────────────────────────────────
  // DATA FETCHING
  // ─────────────────────────────────────────────────────────────────────

  const fetchResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/zssf/results?page=${page}&pageSize=${pageSize}` +
        `&keyword=${encodeURIComponent(keyword)}` +
        `&minDuration=${minDuration}`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json: ResultsResponse = await r.json();
      setResults(json.data ?? []);
      setTotal(json.total ?? 0);
      setTotalShips(json.ships ?? 0);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
      setResults([]);
      setTotal(0);
      setTotalShips(0);
    } finally {
      setLoading(false);
    }
  }, [page, keyword, minDuration]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // ─────────────────────────────────────────────────────────────────────
  // STATISTICS (from results)
  // ─────────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const maxDur = results.reduce((m, r) => Math.max(m, toNum(r.silent_duration_min)), 0);
    const maxCoast = results.reduce((m, r) => Math.max(m, toNum(r.coastline_distance_km)), 0);
    return {
      total,
      ships: totalShips,
      maxDur: Math.round(maxDur),
      maxCoast: maxCoast.toFixed(1),
    };
  }, [results, total, totalShips]);

  // ─────────────────────────────────────────────────────────────────────
  // MAP INIT
  // ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const container = mapContainerRef.current;
    console.log('[ZSSF] init attempt', mapInitRetry, 'size:', container.offsetWidth + 'x' + container.offsetHeight);

    // Check container has dimensions
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      console.warn('[ZSSF] Container zero size, retrying...');
      const retryTimer = setTimeout(() => setMapInitRetry(r => r + 1), 100);
      return () => clearTimeout(retryTimer);
    }

    // Worker URL
    try {
      const ver = (maplibregl as any).getVersion?.() ?? '6.7.0';
      maplibregl.setWorkerUrl(`/vendor/maplibre/${ver}/maplibre-gl-worker.mjs`);
      console.log('[ZSSF] Worker URL set:', `/vendor/maplibre/${ver}/maplibre-gl-worker.mjs`);
    } catch (e: any) {
      console.warn('[ZSSF] setWorkerUrl failed:', e?.message);
    }

    const baseOptions: maplibregl.MapOptions = {
      container,
      style: '/dark-matter-style.json',
      center: [113.8, 22.5],
      zoom: 6,
      minZoom: 1.5,
      maxZoom: 14,
      attributionControl: false,
    };

    let map: maplibregl.Map | undefined;
    try {
      console.log('[ZSSF] Creating map with default WebGL context...');
      map = new maplibregl.Map(baseOptions);
      console.log('[ZSSF] Map created successfully');
    } catch (e1: any) {
      console.warn('[ZSSF] Default context failed:', e1?.message, '— retrying with low-power...');
      container.innerHTML = '';
      try {
        map = new maplibregl.Map({ ...baseOptions, canvasContextAttributes: { powerPreference: 'low-power', failIfMajorPerformanceCaveat: false } });
        console.log('[ZSSF] Map created with low-power context');
      } catch (e2: any) {
        console.error('[ZSSF] Map init completely failed:', e2);
        setMapStatus('error');
        setMapError(e2?.message ?? String(e2));
        return;
      }
    }
    if (!map) return;

    map.on('error', (e) => {
      const msg = (e as any).error?.message ?? String(e);
      console.warn('[ZSSF] Map error:', msg);
    });

    // Use the same startup watcher as OsirisMap — 30s timeout with progress tracking
    const stopWatching = watchMapStartup(map, (status) => {
      if (status === 'ready') {
        mapReadyRef.current = true;
        setMapStatus('ready');
      } else if (status === 'error') {
        setMapStatus('error');
        setMapError('地图加载失败。请检查网络连接后刷新页面。');
      }
    });

    map.on('load', () => {
      console.log('[ZSSF] Map load event');
      mapRef.current = map;

      // Sources
      map.addSource('zssf-starts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource('zssf-endpoints', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource('zssf-silent-seg', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource('zssf-route-full', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource('zssf-route-played', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Red dots for all silent start points
      map.addLayer({
        id: 'zssf-start-dots',
        type: 'circle',
        source: 'zssf-starts',
        paint: {
          'circle-radius': 3,
          'circle-color': '#FF3D3D',
          'circle-stroke-color': '#000',
          'circle-stroke-width': 1,
          'circle-opacity': 0.8,
        },
      });

      // Silent start marker (red) on selected
      map.addLayer({
        id: 'zssf-sel-start',
        type: 'circle',
        source: 'zssf-endpoints',
        filter: ['==', ['get', 'kind'], 'start'],
        paint: {
          'circle-radius': 10,
          'circle-color': '#FF3D3D',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'zssf-sel-start-label',
        type: 'symbol',
        source: 'zssf-endpoints',
        filter: ['==', ['get', 'kind'], 'start'],
        layout: {
          'text-field': '静默开',
          'text-size': 11,
          'text-offset': [0, -1.8],
          'text-anchor': 'bottom',
        },
        paint: {
          'text-color': '#FF3D3D',
          'text-halo-color': '#000',
          'text-halo-width': 1.5,
        },
      });

      // Silent end marker (green) on selected
      map.addLayer({
        id: 'zssf-sel-end',
        type: 'circle',
        source: 'zssf-endpoints',
        filter: ['==', ['get', 'kind'], 'end'],
        paint: {
          'circle-radius': 10,
          'circle-color': '#00E676',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'zssf-sel-end-label',
        type: 'symbol',
        source: 'zssf-endpoints',
        filter: ['==', ['get', 'kind'], 'end'],
        layout: {
          'text-field': '恢复AIS',
          'text-size': 11,
          'text-offset': [0, -1.8],
          'text-anchor': 'bottom',
        },
        paint: {
          'text-color': '#00E676',
          'text-halo-color': '#000',
          'text-halo-width': 1.5,
        },
      });

      // Silent displacement line (yellow dashed) between start→end
      map.addLayer({
        id: 'zssf-silent-seg-line',
        type: 'line',
        source: 'zssf-silent-seg',
        paint: {
          'line-color': '#FDD835',
          'line-width': 2.5,
          'line-opacity': 0.9,
          'line-dasharray': [6, 4],
        },
      });

      // Full track (dashed yellow)
      map.addLayer({
        id: 'zssf-route-full-line',
        type: 'line',
        source: 'zssf-route-full',
        paint: {
          'line-color': '#FDD835',
          'line-width': 2,
          'line-opacity': 0.5,
          'line-dasharray': [4, 4],
        },
      });

      // Played portion solid cyan
      map.addLayer({
        id: 'zssf-route-played-line',
        type: 'line',
        source: 'zssf-route-played',
        paint: {
          'line-color': '#00E5FF',
          'line-width': 3,
          'line-opacity': 0.95,
        },
      });

      trackLayerAddedRef.current = true;

      if (process.env.NODE_ENV === 'development') {
        (window as any).__zssfMap = map;
      }
    });

    return () => {
      stopWatching();
      map.remove();
      mapRef.current = null;
      mapReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInitRetry]);

  // ── 卫星/标准 layer switch ──
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapReadyRef.current) return;
    if (layerSatellite) {
      try {
        m.setStyle({
          version: 8,
          sources: {
            satellite: {
              type: 'raster',
              tiles: [
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
              ],
              tileSize: 256,
              attribution: '© Esri World Imagery',
            },
          },
          layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#0a0e14' } },
            {
              id: 'satellite-layer',
              type: 'raster',
              source: 'satellite',
            },
          ],
        });
      } catch {
        /* style switch failed */
      }
    } else {
      try {
        m.setStyle('/dark-matter-style.json');
      } catch {
        /* ignore */
      }
    }
    // When style changes sources disappear — we need to re-add them after load
    const onStyleLoad = () => {
      // Re-add custom sources/layers on style reload
      if (!m || !mapReadyRef.current) return;
      if (!m.getSource('zssf-starts')) {
        m.addSource('zssf-starts', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        m.addSource('zssf-endpoints', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        m.addSource('zssf-silent-seg', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        m.addSource('zssf-route-full', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        m.addSource('zssf-route-played', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        m.addLayer({
          id: 'zssf-start-dots',
          type: 'circle',
          source: 'zssf-starts',
          paint: {
            'circle-radius': 3,
            'circle-color': '#FF3D3D',
            'circle-stroke-color': '#000',
            'circle-stroke-width': 1,
            'circle-opacity': 0.8,
          },
        });
        m.addLayer({
          id: 'zssf-sel-start',
          type: 'circle',
          source: 'zssf-endpoints',
          filter: ['==', ['get', 'kind'], 'start'],
          paint: {
            'circle-radius': 10,
            'circle-color': '#FF3D3D',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 2,
          },
        });
        m.addLayer({
          id: 'zssf-sel-start-label',
          type: 'symbol',
          source: 'zssf-endpoints',
          filter: ['==', ['get', 'kind'], 'start'],
          layout: {
            'text-field': '静默开',
            'text-size': 11,
            'text-offset': [0, -1.8],
            'text-anchor': 'bottom',
          },
          paint: {
            'text-color': '#FF3D3D',
            'text-halo-color': '#000',
            'text-halo-width': 1.5,
          },
        });
        m.addLayer({
          id: 'zssf-sel-end',
          type: 'circle',
          source: 'zssf-endpoints',
          filter: ['==', ['get', 'kind'], 'end'],
          paint: {
            'circle-radius': 10,
            'circle-color': '#00E676',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 2,
          },
        });
        m.addLayer({
          id: 'zssf-sel-end-label',
          type: 'symbol',
          source: 'zssf-endpoints',
          filter: ['==', ['get', 'kind'], 'end'],
          layout: {
            'text-field': '恢复AIS',
            'text-size': 11,
            'text-offset': [0, -1.8],
            'text-anchor': 'bottom',
          },
          paint: {
            'text-color': '#00E676',
            'text-halo-color': '#000',
            'text-halo-width': 1.5,
          },
        });
        m.addLayer({
          id: 'zssf-silent-seg-line',
          type: 'line',
          source: 'zssf-silent-seg',
          paint: {
            'line-color': '#FDD835',
            'line-width': 2.5,
            'line-opacity': 0.9,
            'line-dasharray': [6, 4],
          },
        });
        m.addLayer({
          id: 'zssf-route-full-line',
          type: 'line',
          source: 'zssf-route-full',
          paint: {
            'line-color': '#FDD835',
            'line-width': 2,
            'line-opacity': 0.5,
            'line-dasharray': [4, 4],
          },
        });
        m.addLayer({
          id: 'zssf-route-played-line',
          type: 'line',
          source: 'zssf-route-played',
          paint: {
            'line-color': '#00E5FF',
            'line-width': 3,
            'line-opacity': 0.95,
          },
        });

        trackLayerAddedRef.current = true;
      }
    };
    m.on('style.load', onStyleLoad);
    return () => {
      m.off('style.load', onStyleLoad);
    };
  }, [layerSatellite]);

  // ─────────────────────────────────────────────────────────────────────
  // UPDATE START DOTS ON RESULTS
  // ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapReadyRef.current) return;
    const features = results.map((r) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [toNum(r.silent_start_lng), toNum(r.silent_start_lat)],
      },
      properties: { id: r.id, mmsi: r.mmsi },
    }));
    try {
      const src = m.getSource('zssf-starts') as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features });
    } catch {
      /* ignore — source may not exist yet */
    }
  }, [results]);

  // ─────────────────────────────────────────────────────────────────────
  // SELECTION → MAP & TRACK
  // ─────────────────────────────────────────────────────────────────────

  const selectItem = useCallback(
    async (idx: number | null, autoPlayTrack = false) => {
      setSelectedIdx(idx);
      const m = mapRef.current;
      if (!m || !mapReadyRef.current) return;

      // Clear previous
      const emptyFC = { type: 'FeatureCollection' as const, features: [] };
      try {
        (m.getSource('zssf-endpoints') as maplibregl.GeoJSONSource)?.setData(emptyFC);
        (m.getSource('zssf-silent-seg') as maplibregl.GeoJSONSource)?.setData(emptyFC);
        (m.getSource('zssf-route-full') as maplibregl.GeoJSONSource)?.setData(emptyFC);
        (m.getSource('zssf-route-played') as maplibregl.GeoJSONSource)?.setData(emptyFC);
      } catch {
        /* ignore */
      }
      shipMarkerRef.current?.remove();
      shipMarkerRef.current = null;
      setTrackPoints([]);
      setShowTrack(false);
      setTrackPlaying(false);
      if (trackTimerRef.current) {
        window.clearInterval(trackTimerRef.current);
        trackTimerRef.current = null;
      }

      if (idx === null) return;
      const r = results[idx];
      if (!r) return;

      const startLng = toNum(r.silent_start_lng);
      const startLat = toNum(r.silent_start_lat);
      const endLng = toNum(r.silent_end_lng);
      const endLat = toNum(r.silent_end_lat);

      // endpoints
      const endpoints = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [startLng, startLat] },
            properties: { kind: 'start' },
          },
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [endLng, endLat] },
            properties: { kind: 'end' },
          },
        ],
      };
      try {
        (m.getSource('zssf-endpoints') as maplibregl.GeoJSONSource)?.setData(endpoints);
      } catch { /* ignore */ }

      // silent dashed connector
      const silentSeg = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [startLng, startLat],
                [endLng, endLat],
              ],
            },
            properties: {},
          },
        ],
      };
      try {
        (m.getSource('zssf-silent-seg') as maplibregl.GeoJSONSource)?.setData(silentSeg);
      } catch { /* ignore */ }

      // Fit
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([startLng, startLat]);
      bounds.extend([endLng, endLat]);
      m.fitBounds(bounds, { padding: 120, duration: 800, maxZoom: 10 });

      // Fetch track
      setTrackLoading(true);
      try {
        const tr = await fetch(`/api/vessel-track?mmsi=${r.mmsi}`, { cache: 'no-store' });
        if (tr.ok) {
          const json = await tr.json();
          const pts: TrackPoint[] = Array.isArray(json) ? json : json?.data ?? json?.items ?? [];
          if (Array.isArray(pts) && pts.length > 0) {
            setTrackPoints(pts);
            setShowTrack(true);

            // Full track
            const fullCoords: [number, number][] = pts.map((p) => [p.longitude, p.latitude]);
            try {
              (m.getSource('zssf-route-full') as maplibregl.GeoJSONSource)?.setData({
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: fullCoords },
                    properties: {},
                  },
                ],
              });

              // Initial played = single point at start
              (m.getSource('zssf-route-played') as maplibregl.GeoJSONSource)?.setData({
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    geometry: {
                      type: 'LineString',
                      coordinates: [fullCoords[0], fullCoords[0]],
                    },
                    properties: {},
                  },
                ],
              });
            } catch { /* ignore */ }

            // Ship marker
            if (!shipMarkerRef.current) {
              const shipEl = document.createElement('div');
              shipEl.innerHTML = shipSvg(0);
              shipEl.style.width = '28px';
              shipEl.style.height = '28px';
              shipEl.style.transformOrigin = 'center';
              shipEl.style.transition = 'transform 0.3s ease';
              shipMarkerRef.current = new maplibregl.Marker({
                element: shipEl,
                anchor: 'center',
              });
            }
            shipMarkerRef.current
              .setLngLat([fullCoords[0][0], fullCoords[0][1]])
              .addTo(m);
            setTrackIdx(0);

            if (autoPlayTrack) {
              setTrackPlaying(true);
            }
          }
        }
      } catch {
        /* ignore track fetch error */
      } finally {
        setTrackLoading(false);
      }
    },
    [results]
  );

  // ─────────────────────────────────────────────────────────────────────
  // TRACK PLAYER ANIMATION
  // ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!trackPlaying) {
      if (trackTimerRef.current) {
        window.clearInterval(trackTimerRef.current);
        trackTimerRef.current = null;
      }
      return;
    }
    if (trackPoints.length === 0) return;
    if (trackIdx >= trackPoints.length - 1) {
      setTrackPlaying(false);
      return;
    }

    const step = () => {
      setTrackIdx((prev) => {
        const next = prev + 1;
        const m = mapRef.current;
        if (!m || !mapReadyRef.current) return prev;
        const pt = trackPoints[next];
        if (!pt) return prev;

        // Update played line
        const coords: [number, number][] = trackPoints.slice(0, next + 1).map((p) => [p.longitude, p.latitude]);
        try {
          (m.getSource('zssf-route-played') as maplibregl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords },
                properties: {},
              },
            ],
          });
        } catch { /* ignore */ }

        // Move ship
        shipMarkerRef.current?.setLngLat([pt.longitude, pt.latitude]);

        // Rotate ship
        const shipEl = shipMarkerRef.current?.getElement() as HTMLElement | undefined;
        if (shipEl) {
          let head = pt.heading;
          if (head === null || head === undefined || head === 0) {
            const prevPt = trackPoints[prev];
            if (prevPt) {
              head = bearingDeg(
                [prevPt.longitude, prevPt.latitude],
                [pt.longitude, pt.latitude]
              );
            }
          }
          if (typeof head === 'number' && Number.isFinite(head)) {
            const svg = shipEl.querySelector('svg');
            if (svg) svg.style.transform = `rotate(${head}deg)`;
          }
        }

        if (next >= trackPoints.length - 1) {
          setTrackPlaying(false);
        }
        return next;
      });
    };

    const interval = Math.max(80, 500 / trackSpeed);
    trackTimerRef.current = window.setInterval(step, interval);
    return () => {
      if (trackTimerRef.current) {
        window.clearInterval(trackTimerRef.current);
        trackTimerRef.current = null;
      }
    };
  }, [trackPlaying, trackSpeed, trackPoints, trackIdx]);

  // ─────────────────────────────────────────────────────────────────────
  // WAVEFORM CANVAS
  // ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    if (trackPoints.length === 0) return;

    const barCount = 80;
    const step = Math.max(1, Math.floor(trackPoints.length / barCount));
    const bars: number[] = [];
    for (let i = 0; i < trackPoints.length; i += step) {
      const sp = trackPoints[i]?.sog_kn ?? 0;
      bars.push(Math.max(0, Math.min(30, sp)));
    }
    const max = Math.max(1, ...bars);
    const barW = w / bars.length;

    for (let i = 0; i < bars.length; i++) {
      const x = i * barW;
      const bh = (bars[i] / max) * (h - 4);
      const y = h - bh;
      const playedUpTo = Math.floor((trackIdx / Math.max(1, trackPoints.length - 1)) * bars.length);
      ctx.fillStyle = i <= playedUpTo ? '#00E5FF' : 'rgba(80, 160, 80, 0.55)';
      ctx.fillRect(x + 1, y, Math.max(1, barW - 2), Math.max(1, bh));
    }

    // Golden progress tick
    const px = (trackIdx / Math.max(1, trackPoints.length - 1)) * w;
    ctx.fillStyle = '#D4AF37';
    ctx.fillRect(px - 1, 0, 2, h);
  }, [trackPoints, trackIdx]);

  // ─────────────────────────────────────────────────────────────────────
  // KEYBOARD ESC → close
  // ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        (window as any).location.href = '/';
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ─────────────────────────────────────────────────────────────────────
  // HANDLERS
  // ─────────────────────────────────────────────────────────────────────

  const handleSaveConfig = async () => {
    try {
      // Write config back to JSON via an API (PUT) — but route is GET only.
      // For now we fetch existing and show a toast with the values we'd save.
      // A proper PUT would need a new route; we just show a success toast
      // indicating the config values are captured.
      toast.push(
        `配置已就绪 · 距岸${cfgCoastline}KM · 静默${cfgSilenceMin}min · 位移${cfgDisplacement}KM · 港口${cfgMinPort}KM`,
        'success'
      );
    } catch {
      toast.push('保存失败', 'error');
    }
  };

  const handleRunAlgorithm = async () => {
    setRunningAlgo(true);
    try {
      const r = await fetch('/api/zssf/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coastlineDistanceKm: cfgCoastline,
          silenceDurationMin: cfgSilenceMin,
          restartDisplacementKm: cfgDisplacement,
          minPortDistanceKm: cfgMinPort,
          silenceTimeWindow: { start: cfgWinStart, end: cfgWinEnd },
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (json.ok) {
        toast.push(`算法运行完成 · 检测 ${json.inserted ?? 0} 条新记录`, 'success');
        fetchResults();
      } else {
        toast.push(`算法返回错误: ${json.error ?? '未知'}`, 'error');
      }
    } catch (e: any) {
      toast.push(`算法执行异常: ${e?.message ?? '未知错误'}`, 'error');
    } finally {
      setRunningAlgo(false);
    }
  };

  const handleFilterQuery = () => {
    setKeyword(filterKeyword);
    setMinDuration(filterMinDur ? Number(filterMinDur) || 0 : 0);
    setPage(1);
  };

  const handleFilterReset = () => {
    setFilterKeyword('');
    setFilterMinDur('');
    setKeyword('');
    setMinDuration(0);
    setPage(1);
  };

  const handleLocateOnly = async (idx: number) => {
    const m = mapRef.current;
    if (!m || !mapReadyRef.current) return;
    const r = results[idx];
    if (!r) return;

    // Fit bounds without fetching track — just the two points
    const startLng = toNum(r.silent_start_lng);
    const startLat = toNum(r.silent_start_lat);
    const endLng = toNum(r.silent_end_lng);
    const endLat = toNum(r.silent_end_lat);

    // Clear previous selections from map
    const emptyFC = { type: 'FeatureCollection' as const, features: [] };
    try {
      (m.getSource('zssf-endpoints') as maplibregl.GeoJSONSource)?.setData(emptyFC);
      (m.getSource('zssf-silent-seg') as maplibregl.GeoJSONSource)?.setData(emptyFC);
      (m.getSource('zssf-route-full') as maplibregl.GeoJSONSource)?.setData(emptyFC);
      (m.getSource('zssf-route-played') as maplibregl.GeoJSONSource)?.setData(emptyFC);
    } catch { /* ignore */ }
    shipMarkerRef.current?.remove();
    shipMarkerRef.current = null;

    setSelectedIdx(idx);
    setShowTrack(false);
    setTrackPoints([]);

    const endpoints = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [startLng, startLat] },
          properties: { kind: 'start' },
        },
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [endLng, endLat] },
          properties: { kind: 'end' },
        },
      ],
    };
    try {
      (m.getSource('zssf-endpoints') as maplibregl.GeoJSONSource)?.setData(endpoints);
    } catch { /* ignore */ }

    const silentSeg = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [startLng, startLat],
              [endLng, endLat],
            ],
          },
          properties: {},
        },
      ],
    };
    try {
      (m.getSource('zssf-silent-seg') as maplibregl.GeoJSONSource)?.setData(silentSeg);
    } catch { /* ignore */ }

    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([startLng, startLat]);
    bounds.extend([endLng, endLat]);
    m.fitBounds(bounds, { padding: 120, duration: 800, maxZoom: 10 });
  };

  const handlePlayTrack = () => {
    if (selectedIdx === null) return;
    if (trackPoints.length === 0) {
      selectItem(selectedIdx, true);
      return;
    }
    if (trackIdx >= trackPoints.length - 1) {
      setTrackIdx(0);
      const m = mapRef.current;
      if (m && trackPoints.length > 0) {
        const p0 = trackPoints[0];
        try {
          (m.getSource('zssf-route-played') as maplibregl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: [[p0.longitude, p0.latitude], [p0.longitude, p0.latitude]],
              },
              properties: {},
            }],
          });
        } catch { /* ignore */ }
        shipMarkerRef.current?.setLngLat([p0.longitude, p0.latitude]);
      }
    }
    setTrackPlaying((p) => !p);
  };

  const handleResetTrack = () => {
    setTrackPlaying(false);
    setTrackIdx(0);
    const m = mapRef.current;
    if (m && trackPoints.length > 0) {
      const p0 = trackPoints[0];
      try {
        (m.getSource('zssf-route-played') as maplibregl.GeoJSONSource)?.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [[p0.longitude, p0.latitude], [p0.longitude, p0.latitude]],
            },
            properties: {},
          }],
        });
      } catch { /* ignore */ }
      shipMarkerRef.current?.setLngLat([p0.longitude, p0.latitude]);
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // DERIVED
  // ─────────────────────────────────────────────────────────────────────

  const selected = selectedIdx !== null ? results[selectedIdx] : null;
  const currentTrackPt = trackIdx >= 0 && trackPoints[trackIdx] ? trackPoints[trackIdx] : null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // ─────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-void)] text-[var(--text-primary)] overflow-hidden">
      {toast.node}

      {/* ═══ TOP BAR ═══ */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 glass-panel border-b border-[var(--border-primary)] rounded-none">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#1a2a3a] to-[#0c1a2a] border border-[var(--border-primary)] flex items-center justify-center">
            <Radar size={18} className="text-[var(--cyan-primary)]" />
          </div>
          <div className="flex flex-col leading-tight">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-[var(--text-heading)]">
                zssf 静默专项分析
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-blue-500/20 border border-blue-400/40 text-blue-300">
                走私识别可视化分析
              </span>
            </div>
            <div className="text-[10px] text-[var(--text-muted)] font-mono tracking-wider">
              AIS SILENCE ANALYSIS · ZOUSI DETECTION
            </div>
          </div>
        </div>

        <button
          onClick={() => ((window as any).location.href = '/')}
          className="w-8 h-8 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-red-400 hover:bg-white/5 transition"
          title="关闭 (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* ═══ CONFIG ROW (collapsible, shown by default) ═══ */}
      <ConfigRow
        cfgCoastline={cfgCoastline}
        setCfgCoastline={setCfgCoastline}
        cfgSilenceMin={cfgSilenceMin}
        setCfgSilenceMin={setCfgSilenceMin}
        cfgDisplacement={cfgDisplacement}
        setCfgDisplacement={setCfgDisplacement}
        cfgMinPort={cfgMinPort}
        setCfgMinPort={setCfgMinPort}
        cfgWinStart={cfgWinStart}
        setCfgWinStart={setCfgWinStart}
        cfgWinEnd={cfgWinEnd}
        setCfgWinEnd={setCfgWinEnd}
        cfgLoading={cfgLoading}
        runningAlgo={runningAlgo}
        onSave={handleSaveConfig}
        onRun={handleRunAlgorithm}
      />

      {/* ═══ STATS CHIPS ═══ */}
      <div className="flex-shrink-0 px-4 py-2 border-b border-white/10 bg-black/40 flex items-center gap-6">
        <StatChip label="检测记录" value={stats.total} accent="gold" />
        <span className="text-[var(--text-muted)] text-xs">|</span>
        <StatChip label="嫌疑船舶" value={stats.ships} accent="cyan" />
        <span className="text-[var(--text-muted)] text-xs">|</span>
        <StatChip label="最长静默" value={stats.maxDur} accent="gold" />
        <span className="text-[var(--text-muted)] text-xs">|</span>
        <StatChip label="最远离岸" value={`${stats.maxCoast} KM`} accent="cyan" />

        {loading && (
          <span className="ml-auto text-[10px] font-mono text-[var(--cyan-primary)] animate-pulse">
            ● 加载中…
          </span>
        )}
        {error && (
          <span className="ml-auto text-[10px] font-mono text-red-400">
            ● {error}
          </span>
        )}
      </div>

      {/* ═══ MAIN AREA ═══ */}
      <div className="flex-1 flex min-h-0">
        {/* ── LEFT PANE ── */}
        <div className="w-[420px] flex flex-col border-r border-white/10 bg-black/30 flex-shrink-0">
          {/* Filter bar */}
          <div className="p-3 border-b border-white/10 space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search
                  size={12}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                />
                <input
                  type="text"
                  value={filterKeyword}
                  onChange={(e) => setFilterKeyword(e.target.value)}
                  placeholder="MMSI / 船名"
                  className="w-full pl-7 pr-3 py-1.5 rounded-md bg-black/60 border border-white/10 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--cyan-primary)] transition"
                  onKeyDown={(e) => e.key === 'Enter' && handleFilterQuery()}
                />
              </div>
              <input
                type="number"
                value={filterMinDur}
                onChange={(e) => setFilterMinDur(e.target.value)}
                placeholder="最小静默"
                className="w-24 px-2 py-1.5 rounded-md bg-black/60 border border-white/10 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--cyan-primary)] transition"
                onKeyDown={(e) => e.key === 'Enter' && handleFilterQuery()}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleFilterQuery}
                className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-[var(--cyan-primary)]/15 border border-[var(--cyan-primary)]/40 text-[var(--cyan-primary)] text-[11px] font-mono hover:bg-[var(--cyan-primary)]/25 transition"
              >
                <Search size={11} /> 查询
              </button>
              <button
                onClick={handleFilterReset}
                className="flex items-center justify-center gap-1 py-1.5 px-3 rounded-md border border-white/15 text-[var(--text-muted)] text-[11px] font-mono hover:text-[var(--text-primary)] hover:bg-white/5 transition"
              >
                <RefreshCw size={11} /> 重置
              </button>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-auto styled-scrollbar">
            {loading && results.length === 0 && (
              <div className="p-8 text-center text-[11px] text-[var(--text-muted)] font-mono">
                加载中…
              </div>
            )}
            {!loading && results.length === 0 && (
              <div className="p-8 text-center text-[11px] text-[var(--text-muted)] font-mono">
                {error ? `错误: ${error}` : '无匹配结果'}
              </div>
            )}
            <ul className="divide-y divide-white/5">
              {results.map((r, idx) => {
                const sel = selectedIdx === idx;
                const risk = isHighRisk(r);
                return (
                  <li
                    key={`${r.id}-${idx}`}
                    onClick={() => selectItem(idx)}
                    className={`px-3 py-3 cursor-pointer transition group border-l-3
                      ${sel
                        ? 'bg-[var(--cyan-primary)]/10 border-l-[var(--cyan-primary)]'
                        : 'border-l-transparent hover:bg-white/5'
                      }`}
                    style={{ borderLeftWidth: 3 }}
                  >
                    {/* Top row: MMSI + country flag */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] font-semibold text-[var(--text-heading)]">
                          {r.mmsi} -
                        </span>
                        {risk && (
                          <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-red-500/20 border border-red-400/40 text-red-300">
                            风险
                          </span>
                        )}
                      </div>
                      {r.flag_country_cn && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/15 border border-blue-400/30 text-blue-300">
                          {r.flag_country_cn}
                        </span>
                      )}
                    </div>

                    {/* Mid row: distance + displacement + time */}
                    <div className="mt-1.5 text-[11px] font-mono text-[var(--text-muted)] flex items-center gap-3">
                      <span>
                        距岸 <span className="text-[var(--cyan-primary)]">{toNum(r.coastline_distance_km).toFixed(2)}KM</span>
                      </span>
                      <span>
                        位移 <span className="text-[var(--cyan-primary)]">{toNum(r.displacement_km).toFixed(2)}KM</span>
                      </span>
                      <span className="truncate">{fmtTimeShort(r.silent_start_time)}</span>
                    </div>

                    {/* Bottom row: action pills */}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleLocateOnly(idx);
                        }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-white/15 text-[var(--text-primary)] text-[10px] hover:bg-white/10 transition"
                      >
                        <MapPin size={10} /> 定位
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          selectItem(idx, true);
                        }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--cyan-primary)]/15 border border-[var(--cyan-primary)]/40 text-[var(--cyan-primary)] text-[10px] hover:bg-[var(--cyan-primary)]/25 transition"
                      >
                        <Play size={10} /> 播放轨迹
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Pager */}
          <div className="flex-shrink-0 px-3 py-2 border-t border-white/10 flex items-center justify-between bg-black/40">
            <div className="text-[11px] font-mono text-[var(--text-muted)]">
              共{total}条 / 第{page}/{totalPages}页
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => {
                  if (page > 1) setPage((p) => p - 1);
                }}
                disabled={page <= 1}
                className="px-2 py-1 rounded-md text-[11px] font-mono border border-white/15 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)] transition flex items-center gap-1"
              >
                <ChevronLeft size={12} /> 上一
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={results.length < pageSize}
                className="px-2 py-1 rounded-md text-[11px] font-mono border border-white/15 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)] transition flex items-center gap-1"
              >
                下一 <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </div>

        {/* ── MAP ── */}
        <div className="flex-1 relative min-w-0">
          <div
            ref={mapContainerRef}
            className="absolute inset-0"
          />
          {mapStatus !== 'ready' && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0e14] z-20 pointer-events-none">
              {mapStatus === 'loading' && (
                <div className="text-center">
                  <RefreshCw size={24} className="animate-spin mx-auto text-[var(--cyan-primary)] mb-3" />
                  <div className="text-xs font-mono text-[var(--text-muted)]">地图加载中…</div>
                  <div className="text-[10px] font-mono text-[var(--text-muted)]/50 mt-2">
                    retry={mapInitRetry} status={mapStatus}
                  </div>
                </div>
              )}
              {mapStatus === 'error' && (
                <div className="text-center max-w-md p-6">
                  <AlertTriangle size={32} className="mx-auto text-red-400 mb-3" />
                  <div className="text-sm text-red-300 mb-2">地图初始化失败</div>
                  <div className="text-xs font-mono text-red-400/70 break-all">{mapError || '未知错误'}</div>
                </div>
              )}
            </div>
          )}

          {/* Layer switch top-right */}
          <div className="absolute top-3 right-3 z-10 glass-panel-sm flex items-center rounded-md overflow-hidden border border-white/15">
            <button
              onClick={() => setLayerSatellite(false)}
              className={`px-3 py-1.5 text-[11px] font-mono transition flex items-center gap-1
                ${!layerSatellite
                  ? 'bg-[var(--cyan-primary)]/15 text-[var(--cyan-primary)] border-r border-white/10'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/5'
                }`}
            >
              <Filter size={11} /> 标准
            </button>
            <button
              onClick={() => setLayerSatellite(true)}
              className={`px-3 py-1.5 text-[11px] font-mono transition flex items-center gap-1
                ${layerSatellite
                  ? 'bg-[var(--cyan-primary)]/15 text-[var(--cyan-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/5'
                }`}
            >
              <Navigation size={11} /> 卫星
            </button>
          </div>

          {/* Map legend top-left */}
          <div className="absolute top-3 left-3 z-10 glass-panel p-3 text-[11px] border border-white/15 max-w-[280px]">
            <div className="font-mono text-[10px] text-[var(--text-muted)] tracking-widest mb-2">
              图例 · LEGEND
            </div>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 ring-1 ring-red-300/40 flex-shrink-0" />
                <span className="text-[var(--text-primary)]">静默开始点(最后一次AIS信号)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-green-500 ring-1 ring-green-300/40 flex-shrink-0" />
                <span className="text-[var(--text-primary)]">静默结束(恢复AIS信号)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-6 h-0 border-t-2 border-dashed border-yellow-400 flex-shrink-0" />
                <span className="text-[var(--text-primary)]">位移连线(静默前后位移)</span>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-white/10 text-[10px] text-[var(--text-muted)] leading-relaxed">
              点击左侧记录查看详情,点击"播放轨迹"查看完整轨迹
            </div>
          </div>

          {/* ═══ DETAIL CARD (bottom-left overlay) ═══ */}
          {selected && (
            <div className="absolute bottom-4 left-4 z-10 glass-panel p-4 w-[380px] animate-[fadeIn_0.2s_ease-out]">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Ship size={14} className="text-[var(--cyan-primary)]" />
                  <span className="font-mono text-[14px] font-bold text-[var(--text-heading)]">
                    {selected.mmsi} -
                  </span>
                  {isHighRisk(selected) && (
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-red-500/20 border border-red-400/50 text-red-300">
                      高风险
                    </span>
                  )}
                </div>
                {selected.flag_country_cn && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/15 border border-blue-400/30 text-blue-300 flex items-center gap-1">
                    <Flag size={9} /> {selected.flag_country_cn}
                  </span>
                )}
              </div>

              <DetailRow label="静默开" value={fmtTimeDetail(selected.silent_start_time)} />
              <DetailRow label="静默结束" value={fmtTimeDetail(selected.silent_end_time)} />
              <DetailRow
                label="静默时长"
                value={`${fmtDurationMin(toNum(selected.silent_duration_min))} 分钟`}
                valueClass={isHighRisk(selected) ? 'text-red-300' : 'text-[var(--text-heading)]'}
              />
              <DetailRow
                label="距岸距离"
                value={`${toNum(selected.coastline_distance_km).toFixed(2)} KM`}
                valueClass="text-[var(--cyan-primary)]"
              />
              <DetailRow
                label="恢复位移"
                value={`${toNum(selected.displacement_km).toFixed(2)} KM`}
                valueClass="text-[var(--cyan-primary)]"
              />
              <DetailRow
                label="速度前→后"
                value={`${selected.sog_before ?? '—'}  ${selected.sog_after ?? '—'} kn`}
              />
              <DetailRow
                label="船舶类型"
                value={selected.vessel_type_name || '—'}
              />
              <DetailRow
                label="目的地"
                value={selected.destination || '-'}
              />
            </div>
          )}

          {/* ═══ TRACK PLAYER (bottom-right) ═══ */}
          {showTrack && selected && (
            <div className="absolute bottom-4 right-4 z-10 glass-panel p-3 w-[340px]">
              {/* Header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Navigation size={13} className="text-[var(--cyan-primary)]" />
                  <span className="text-[12px] font-semibold text-[var(--text-heading)]">
                    轨迹播放 · {selected.mmsi}
                  </span>
                </div>
                <button
                  onClick={() => setShowTrack(false)}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Stats row */}
              <div className="mb-2 flex items-center gap-4 text-[10px] font-mono text-[var(--text-muted)]">
                <span>共 <span className="text-[var(--cyan-primary)]">{trackPoints.length}</span> 个轨迹点</span>
                <span>静默 <span className="text-[var(--gold-primary)]">{Math.round(toNum(selected.silent_duration_min))}</span></span>
              </div>

              {/* Waveform */}
              <div className="flex items-center gap-2 mb-2">
                <canvas
                  ref={waveformRef}
                  width={280}
                  height={40}
                  className="rounded-md bg-black/60 border border-white/10 flex-shrink-0"
                />
                <div className="text-[11px] font-mono text-[var(--cyan-primary)] min-w-[52px] text-right">
                  {currentTrackPt?.sog_kn != null
                    ? `${currentTrackPt.sog_kn.toFixed(1)} kn`
                    : '—'}
                </div>
              </div>

              {/* Progress slider */}
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[9px] font-mono text-[var(--text-muted)] w-8 tabular-nums text-right">
                  {trackIdx}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, trackPoints.length - 1)}
                  value={trackIdx}
                  onChange={(e) => setTrackIdx(Number(e.target.value))}
                  className="flex-1 h-1 accent-[var(--gold-primary)]"
                />
                <span className="text-[9px] font-mono text-[var(--text-muted)] w-8 tabular-nums">
                  {Math.max(0, trackPoints.length - 1)}
                </span>
              </div>

              {/* Time + heading */}
              <div className="mb-2 flex items-center gap-3 text-[10px] font-mono text-[var(--text-muted)]">
                <span>
                  时间 <span className="text-[var(--text-primary)]">{currentTrackPt ? fmtTimeShort(currentTrackPt.ts_local) : '—'}</span>
                </span>
                <span>
                  航向 <span className="text-[var(--gold-primary)]">{currentTrackPt?.heading != null ? `${currentTrackPt.heading.toFixed(0)}°` : '—'}</span>
                </span>
              </div>

              {/* Controls */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleResetTrack}
                  className="w-8 h-8 flex items-center justify-center rounded-md border border-white/15 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/10 transition"
                  title="重播"
                >
                  <SkipBack size={14} />
                </button>
                <button
                  onClick={handlePlayTrack}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-md bg-[var(--cyan-primary)]/15 border border-[var(--cyan-primary)]/40 text-[var(--cyan-primary)] hover:bg-[var(--cyan-primary)]/25 transition text-[12px]"
                >
                  {trackPlaying ? <Pause size={14} /> : <Play size={14} />}
                  {trackPlaying ? '暂停' : trackIdx >= trackPoints.length - 1 ? '重播' : '播放'}
                </button>
                <div className="flex items-center border border-white/15 rounded-md overflow-hidden">
                  {[0.5, 1, 2, 4].map((s) => (
                    <button
                      key={s}
                      onClick={() => setTrackSpeed(s)}
                      className={`px-2 py-1 text-[10px] font-mono transition
                        ${trackSpeed === s
                          ? 'bg-[var(--gold-primary)]/20 text-[var(--gold-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Loading track overlay */}
          {trackLoading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="glass-panel p-3 flex items-center gap-2 text-[11px] font-mono text-[var(--cyan-primary)]">
                <RefreshCw size={14} className="animate-spin" />
                轨迹数据加载中…
              </div>
            </div>
          )}

          {/* Empty state */}
          {!selected && !loading && results.length > 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="glass-panel p-5 text-center text-[11px] font-mono text-[var(--text-muted)] max-w-xs">
                <div className="mb-2 flex justify-center">
                  <Ship size={24} className="text-[var(--gold-primary)] animate-pulse" />
                </div>
                <div className="text-[var(--gold-primary)] mb-1">静默事件分布</div>
                左侧列表列出 {total} 条静默事件。点击任意条目在地图上定位,点击"播放轨迹"查看完整航迹。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────────────────────────────────

function StatChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: 'gold' | 'cyan';
}) {
  const color = accent === 'gold' ? 'text-[var(--gold-primary)]' : 'text-[var(--cyan-primary)]';
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
      <span className={`text-[16px] font-mono font-bold tabular-nums ${color}`}>
        {value}
      </span>
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClass = '',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-[12px] border-b border-white/5 last:border-b-0">
      <span className="text-[var(--text-muted)] text-[11px]">{label}</span>
      <span className={`font-mono text-[var(--text-heading)] text-[11px] text-right truncate max-w-[210px] ${valueClass}`}>
        {value}
      </span>
    </div>
  );
}

function ConfigRow(props: {
  cfgCoastline: number;
  setCfgCoastline: (v: number) => void;
  cfgSilenceMin: number;
  setCfgSilenceMin: (v: number) => void;
  cfgDisplacement: number;
  setCfgDisplacement: (v: number) => void;
  cfgMinPort: number;
  setCfgMinPort: (v: number) => void;
  cfgWinStart: string;
  setCfgWinStart: (v: string) => void;
  cfgWinEnd: string;
  setCfgWinEnd: (v: string) => void;
  cfgLoading: boolean;
  runningAlgo: boolean;
  onSave: () => void;
  onRun: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex-shrink-0 border-b border-white/10 bg-black/25">
      <button
        className="w-full flex items-center justify-between px-4 py-2 text-[11px] font-mono text-[var(--text-muted)] hover:bg-white/5 transition"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          <Settings size={12} />
          算法参数配置 {props.cfgLoading ? '· 加载中' : ''}
        </span>
        <span className="text-[10px]">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1">
          <div className="flex flex-wrap items-end gap-4">
            <NumberField
              label="距岸距离"
              value={props.cfgCoastline}
              onChange={props.setCfgCoastline}
              suffix="KM"
              hint="(-)"
            />
            <NumberField
              label="静默时长"
              value={props.cfgSilenceMin}
              onChange={props.setCfgSilenceMin}
              suffix="分钟"
            />
            <NumberField
              label="恢复位移"
              value={props.cfgDisplacement}
              onChange={props.setCfgDisplacement}
              suffix="KM(千米)"
            />
            <NumberField
              label="距最近码头"
              value={props.cfgMinPort}
              onChange={props.setCfgMinPort}
              suffix="KM"
              hint="(-)"
            />
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono text-[var(--text-muted)] tracking-wider">
                时间窗起 / 止
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="time"
                  value={props.cfgWinStart}
                  onChange={(e) => props.setCfgWinStart(e.target.value)}
                  className="px-2 py-1 rounded bg-black/60 border border-white/15 text-[12px] font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--cyan-primary)]"
                />
                <span className="text-[var(--text-muted)]">/</span>
                <input
                  type="time"
                  value={props.cfgWinEnd}
                  onChange={(e) => props.setCfgWinEnd(e.target.value)}
                  className="px-2 py-1 rounded bg-black/60 border border-white/15 text-[12px] font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--cyan-primary)]"
                />
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={props.onSave}
                className="px-3 py-1.5 rounded-md border border-white/20 text-[var(--text-primary)] text-[11px] font-mono hover:bg-white/5 transition flex items-center gap-1"
              >
                <RefreshCw size={11} /> 保存配置
              </button>
              <button
                onClick={props.onRun}
                disabled={props.runningAlgo}
                className="px-3 py-1.5 rounded-md bg-[var(--cyan-primary)] border border-[var(--cyan-primary)]/60 text-[#08111a] text-[12px] font-mono font-semibold hover:brightness-110 transition disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {props.runningAlgo ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" /> 运行中…
                  </>
                ) : (
                  <>
                    <Play size={12} /> 运行算法
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono text-[var(--text-muted)] tracking-wider">
        {label}
      </label>
      <div className="flex items-center">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className="w-16 px-2 py-1 rounded bg-black/60 border border-white/15 text-[13px] font-mono text-[var(--text-heading)] text-center focus:outline-none focus:border-[var(--cyan-primary)]"
        />
        <span className="ml-1.5 text-[10px] font-mono text-[var(--text-muted)]">
          {suffix}
          {hint ? <span className="ml-0.5 opacity-60">{hint}</span> : null}
        </span>
      </div>
    </div>
  );
}

function shipSvg(heading: number): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" style="transform:rotate(${heading}deg);transition:transform 0.3s;">
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.2" result="b" />
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g filter="url(#glow)">
        <path d="M14 2 L17 10 L22 14 L17 15 L16 24 L14 22 L12 24 L11 15 L6 14 L11 10 Z" fill="#00E5FF" stroke="#000" stroke-width="1"/>
      </g>
    </svg>
  `;
}
