import { Client, WorkflowHandle } from '@temporalio/client';
import { SessionMetadata } from '../types';

/**
 * Resolve a session by player name.
 * 1. Try search attribute query (fast, indexed — but eventually consistent)
 * 2. Fall back to listing all ensemble workflows and querying metadata (always current)
 */
export async function resolveSession(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  // Fast path: search attribute (may lag behind by a few seconds after rename)
  const saQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}" AND ClaudeTempoPlayerId = "${playerName}"`;
  for await (const wf of client.workflow.list({ query: saQuery })) {
    return client.workflow.getHandle(wf.workflowId);
  }

  // Fallback: list all ensemble workflows and check in-memory metadata
  const fallbackQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}"`;
  for await (const wf of client.workflow.list({ query: fallbackQuery })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query('getMetadata');
      if (metadata.playerId === playerName) {
        return handle;
      }
    } catch {
      // Workflow may have just completed — skip
    }
  }

  return null;
}
