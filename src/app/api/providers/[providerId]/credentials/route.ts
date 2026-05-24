import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { resolveUserId } from '@/lib/auth';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await params;
  const userId = resolveUserId();

  const { rows } = await pool.query(
    'SELECT tier FROM users WHERE id = $1',
    [userId],
  );

  if (!rows[0] || rows[0].tier !== 'premium') {
    return NextResponse.json(
      { error: 'Premium subscription required' },
      { status: 403 },
    );
  }

  const keyMap: Record<string, string | undefined> = {
    thunderforest: process.env.THUNDERFOREST_API_KEY,
  };

  const providerBase = providerId.split('-')[0];
  const apiKey = keyMap[providerBase];

  if (!apiKey) {
    return NextResponse.json(
      { error: 'No credentials for this provider' },
      { status: 404 },
    );
  }

  return NextResponse.json({ apiKey });
}
