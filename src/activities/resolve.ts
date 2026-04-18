import { Client, WorkflowHandle } from '@temporalio/client';
import { SessionMetadata, AttachmentPhase } from '../types';

/** Shared query for listing running session workflows. */
const SESSION_LIST_QUERY = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;

/**
 * Resolve a session by player name.
 * Lists all running session workflows and queries each for metadata.
 * This avoids depending on custom search attributes which are eventually
 * consistent and may be missing or stale.
 *
 * Shared by activity files (outbox, schedule-fire) and the tools layer.
 */
export async function resolveSession(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  for await (const wf of client.workflow.list({ query: SESSION_LIST_QUERY })) {
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

/** Info returned for each session by scanEnsembleSessions. */
export interface EnsembleSessionInfo {
  workflowId: string;
  playerId: string;
  part: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
  agentType: string;
  playerType?: string;
  /**
   * Attachment phase read from the `ClaudeTempoAttachmentState` search attribute.
   * May be undefined for older workflows that predate the attachment lifecycle,
   * or transiently while search attributes propagate.
   */
  phase?: AttachmentPhase;
}

/**
 * Scan all running session workflows in an ensemble.
 * Returns metadata + part for each session. Shared by the ensemble MCP tool
 * and the Maestro refresh activity.
 */
export async function scanEnsembleSessions(
  client: Client,
  ensemble: string,
): Promise<EnsembleSessionInfo[]> {
  const sessions: EnsembleSessionInfo[] = [];

  for await (const workflow of client.workflow.list({ query: SESSION_LIST_QUERY })) {
    try {
      const handle = client.workflow.getHandle(workflow.workflowId);
      const metadata: SessionMetadata = await handle.query('getMetadata');

      if (metadata.ensemble !== ensemble) continue;

      const part: string = await handle.query('getPart');

      // Attachment phase lives in the `ClaudeTempoAttachmentState` search
      // attribute (written by the workflow on every phase transition).
      const phaseArr = workflow.searchAttributes?.ClaudeTempoAttachmentState as
        | string[]
        | undefined;
      const phase = Array.isArray(phaseArr) && phaseArr.length > 0
        ? (phaseArr[0] as AttachmentPhase)
        : undefined;

      sessions.push({
        workflowId: workflow.workflowId,
        playerId: metadata.playerId,
        part,
        hostname: metadata.hostname,
        workDir: metadata.workDir,
        gitRoot: metadata.gitRoot,
        gitBranch: metadata.gitBranch,
        isConductor: metadata.isConductor,
        agentType: metadata.agentType || 'claude',
        playerType: metadata.playerType,
        phase,
      });
    } catch {
      // Workflow may have just completed — skip it
    }
  }

  return sessions;
}
