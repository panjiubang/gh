import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface AlgoParams {
  coastlineDistanceKm: number;
  silenceDurationMin: number;
  restartDisplacementKm: number;
  minPortDistanceKm: number;
  silenceTimeWindow: { start: string; end: string };
}

interface CoastSegment {
  coords: number[][]; // [[lng, lat], ...]
}

interface Port {
  name: string;
  lng: number;
  lat: number;
  type: string;
  source: string;
}

interface CoastData {
  meta?: any;
  segments: CoastSegment[];
}

interface PortsData {
  ports: Port[];
}

// ── Haversine km ──
function haversineKm(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const x = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

// ── Point-to-segment minimum distance (km) ──
function distPointToSegmentKm(
  pt: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  // Fast approx: if segment endpoints are close compared to distances we care about (< ~10km),
  // treat as haversine to nearest endpoint. For coastline this is precise enough.
  const dA = haversineKm(pt, a);
  const dB = haversineKm(pt, b);
  return Math.min(dA, dB);
}

// ── Point-to-segment precise (for better accuracy) ──
function nearestCoastKm(
  pt: [number, number],
  flat: { lng: number; lat: number }[]
): number {
  let min = Infinity;
  // Search in tile-bounded subset: skip points far away in degrees first
  const dLatThresh = 0.2; // ~22km
  const dLngThresh = 0.2;
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i];
    if (Math.abs(p.lat - pt[1]) > dLatThresh) continue;
    if (Math.abs(p.lng - pt[0]) > dLngThresh) continue;
    const d = haversineKm(pt, [p.lng, p.lat]);
    if (d < min) {
      min = d;
      if (min < 0.5) return min; // early exit if very close
    }
  }
  if (min === Infinity) return 500;
  return min;
}

// ── Parse "HH:MM" to minutes since midnight ──
function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map((s) => parseInt(s, 10));
  return h * 60 + m;
}

// ── Is HH:MM within window? Window may wrap midnight (18:00→06:00) ──
function isInWindow(hhmm: string, winStart: string, winEnd: string): boolean {
  const t = hmToMin(hhmm);
  const s = hmToMin(winStart);
  const e = hmToMin(winEnd);
  if (s <= e) return t >= s && t <= e;
  return t >= s || t <= e;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await req.json();
    const p: AlgoParams = {
      coastlineDistanceKm: body?.coastlineDistanceKm ?? 5,
      silenceDurationMin: body?.silenceDurationMin ?? 45,
      restartDisplacementKm: body?.restartDisplacementKm ?? 10,
      minPortDistanceKm: body?.minPortDistanceKm ?? 3,
      silenceTimeWindow: body?.silenceTimeWindow ?? { start: '18:00', end: '06:00' },
    };

    // ── 1. Load coastline ──
    const base = path.join(process.cwd(), 'src', 'lib', 'zssf-data');
    const coastRaw = fs.readFileSync(path.join(base, 'coastline-gz.json'), 'utf8');
    const coastData: CoastData = JSON.parse(coastRaw);

    // Flatten all segment coords into a single point array (sample sparsely to keep perf)
    const flatCoast: { lng: number; lat: number }[] = [];
    const targetCoastPoints = 8000; // keep ~8k points, enough for 1km accuracy
    let totalCoast = 0;
    for (const seg of coastData.segments || []) {
      totalCoast += seg.coords?.length ?? 0;
    }
    const step = Math.max(1, Math.floor(totalCoast / targetCoastPoints));
    let idx = 0;
    for (const seg of coastData.segments || []) {
      for (const c of seg.coords || []) {
        if (idx % step === 0) {
          flatCoast.push({ lng: c[0], lat: c[1] });
        }
        idx++;
      }
    }

    // ── 2. Load ports ──
    const portsRaw = fs.readFileSync(path.join(base, 'ports.json'), 'utf8');
    const portsData: PortsData = JSON.parse(portsRaw);
    const ports = (portsData.ports || []).map((pt) => ({
      name: pt.name || '',
      lng: pt.lng,
      lat: pt.lat,
      type: pt.type || '',
    }));

    // ── 3. Fetch AIS records, grouped by MMSI ──
    // Scan ALL data (limited by row count to keep runtime reasonable)
    const [rows] = await pool.query(
      `SELECT mmsi, ts_local, latitude, longitude,
              sog_kn, nav_status_text, vessel_name, destination,
              flag_country_cn, vessel_type_name
       FROM ais_origin_record
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY mmsi ASC, ts_local ASC
       LIMIT 100000`
    );

    // Group by mmsi
    const byMmsi = new Map<number | string, any[]>();
    for (const r of rows as any[]) {
      const key = r.mmsi;
      if (!byMmsi.has(key)) byMmsi.set(key, []);
      byMmsi.get(key)!.push(r);
    }

    // ── 4. Scan gaps per vessel ──
    const found: any[] = [];
    const gapMs = p.silenceDurationMin * 60 * 1000;
    const winStart = p.silenceTimeWindow?.start ?? '18:00';
    const winEnd = p.silenceTimeWindow?.end ?? '06:00';

    for (const [mmsi, pts] of byMmsi) {
      if (pts.length < 2) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const cur = pts[i];
        const nxt = pts[i + 1];
        const tCur = new Date(cur.ts_local).getTime();
        const tNxt = new Date(nxt.ts_local).getTime();
        if (Number.isNaN(tCur) || Number.isNaN(tNxt)) continue;
        const gap = tNxt - tCur;
        if (gap < gapMs) continue;

        // start point = last AIS before silence
        const sLng = cur.longitude;
        const sLat = cur.latitude;
        // end point = first AIS after silence
        const eLng = nxt.longitude;
        const eLat = nxt.latitude;
        const silentDurMin = gap / 60000;

        // 4a. Time window check — start time must be in window
        const d = new Date(tCur);
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        if (!isInWindow(hhmm, winStart, winEnd)) continue;

        // 4b. Distance to coastline (sampled)
        const coastKm = nearestCoastKm([sLng, sLat], flatCoast);
        if (coastKm < p.coastlineDistanceKm) continue;

        // 4c. Distance to nearest port
        let nearestPortKm = Infinity;
        let nearestPortName = '';
        for (const port of ports) {
          const d2 = haversineKm([sLng, sLat], [port.lng, port.lat]);
          if (d2 < nearestPortKm) {
            nearestPortKm = d2;
            nearestPortName = port.name || port.type || '';
          }
        }
        if (nearestPortKm < p.minPortDistanceKm) continue;

        // 4d. Displacement
        const dispKm = haversineKm([sLng, sLat], [eLng, eLat]);
        if (dispKm > p.restartDisplacementKm) continue;

        found.push({
          mmsi: Number(mmsi) || mmsi,
          silent_start_time: cur.ts_local,
          silent_end_time: nxt.ts_local,
          silent_duration_min: silentDurMin.toFixed(2),
          silent_start_lng: sLng,
          silent_start_lat: sLat,
          silent_end_lng: eLng,
          silent_end_lat: eLat,
          coastline_distance_km: coastKm.toFixed(2),
          displacement_km: dispKm.toFixed(2),
          nearest_port_distance_km: nearestPortKm === Infinity ? null : nearestPortKm.toFixed(2),
          nearest_port_name: nearestPortName || null,
          sog_before: cur.sog_kn ?? null,
          sog_after: nxt.sog_kn ?? null,
          nav_status_before: cur.nav_status_text ?? null,
          nav_status_after: nxt.nav_status_text ?? null,
          vessel_name: cur.vessel_name ?? null,
          destination: cur.destination ?? null,
          flag_country_cn: cur.flag_country_cn ?? null,
          vessel_type_name: cur.vessel_type_name ?? null,
        });
      }
    }

    // ── 5. Write to risk_zousi (upsert by mmsi + start_time) ──
    let inserted = 0;
    // 21 columns: mmsi + vessel_name + silent_start_time + silent_end_time +
    //   silent_duration_min + silent_start_lng + silent_start_lat +
    //   silent_end_lng + silent_end_lat + coastline_distance_km +
    //   nearest_port_distance_km + nearest_port_name +
    //   displacement_km + sog_before + sog_after +
    //   nav_status_before + nav_status_after +
    //   flag_country_cn + vessel_type_name + destination + create_time
    const PLACEHOLDERS_PER_ROW = 21;
    const placeholders = found.map(() => '(' + '?,'.repeat(PLACEHOLDERS_PER_ROW - 1) + '?)').join(',');
    if (found.length > 0) {
      const values: any[] = [];
      for (const f of found) {
        values.push(
          f.mmsi, f.vessel_name, f.silent_start_time, f.silent_end_time,
          f.silent_duration_min, f.silent_start_lng, f.silent_start_lat,
          f.silent_end_lng, f.silent_end_lat, f.coastline_distance_km,
          f.nearest_port_distance_km, f.nearest_port_name,
          f.displacement_km, f.sog_before, f.sog_after,
          f.nav_status_before, f.nav_status_after,
          f.flag_country_cn, f.vessel_type_name, f.destination,
          new Date()
        );
      }
      const [res] = await pool.query(
        `INSERT INTO risk_zousi
          (mmsi, vessel_name, silent_start_time, silent_end_time,
           silent_duration_min, silent_start_lng, silent_start_lat,
           silent_end_lng, silent_end_lat, coastline_distance_km,
           nearest_port_distance_km, nearest_port_name,
           displacement_km, sog_before, sog_after,
           nav_status_before, nav_status_after,
           flag_country_cn, vessel_type_name, destination, create_time)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           silent_end_time=VALUES(silent_end_time),
           silent_duration_min=VALUES(silent_duration_min),
           silent_end_lng=VALUES(silent_end_lng),
           silent_end_lat=VALUES(silent_end_lat),
           coastline_distance_km=VALUES(coastline_distance_km),
           nearest_port_distance_km=VALUES(nearest_port_distance_km),
           nearest_port_name=VALUES(nearest_port_name),
           displacement_km=VALUES(displacement_km),
           sog_before=VALUES(sog_before),
           sog_after=VALUES(sog_after),
           nav_status_before=VALUES(nav_status_before),
           nav_status_after=VALUES(nav_status_after),
           vessel_name=VALUES(vessel_name),
           flag_country_cn=VALUES(flag_country_cn),
           vessel_type_name=VALUES(vessel_type_name),
           destination=VALUES(destination),
           create_time=VALUES(create_time)`,
        values
      );
      inserted = (res as any).affectedRows ?? 0;
    }

    const elapsedMs = Date.now() - startedAt;
    return NextResponse.json({
      ok: true,
      scannedRecords: (rows as any[]).length,
      scannedVessels: byMmsi.size,
      detectedSilences: found.length,
      inserted,
      elapsedMs,
      params: p,
    });
  } catch (e: any) {
    console.error('ZSSF run error:', e.message);
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
