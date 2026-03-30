import { NextResponse } from 'next/server';
import { startConductor } from '@/lib/temporal-queries';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const workflowId = await startConductor(ensemble);
    return NextResponse.json({ workflowId });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
