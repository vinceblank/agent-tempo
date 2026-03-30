import { NextResponse } from 'next/server';
import { getPlayerDetail, terminatePlayer } from '@/lib/temporal-queries';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string; playerId: string }> },
) {
  const { ensemble, playerId } = await params;
  try {
    const detail = await getPlayerDetail(ensemble, playerId);
    return NextResponse.json(detail);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string; playerId: string }> },
) {
  const { ensemble, playerId } = await params;
  try {
    await terminatePlayer(ensemble, playerId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
