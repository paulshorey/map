import { getDb, traceCanonical, traceResearchRecord } from '@lib/db-map';
import { NextRequest, NextResponse } from 'next/server';

function enabled() {
  return process.env.NODE_ENV === 'development' || process.env.ENABLE_ADMIN_LINEAGE === 'true';
}

export async function GET(request: NextRequest) {
  if (!enabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { searchParams } = request.nextUrl;
  const canonical = searchParams.get('canonical');
  const source = searchParams.get('source');
  const record = searchParams.get('record');
  if (!canonical && (!source || !record)) {
    return NextResponse.json({ error: 'Provide canonical, or source and record.' }, { status: 400 });
  }
  const trace = canonical
    ? await traceCanonical(getDb(), canonical)
    : await traceResearchRecord(getDb(), source!, record!);
  if (!trace) return NextResponse.json({ error: 'Lineage not found' }, { status: 404 });
  return NextResponse.json(trace, { headers: { 'Cache-Control': 'no-store' } });
}
