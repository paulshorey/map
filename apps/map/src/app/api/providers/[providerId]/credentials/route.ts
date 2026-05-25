import { getDb, getUserTier } from '@lib/db-map';
import { resolveUserId } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await params;
  const userId = resolveUserId();
  const tier = await getUserTier(getDb(), userId);

  if (tier !== 'premium') {
    return NextResponse.json(
      { error: 'Premium subscription required' },
      { status: 403 },
    );
  }

  const keyMap: Record<string, string | undefined> = {
    thunderforest: process.env.THUNDERFOREST_API_KEY,
  };

  const providerBase = providerId.split('-')[0]!;
  const apiKey = keyMap[providerBase];

  if (!apiKey) {
    return NextResponse.json(
      { error: 'No credentials for this provider' },
      { status: 404 },
    );
  }

  return NextResponse.json({ apiKey });
}
