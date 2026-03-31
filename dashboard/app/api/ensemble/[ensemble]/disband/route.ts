import { NextResponse } from 'next/server';
import { disbandEnsemble } from '@/lib/temporal-queries';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const count = await disbandEnsemble(ensemble);
    return NextResponse.json({ ok: true, terminated: count });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
