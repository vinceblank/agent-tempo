import { NextResponse } from 'next/server';
import { hasConductor } from '@/lib/temporal-queries';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const active = await hasConductor(ensemble);
    return NextResponse.json({ active });
  } catch {
    return NextResponse.json({ active: false });
  }
}
