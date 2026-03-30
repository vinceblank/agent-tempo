export interface Config {
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  ensemble: string;
}

export function getConfig(): Config {
  return {
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.CLAUDE_TEMPO_TASK_QUEUE ?? 'claude-tempo',
    ensemble: process.env.CLAUDE_TEMPO_ENSEMBLE ?? 'default',
  };
}

/** Build a workflow ID for a player session: claude-session-{ensemble}-{playerId} */
export function sessionWorkflowId(ensemble: string, playerId: string): string {
  return `claude-session-${ensemble}-${playerId}`;
}

/** Build a workflow ID for a conductor: claude-session-{ensemble}-conductor */
export function conductorWorkflowId(ensemble: string): string {
  return `claude-session-${ensemble}-conductor`;
}
