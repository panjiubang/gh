import { NextResponse } from 'next/server';
import mysql from 'mysql2/promise';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// 复用全局连接池，避免每次请求都创建新连接
let pool: mysql.Pool | null = null;
function getPool(): mysql.Pool {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'demo',
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });
  return pool;
}

/** 数据来源标志 → 可读名称 */
const FLAG_NAMES: Record<string, string> = {
  '1': 'ADS-B Exchange',
  '2': 'PlaneSpotters',
  '3': 'AirNavRadar',
  '4': 'Flightradar24',
};

/** Unix 毫秒时间戳 → "YYYY-MM-DD HH:mm:ss"（北京时间） */
function formatBeijingTime(ts: string | number | null): string {
  if (!ts) return '—';
  const num = typeof ts === 'string' ? parseFloat(ts) : ts;
  if (isNaN(num)) return '—';
  // locationtime/now_time 是秒级 Unix 时间戳，但有些可能带毫秒
  const seconds = num > 1e12 ? num / 1000 : num;
  const date = new Date(seconds * 1000);
  // 北京时间 UTC+8
  const beijing = new Date(date.getTime() + 8 * 3600 * 1000);
  const yyyy = beijing.getUTCFullYear();
  const mm = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(beijing.getUTCDate()).padStart(2, '0');
  const hh = String(beijing.getUTCHours()).padStart(2, '0');
  const mi = String(beijing.getUTCMinutes()).padStart(2, '0');
  const ss = String(beijing.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export async function GET() {
  try {
    const conn = getPool();
    const [rows] = await conn.query<any[]>(
      `SELECT icao, callsign, regist, longitude, latitude,
              heading, speed, altitude, locationtime, now_time,
              aircraft_type, flight, flag, update_time
       FROM aircraft_track_latest
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY callsign ASC`
    );

    // 转为前端可直接使用的格式
    const aircraft = rows.map((r) => ({
      icao24: r.icao || '',
      callsign: (r.callsign || '').trim(),
      registration: r.regist || '',
      lng: parseFloat(r.longitude),
      lat: parseFloat(r.latitude),
      heading: parseFloat(r.heading) || 0,
      speed_knots: parseFloat(r.speed) || 0,
      alt: parseInt(r.altitude, 10) || 0,
      model: r.aircraft_type || '',
      flight: (r.flight || '').trim(),
      source: FLAG_NAMES[r.flag] || '未知',
      location_time: formatBeijingTime(r.locationtime),
      now_time: formatBeijingTime(r.now_time),
      update_time: r.update_time
        ? new Date(r.update_time).toISOString()
        : null,
    }));

    return NextResponse.json({
      total: aircraft.length,
      aircraft,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    console.error('[HYD-Aircraft] DB error:', err.message);
    return NextResponse.json(
      { error: 'DATABASE_ERROR', message: err.message, total: 0, aircraft: [] },
      { status: 200 } // 返回 200 避免前端崩溃
    );
  }
}
