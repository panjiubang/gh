import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const cfgPath = path.join(process.cwd(), 'src', 'lib', 'zssf-data', 'zssf-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return NextResponse.json(JSON.parse(raw));
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
