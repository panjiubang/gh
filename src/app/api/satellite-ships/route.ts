import { NextResponse } from 'next/server';
import mysql from 'mysql2/promise';

/**
 * OSIRIS — Satellite Ships (from MySQL AIS satellite tracking)
 * Reads vessel positions from hifleet_lastest_trace and emits GeoJSON
 * features for the OsirisMap circle/symbol layers.
 */

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'demo',
};

const CACHE_TTL_MS = 30_000; // 30s — AIS satellite feed refreshes roughly every 1-2 min

const globalForSatShips = globalThis as unknown as {
  satShipsSnapshot?: { body: string; builtAt: number };
  satShipsConnPool?: mysql.Pool;
};

function getPool(): mysql.Pool {
  if (!globalForSatShips.satShipsConnPool) {
    globalForSatShips.satShipsConnPool = mysql.createPool({
      ...DB_CONFIG,
      waitForConnections: true,
      connectionLimit: 4,
      queueLimit: 0,
    });
  }
  return globalForSatShips.satShipsConnPool;
}

/** Map DB `type` strings → OSIRIS layer colors. */
function shipTypeColor(type: string): string {
  const t = (type || '').toLowerCase();
  if (t.includes('军') || t.includes('military') || t.includes('navy')) return '#D32F2F';
  if (t.includes('油') || t.includes('tanker')) return '#E65100';
  if (t.includes('货') || t.includes('cargo') || t.includes('container')) return '#26C6DA';
  if (t.includes('客') || t.includes('passenger')) return '#7E57C2';
  if (t.includes('拖') || t.includes('tug')) return '#F9A825';
  return '#B0BEC5';
}

/** Map DB `status` strings to simple English labels for the popup. */
function shipStatus(status: string): string {
  if (!status) return 'Unknown';
  const s = status.trim();
  if (s === '未知') return 'Unknown';
  if (s === '航行中') return 'Underway';
  if (s === '锚泊') return 'Anchored';
  if (s === '停靠') return 'Moored';
  if (s === '漂移') return 'Drifting';
  return s;
}

async function buildSnapshot(now: number): Promise<string> {
  const pool = getPool();

  // Query all ships with valid coordinates — no pagination, the table is ~14k rows.
  // Only SELECT columns we actually read keeps the transfer tight.
  const [rows] = await pool.query<any[]>(
    `SELECT id, callsign, destination, dn, lat, lon, mmsi, name, speed, status, type, length, width, draught, updatetimestamp, updatetime
     FROM hifleet_lastest_trace
     WHERE lat IS NOT NULL AND lon IS NOT NULL AND lat != 0 AND lon != 0`
  );

  const features = rows.map(r => {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [lon, lat] as [number, number],
      },
      properties: {
        id: String(r.id),
        mmsi: r.mmsi ?? '',
        name: r.name ?? '',
        callsign: r.callsign ?? '',
        status: shipStatus(r.status),
        destination: r.destination ?? '',
        type: r.type ?? '',
        color: shipTypeColor(r.type ?? ''),
        speed: Number(r.speed ?? 0),
        length: r.length ?? '',
        width: r.width ?? '',
        draught: r.draught ?? '',
        dn: r.dn ?? '',
        updatetimestamp: Number(r.updatetimestamp ?? 0),
        updatetime: r.updatetime ? new Date(r.updatetime).toISOString() : '',
        // Keep the full snake_case row too — popup renders ALL fields
        raw: { ...r },
      },
    };
  });

  const body = JSON.stringify({
    type: 'FeatureCollection',
    features,
    total: features.length,
    timestamp: new Date(now).toISOString(),
  });

  return body;
}

export async function GET() {
  const now = Date.now();
  const cached = globalForSatShips.satShipsSnapshot;

  try {
    const snapshot = cached && now - cached.builtAt < CACHE_TTL_MS
      ? cached
      : { body: await buildSnapshot(now), builtAt: now };
    globalForSatShips.satShipsSnapshot = snapshot;

    const maxAgeSeconds = Math.floor(CACHE_TTL_MS / 1000);
    return new NextResponse(snapshot.body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=15`,
      },
    });
  } catch (err: any) {
    console.error('[OSIRIS] satellite-ships query failed:', err?.message || err);

    // Stale-on-error: if we have anything at all, serve it rather than 500.
    if (cached) {
      return new NextResponse(cached.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-OSIRIS-Stale': '1',
        },
      });
    }

    return NextResponse.json(
      { error: 'satellite-ships unavailable', detail: err?.message || String(err) },
      { status: 503 }
    );
  }
}
