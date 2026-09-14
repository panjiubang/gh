import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const mmsi = new URL(req.url).searchParams.get('mmsi');
    if (!mmsi) {
      return NextResponse.json({ ok: false, error: '缺少 mmsi 参数' }, { status: 400 });
    }
    const sql = [
      'SELECT ts_local, latitude, longitude, sog_kn, cog_deg, heading,',
      '       nav_status_text, message_type, vessel_name, destination',
      'FROM ais_origin_record',
      'WHERE mmsi = ? AND latitude IS NOT NULL AND longitude IS NOT NULL',
      'ORDER BY ts_local ASC',
      'LIMIT 2000'
    ].join('\n');
    const [rows] = await pool.query(sql, [mmsi]);
    const [cntRows] = await pool.query(
      'SELECT COUNT(*) as total FROM ais_origin_record WHERE mmsi = ? AND latitude IS NOT NULL',
      [mmsi]
    );
    return NextResponse.json({
      ok: true, mmsi: String(mmsi),
      total: (cntRows as any)[0].total,
      points: (rows as any[]).length,
      data: rows
    });
  } catch (e: any) {
    console.error('Track query error:', e.message);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
