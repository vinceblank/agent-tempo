/** Environment variable name constants — use these instead of string literals. */
export const ENV = {
  ENSEMBLE: 'CLAUDE_TEMPO_ENSEMBLE',
  CONDUCTOR: 'CLAUDE_TEMPO_CONDUCTOR',
  PLAYER_NAME: 'CLAUDE_TEMPO_PLAYER_NAME',
  TASK_QUEUE: 'CLAUDE_TEMPO_TASK_QUEUE',
  BRIDGE_NAME: 'COPILOT_BRIDGE_NAME',
  BRIDGE_MODE: 'CLAUDE_TEMPO_BRIDGE_MODE',
  BRIDGE_MODEL: 'COPILOT_BRIDGE_MODEL',
  TEMPORAL_ADDRESS: 'TEMPORAL_ADDRESS',
  TEMPORAL_NAMESPACE: 'TEMPORAL_NAMESPACE',
} as const;

export interface Config {
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  ensemble: string;
}

export function getConfig(): Config {
  return {
    temporalAddress: process.env[ENV.TEMPORAL_ADDRESS] ?? 'localhost:7233',
    temporalNamespace: process.env[ENV.TEMPORAL_NAMESPACE] ?? 'default',
    taskQueue: process.env[ENV.TASK_QUEUE] ?? 'claude-tempo',
    ensemble: process.env[ENV.ENSEMBLE] ?? 'default',
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
