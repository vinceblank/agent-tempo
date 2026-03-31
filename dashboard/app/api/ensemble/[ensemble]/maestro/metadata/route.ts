import { NextResponse } from 'next/server';
import { getTemporalClient } from '@/lib/temporal-client';
import { sessionWorkflowId } from '@/lib/tempo-config';
import { QUERIES } from '@/lib/constants';
import type { SessionMetadata } from '@/lib/tempo-types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ensemble: string }> },
) {
  const { ensemble } = await params;
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(sessionWorkflowId(ensemble, 'maestro'));
    const metadata = await handle.query(QUERIES.GET_METADATA) as SessionMetadata;
    return NextResponse.json(metadata);
  } catch {
    return NextResponse.json(null, { status: 404 });
  }
}
