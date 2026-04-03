import { Client, WorkflowHandle } from '@temporalio/client';
import { SessionMetadata } from '../types';

/**
 * Resolve a session by player name.
 * Lists all running session workflows and queries each for metadata.
 * This avoids depending on custom search attributes which are eventually
 * consistent and may be missing or stale.
 */
export async function resolveSession(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query('getMetadata');
      if (metadata.ensemble === ensemble && metadata.playerId === playerName) {
        return handle;
      }
    } catch {
      // Workflow may have just completed — skip
    }
  }

  return null;
}
