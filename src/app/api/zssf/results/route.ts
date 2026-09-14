import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const keyword = searchParams.get('keyword') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10) || 50));
    const minDuration = searchParams.get('minDuration') || '';
    const minCoastDist = searchParams.get('minCoastDist') || '';

    const where: string[] = [];
    const params: any[] = [];
    if (keyword) {
      const kw = '%' + keyword + '%';
      where.push('(CAST(mmsi AS CHAR) LIKE ? OR vessel_name LIKE ?)');
      params.push(kw, kw);
    }
    if (minDuration) {
      where.push('silent_duration_min >= ?');
      params.push(parseFloat(minDuration));
    }
    if (minCoastDist) {
      where.push('coastline_distance_km >= ?');
      params.push(parseFloat(minCoastDist));
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (page - 1) * pageSize;

    const [cntRows] = await pool.query(
      'SELECT COUNT(*) as total FROM risk_zousi ' + whereSql, params
    );
    const total = (cntRows as any)[0].total;

    const [shipCnt] = await pool.query(
      'SELECT COUNT(DISTINCT mmsi) as ships FROM risk_zousi ' + whereSql, params
    );

    const [rows] = await pool.query(
      `SELECT id, mmsi, vessel_name, silent_start_time, silent_end_time,
              silent_duration_min, silent_start_lng, silent_start_lat,
              silent_end_lng, silent_end_lat, coastline_distance_km,
              nearest_port_distance_km, nearest_port_name,
              displacement_km, sog_before, sog_after,
              nav_status_before, nav_status_after, flag_country_cn,
              vessel_type_name, destination,
              DATE_FORMAT(create_time, '%Y-%m-%d %H:%i:%s') as create_time
       FROM risk_zousi ${whereSql}
       ORDER BY silent_duration_min DESC, coastline_distance_km DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return NextResponse.json({
      ok: true, total, ships: (shipCnt as any)[0].ships,
      page, pageSize, data: rows
    });
  } catch (e: any) {
    console.error('ZSSF results error:', e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
