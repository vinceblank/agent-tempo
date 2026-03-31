import { NextResponse } from 'next/server';
import { recruitPlayer } from '@/lib/temporal-queries';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const { workDir, name, initialMessage, isConductor } = await request.json();
    if (!workDir || !name) {
      return NextResponse.json(
        { error: 'Missing required fields: workDir, name' },
        { status: 400 },
      );
    }
    const result = await recruitPlayer(ensemble, workDir, name, initialMessage, isConductor);
    return NextResponse.json({ message: result });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
