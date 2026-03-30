import { NextResponse } from 'next/server';
import { getConductorHistory, sendCommand } from '@/lib/temporal-queries';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const history = await getConductorHistory(ensemble);
    return NextResponse.json(history);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const { text, source } = await request.json();
    if (!text || !source) {
      return NextResponse.json(
        { error: 'Missing required fields: text, source' },
        { status: 400 },
      );
    }
    await sendCommand(ensemble, text, source);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
