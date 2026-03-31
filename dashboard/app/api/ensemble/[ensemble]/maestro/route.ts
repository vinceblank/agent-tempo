import { NextResponse } from 'next/server';
import { getMaestroMessages, sendAsMaestro } from '@/lib/temporal-queries';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const data = await getMaestroMessages(ensemble);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ messages: [], sentMessages: [] });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  const { target, text } = await request.json();
  try {
    await sendAsMaestro(ensemble, target, text);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
