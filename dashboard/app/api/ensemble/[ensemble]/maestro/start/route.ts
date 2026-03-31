import { NextResponse } from 'next/server';
import { startMaestro } from '@/lib/temporal-queries';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  let workDir: string | undefined;
  try {
    const body = await request.json();
    workDir = body.workDir;
  } catch {
    // No body is fine
  }
  try {
    const workflowId = await startMaestro(ensemble, workDir);
    return NextResponse.json({ workflowId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
