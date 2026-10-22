'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Search, X, MapPin, Navigation, Building2, Globe2, Landmark, Plane, Ship, Satellite } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — Enhanced Search / Locate Bar
   Street-level geocoding with intelligent zoom levels
   Ctrl+F / Cmd+F keyboard shortcut support
   ═══════════════════════════════════════════════════════════════ */

interface SearchResult {
  label: string;
  lat: number;
  lng: number;
  type: string;          // nominatim type (e.g. 'house', 'road', 'city')
  importance: number;    // nominatim importance score
  category: string;      // nominatim class (e.g. 'place', 'highway', 'building')
  zoomLevel: number;     // computed ideal zoom
}

interface SearchBarProps {
  onLocate: (lat: number, lng: number, zoom?: number) => void;
  alwaysExpanded?: boolean;
  /** Live moving entities to match by identity (flights, ships, satellites). */
  entities?: { flights?: any[]; ships?: any[]; satellites?: any[] };
  /** Called when an entity row is chosen — locate, highlight and open its detail. */
  onLocateEntity?: (t: { kind: EntityKind; id: string; label: string; lat: number; lng: number }) => void;
}

type EntityKind = 'flight' | 'ship' | 'satellite';

/** A matched moving entity, tagged with its kind and current position. */
interface EntityResult {
  kind: EntityKind;
  id: string;
  label: string;
  secondary: string;
  lat: number;
  lng: number;
}

type FlatRow =
  | { kind: 'entity'; e: EntityResult }
  | { kind: 'place'; p: SearchResult };

const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  flight: 'FLIGHT',
  ship: 'SHIP',
  satellite: 'SAT',
};

const ENTITY_MATCH_LIMIT_PER_KIND = 6;
const ENTITY_MATCH_LIMIT_TOTAL = 12;

function getEntityIcon(kind: EntityKind) {
  if (kind === 'flight') return <Plane className="w-3 h-3 text-[var(--cyan-primary)] flex-shrink-0" />;
  if (kind === 'ship') return <Ship className="w-3 h-3 text-[var(--alert-green)] flex-shrink-0" />;
  return <Satellite className="w-3 h-3 text-[var(--gold-primary)] flex-shrink-0" />;
}

/**
 * Local, synchronous identity match over the moving entities. Case-insensitive
 * prefix matches rank above plain substrings, and each kind is capped so one
 * crowded domain cannot bury the others.
 */
function collectEntityMatches(entities: NonNullable<SearchBarProps['entities']>, query: string): EntityResult[] {
  const specs: Array<{
    kind: EntityKind;
    rows: any[];
    fields: (row: any) => Array<string | number | null | undefined>;
    id: (row: any) => string;
    label: (row: any) => string;
    secondary: (row: any) => string;
  }> = [
    {
      kind: 'flight',
      rows: entities.flights || [],
      fields: (f) => [f.callsign, f.icao24, f.registration, f.model],
      id: (f) => String(f.icao24 || f.callsign || ''),
      label: (f) => String(f.callsign || f.icao24 || f.registration || '').trim(),
      secondary: (f) => String(f.icao24 || ''),
    },
    {
      kind: 'ship',
      rows: entities.ships || [],
      fields: (s) => [s.name, s.mmsi, s.imo],
      id: (s) => String(s.mmsi || ''),
      label: (s) => String(s.name || (s.mmsi ? `MMSI-${s.mmsi}` : '')).trim(),
      secondary: (s) => (s.mmsi ? `MMSI-${s.mmsi}` : s.imo ? `IMO-${s.imo}` : ''),
    },
    {
      kind: 'satellite',
      rows: entities.satellites || [],
      fields: (s) => [s.name, s.noradId],
      id: (s) => String(s.noradId || ''),
      label: (s) => String(s.name || '').trim(),
      secondary: (s) => (s.noradId ? `NORAD ${s.noradId}` : ''),
    },
  ];

  const out: EntityResult[] = [];
  for (const spec of specs) {
    const prefix: EntityResult[] = [];
    const substring: EntityResult[] = [];
    for (const row of spec.rows) {
      const lat = Number(row?.lat);
      const lng = Number(row?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const id = spec.id(row);
      if (!id) continue;
      let rank = -1;
      for (const field of spec.fields(row)) {
        const text = String(field ?? '').toLowerCase();
        if (!text) continue;
        if (text.startsWith(query)) { rank = 0; break; }
        if (text.includes(query) && rank < 1) rank = 1;
      }
      if (rank < 0) continue;
      (rank === 0 ? prefix : substring).push({
        kind: spec.kind,
        id,
        label: spec.label(row) || id,
        secondary: spec.secondary(row),
        lat,
        lng,
      });
    }
    out.push(...[...prefix, ...substring].slice(0, ENTITY_MATCH_LIMIT_PER_KIND));
    if (out.length >= ENTITY_MATCH_LIMIT_TOTAL) break;
  }
  return out.slice(0, ENTITY_MATCH_LIMIT_TOTAL);
}

// Map Nominatim result types to appropriate zoom levels
function getZoomForType(type: string, category: string, boundingbox?: string[]): number {
  // If we have a bounding box, use it to estimate zoom
  if (boundingbox && boundingbox.length === 4) {
    const latDiff = Math.abs(parseFloat(boundingbox[1]) - parseFloat(boundingbox[0]));
    const lngDiff = Math.abs(parseFloat(boundingbox[3]) - parseFloat(boundingbox[2]));
    const maxDiff = Math.max(latDiff, lngDiff);
    // Rough zoom estimation from bounding box span
    if (maxDiff < 0.002) return 19;  // building / address
    if (maxDiff < 0.01) return 17;   // street block
    if (maxDiff < 0.05) return 15;   // neighborhood
    if (maxDiff < 0.2) return 13;    // small town
    if (maxDiff < 1) return 11;      // city
    if (maxDiff < 5) return 8;       // region
    if (maxDiff < 20) return 6;      // country
    return 4;                        // continent
  }

  // Fallback: type-based zoom
  if (['house', 'building', 'address', 'shop', 'amenity', 'office'].includes(type)) return 18;
  if (['road', 'street', 'highway', 'path', 'residential', 'tertiary', 'secondary', 'primary'].includes(type)) return 17;
  if (['neighbourhood', 'quarter', 'suburb', 'hamlet', 'isolated_dwelling'].includes(type)) return 15;
  if (['village', 'town', 'borough'].includes(type)) return 14;
  if (['city', 'municipality'].includes(type)) return 12;
  if (['county', 'state_district', 'state', 'province'].includes(type)) return 8;
  if (['country'].includes(type)) return 5;
  if (['continent'].includes(type)) return 3;
  if (category === 'boundary') return 8;
  if (category === 'place') return 13;
  if (category === 'highway') return 17;
  if (category === 'building') return 18;
  if (category === 'amenity') return 17;
  return 13; // safe default
}

// Icon for result type
function getResultIcon(type: string, category: string) {
  if (['house', 'building', 'address', 'shop', 'amenity', 'office'].includes(type) || category === 'building') {
    return <Building2 className="w-3 h-3 text-[var(--cyan-primary)] flex-shrink-0" />;
  }
  if (['road', 'street', 'highway', 'path'].includes(type) || category === 'highway') {
    return <Navigation className="w-3 h-3 text-[var(--alert-green)] flex-shrink-0" />;
  }
  if (['country', 'continent', 'state'].includes(type)) {
    return <Globe2 className="w-3 h-3 text-[var(--gold-primary)] flex-shrink-0" />;
  }
  if (['city', 'town', 'village', 'municipality'].includes(type)) {
    return <Landmark className="w-3 h-3 text-[#FF9500] flex-shrink-0" />;
  }
  return <MapPin className="w-3 h-3 text-[var(--gold-primary)] flex-shrink-0" />;
}

// Format label: keep it concise
function formatLabel(displayName: string): { primary: string; secondary: string } {
  const parts = displayName.split(',').map(s => s.trim());
  if (parts.length <= 1) return { primary: parts[0] || '', secondary: '' };
  return {
    primary: parts.slice(0, 2).join(', '),
    secondary: parts.slice(2, 4).join(', '),
  };
}

export default function SearchBar({ onLocate, alwaysExpanded = false, entities, onLocateEntity }: SearchBarProps) {
  const [open, setOpen] = useState(alwaysExpanded);
  const [value, setValue] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [entityResults, setEntityResults] = useState<EntityResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Entities first, then places/coordinates — one flat list drives arrow-key
  // navigation while the dropdown still renders them in two labelled groups.
  const rows = useMemo<FlatRow[]>(() => [
    ...entityResults.map(e => ({ kind: 'entity' as const, e })),
    ...results.map(p => ({ kind: 'place' as const, p })),
  ], [entityResults, results]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Ctrl+F / Cmd+F keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 50);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Close when clicking outside
  useEffect(() => {
    if (!open || alwaysExpanded) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setResults([]);
        setEntityResults([]);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, alwaysExpanded]);

  const parseCoords = (s: string): { lat: number; lng: number } | null => {
    const m = s.trim().match(/^([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    return null;
  };

  const handleSearch = useCallback((q: string) => {
    setValue(q);
    setSelectedIdx(-1);

    // Entity matches are local and synchronous — no debounce, no network.
    const query = q.trim().toLowerCase();
    setEntityResults(entities && query.length >= 1 ? collectEntityMatches(entities, query) : []);

    // Direct coordinate input
    const coords = parseCoords(q);
    if (coords) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setResults([{
        label: `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`,
        ...coords,
        type: 'coordinate',
        importance: 1,
        category: 'coordinate',
        zoomLevel: 15,
      }]);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.trim().length < 2) { setResults([]); return; }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        // Use addressdetails=1 for better type detection and limit=8 for more results
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1&extratags=1`,
          { headers: { 'Accept-Language': 'en', 'User-Agent': 'OSIRIS-Intelligence-Platform/1.0' } }
        );
        const data = await res.json();
        setResults(data.map((r: any) => {
          const zoom = getZoomForType(r.type, r.class, r.boundingbox);
          return {
            label: r.display_name,
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            type: r.type || 'unknown',
            importance: r.importance || 0,
            category: r.class || 'unknown',
            zoomLevel: zoom,
          };
        }));
      } catch { setResults([]); }
      setLoading(false);
    }, 300);
  }, [entities]);

  const handleSelect = (row: FlatRow) => {
    if (row.kind === 'entity') {
      onLocateEntity?.({ kind: row.e.kind, id: row.e.id, label: row.e.label, lat: row.e.lat, lng: row.e.lng });
    } else {
      onLocate(row.p.lat, row.p.lng, row.p.zoomLevel);
    }
    if (!alwaysExpanded) setOpen(false);
    setValue('');
    setResults([]);
    setEntityResults([]);
    setSelectedIdx(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (alwaysExpanded) {
        setValue('');
        setResults([]);
        setEntityResults([]);
        inputRef.current?.blur();
      } else {
        setOpen(false);
        setValue('');
        setResults([]);
        setEntityResults([]);
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, rows.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0 && selectedIdx < rows.length) {
        handleSelect(rows[selectedIdx]);
      } else if (rows.length > 0) {
        handleSelect(rows[0]);
      }
    }
  };

  if (!open && !alwaysExpanded) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 glass-panel-sm px-3 py-2 text-[10px] font-mono tracking-[0.15em] text-[var(--text-muted)] hover:text-[var(--gold-primary)] hover:border-[var(--border-active)] transition-all hover:shadow-[0_0_12px_rgba(212,175,55,0.08)]"
      >
        <Search className="w-3 h-3" />
        命令：定位
      </button>
    );
  }

  return (
    <div className="relative w-full" ref={containerRef}>
      <div className="flex items-center gap-2 glass-panel px-3 py-2.5 !border-[var(--border-active)] transition-all"
        style={{ boxShadow: '0 0 20px rgba(212,175,55,0.05), inset 0 0 20px rgba(0,0,0,0.2)' }}
      >
        <Search className="w-3.5 h-3.5 text-[var(--gold-primary)] flex-shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => handleSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索飞机、船舶、卫星、地址或坐标..."
          className="flex-1 bg-transparent text-[11px] text-[var(--text-primary)] font-mono tracking-wider outline-none placeholder:text-[var(--text-muted)]"
          autoComplete="off"
          spellCheck={false}
        />
        {loading && <div className="w-3 h-3 border border-[var(--gold-primary)] border-t-transparent rounded-full animate-spin" />}
        <span className="text-[9px] text-[var(--text-muted)] font-mono opacity-50 hidden md:inline">CTRL+F</span>
        {(value || !alwaysExpanded) && (
          <button onClick={() => {
            if (alwaysExpanded) { setValue(''); setResults([]); setEntityResults([]); }
            else { setOpen(false); setValue(''); setResults([]); setEntityResults([]); }
          }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {rows.length > 0 && (
        <div
          className="absolute top-full left-0 right-0 mt-1 glass-panel overflow-hidden max-h-[320px] overflow-y-auto styled-scrollbar z-[9999]"
          style={{ boxShadow: '0 12px 40px rgba(0,0,0,0.6), 0 0 1px rgba(212,175,55,0.2)' }}
        >
          {entityResults.length > 0 && (
            <>
              <div className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-[0.2em] text-[var(--text-muted)]">实体</div>
              {entityResults.map((r, i) => {
                const isSelected = i === selectedIdx;
                return (
                  <button
                    key={`${r.kind}-${r.id}-${i}`}
                    onClick={() => handleSelect({ kind: 'entity', e: r })}
                    onMouseEnter={() => setSelectedIdx(i)}
                    className={`w-full text-left px-3 py-2.5 transition-colors border-b border-[var(--border-secondary)] flex items-start gap-2.5 ${
                      isSelected ? 'bg-[rgba(212,175,55,0.08)]' : 'hover:bg-[var(--hover-accent)]'
                    }`}
                  >
                    <div className="mt-0.5">{getEntityIcon(r.kind)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-[var(--text-primary)] font-mono truncate leading-tight">{r.label}</div>
                      {r.secondary && (
                        <div className="text-[9px] text-[var(--text-muted)] font-mono truncate mt-0.5">{r.secondary}</div>
                      )}
                    </div>
                    <div className="flex flex-col items-end flex-shrink-0">
                      <span className="text-[9px] text-[var(--text-muted)] font-mono uppercase tracking-wider">{ENTITY_KIND_LABEL[r.kind]}</span>
                      <span className="text-[9px] text-[var(--gold-primary)] font-mono opacity-40">{r.lat.toFixed(2)}, {r.lng.toFixed(2)}</span>
                    </div>
                  </button>
                );
              })}
            </>
          )}
          {results.length > 0 && (
            <>
              {entityResults.length > 0 && (
                <div className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-[0.2em] text-[var(--text-muted)]">地名 / 坐标</div>
              )}
              {results.map((r, j) => {
                const i = entityResults.length + j;
                const { primary, secondary } = formatLabel(r.label);
                const isSelected = i === selectedIdx;
                return (
                  <button
                    key={i}
                    onClick={() => handleSelect({ kind: 'place', p: r })}
                    onMouseEnter={() => setSelectedIdx(i)}
                    className={`w-full text-left px-3 py-2.5 transition-colors border-b border-[var(--border-secondary)] last:border-0 flex items-start gap-2.5 ${
                      isSelected ? 'bg-[rgba(212,175,55,0.08)]' : 'hover:bg-[var(--hover-accent)]'
                    }`}
                  >
                    <div className="mt-0.5">{getResultIcon(r.type, r.category)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-[var(--text-primary)] font-mono truncate leading-tight">{primary}</div>
                      {secondary && (
                        <div className="text-[9px] text-[var(--text-muted)] font-mono truncate mt-0.5">{secondary}</div>
                      )}
                    </div>
                    <div className="flex flex-col items-end flex-shrink-0">
                      <span className="text-[9px] text-[var(--text-muted)] font-mono uppercase tracking-wider">
                        {r.type === 'coordinate' ? 'COORDS' : r.type}
                      </span>
                      <span className="text-[9px] text-[var(--gold-primary)] font-mono opacity-40">
                        Z{r.zoomLevel}
                      </span>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
