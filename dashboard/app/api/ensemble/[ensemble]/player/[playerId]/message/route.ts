import { NextResponse } from 'next/server';
import { sendMessage } from '@/lib/temporal-queries';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ensemble: string; playerId: string }> },
) {
  const { ensemble, playerId } = await params;
  try {
    const { from, text } = await request.json();
    if (!from || !text) {
      return NextResponse.json(
        { error: 'Missing required fields: from, text' },
        { status: 400 },
      );
    }
    await sendMessage(ensemble, playerId, from, text);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
