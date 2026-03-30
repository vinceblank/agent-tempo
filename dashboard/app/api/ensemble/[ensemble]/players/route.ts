import { NextResponse } from 'next/server';
import { listPlayers } from '@/lib/temporal-queries';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const players = await listPlayers(ensemble);
    return NextResponse.json(players);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
