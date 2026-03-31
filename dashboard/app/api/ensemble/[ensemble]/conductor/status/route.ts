import { NextResponse } from 'next/server';
import { findConductor } from '@/lib/temporal-queries';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const conductorId = await findConductor(ensemble);
    return NextResponse.json({ active: !!conductorId, conductorId });
  } catch {
    return NextResponse.json({ active: false, conductorId: null });
  }
}
