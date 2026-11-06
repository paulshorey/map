import { getColocatedPois, getDb } from "@lib/db-map";
import { NextRequest, NextResponse } from "next/server";

/** Every published POI sharing the clicked marker's exact point; the clicked POI comes first. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const location = request.nextUrl.searchParams.get("location");
  const result = await getColocatedPois(getDb(), { id, location });

  if (!result) {
    return NextResponse.json({ error: "POI not found" }, { status: 404 });
  }

  return NextResponse.json(result);
}
