import { NextResponse } from 'next/server';
import { getTemporalClient } from '@/lib/temporal-client';

export async function GET() {
  try {
    const client = await getTemporalClient();
    const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
    const ensembleSet = new Set<string>();

    for await (const wf of client.workflow.list({ query })) {
      const attrs = wf.searchAttributes;
      const ensemble = attrs?.ClaudeTempoEnsemble;
      if (Array.isArray(ensemble) && typeof ensemble[0] === 'string') {
        ensembleSet.add(ensemble[0]);
      }
    }

    return NextResponse.json({ ensembles: Array.from(ensembleSet).sort() });
  } catch (err) {
    return NextResponse.json(
      { error: `Temporal unreachable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
