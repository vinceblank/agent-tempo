import 'server-only';
import { Client, WorkflowHandle } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import { spawn } from 'child_process';
import type {
  SessionMetadata,
  SessionInput,
  Message,
  SentMessage,
} from './tempo-types';
import { sessionWorkflowId } from './tempo-config';
import { getTemporalClient, getTaskQueue } from './temporal-client';
import { SIGNALS, QUERIES } from './constants';

// ── Helpers ──

async function resolveSession(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  // Fast path: search attribute
  const saQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}" AND ClaudeTempoPlayerId = "${playerName}"`;
  for await (const wf of client.workflow.list({ query: saQuery })) {
    return client.workflow.getHandle(wf.workflowId);
  }

  // Fallback: list all ensemble workflows and check in-memory metadata
  const fallbackQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}"`;
  for await (const wf of client.workflow.list({ query: fallbackQuery })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query(QUERIES.GET_METADATA);
      if (metadata.playerId === playerName) {
        return handle;
      }
    } catch {
      // Workflow may have just completed — skip
    }
  }

  return null;
}

// ── Public API ──

export async function listPlayers(
  ensemble: string,
): Promise<Array<{ metadata: SessionMetadata; part: string }>> {
  const client = await getTemporalClient();
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}"`;
  const players: Array<{ metadata: SessionMetadata; part: string }> = [];

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const [metadata, part] = await Promise.all([
        handle.query(QUERIES.GET_METADATA) as Promise<SessionMetadata>,
        handle.query(QUERIES.GET_PART) as Promise<string>,
      ]);
      players.push({ metadata, part });
    } catch {
      // Workflow may have just completed — skip
    }
  }

  return players;
}


export async function sendMessage(
  ensemble: string,
  playerId: string,
  from: string,
  text: string,
): Promise<void> {
  const client = await getTemporalClient();
  const handle = await resolveSession(client, ensemble, playerId);
  if (!handle) {
    throw new Error(`Player "${playerId}" not found in ensemble "${ensemble}"`);
  }
  await handle.signal(SIGNALS.RECEIVE_MESSAGE, { from, text });
}

export async function terminatePlayer(
  ensemble: string,
  playerId: string,
): Promise<void> {
  const client = await getTemporalClient();
  const handle = await resolveSession(client, ensemble, playerId);
  if (!handle) {
    throw new Error(`Player "${playerId}" not found in ensemble "${ensemble}"`);
  }
  await handle.signal(SIGNALS.SHUTDOWN);
  await handle.terminate();
}

export async function hasConductor(ensemble: string): Promise<boolean> {
  const players = await listPlayers(ensemble);
  return players.some((p) =>
    p.metadata.isConductor ||
    p.metadata.playerId === 'conductor' ||
    p.metadata.playerId === `${ensemble}-conductor`
  );
}

export async function startMaestro(ensemble: string, workDir?: string): Promise<string> {
  const client = await getTemporalClient();
  const workflowId = sessionWorkflowId(ensemble, 'maestro');

  const sessionInput: SessionInput = {
    metadata: {
      playerId: 'maestro',
      ensemble,
      hostname: 'dashboard',
      workDir: workDir ?? process.cwd(),
      isConductor: false,
    },
  };

  const handle = await client.workflow.start('claudeSessionWorkflow', {
    workflowId,
    taskQueue: getTaskQueue(),
    args: [sessionInput],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowExecutionTimeout: '24 hours',
    searchAttributes: {
      ClaudeTempoHostname: ['dashboard'],
      ClaudeTempoEnsemble: [ensemble],
      ClaudeTempoPlayerId: ['maestro'],
    },
  });

  return handle.workflowId;
}

export async function getMaestroMessages(ensemble: string): Promise<{
  messages: Message[];
  sentMessages: SentMessage[];
}> {
  const client = await getTemporalClient();
  const workflowId = sessionWorkflowId(ensemble, 'maestro');
  try {
    const handle = client.workflow.getHandle(workflowId);
    let messages: Message[];
    try {
      messages = await handle.query(QUERIES.ALL_MESSAGES) as Message[];
    } catch {
      messages = await handle.query(QUERIES.PENDING_MESSAGES) as Message[];
    }
    // Auto-mark undelivered messages as delivered (maestro has no listener)
    const undeliveredIds = messages.filter((m) => !m.delivered).map((m) => m.id);
    if (undeliveredIds.length > 0) {
      try {
        await handle.signal(SIGNALS.MARK_DELIVERED, undeliveredIds);
      } catch {
        // Best-effort
      }
    }

    let sentMessages: SentMessage[];
    try {
      sentMessages = await handle.query(QUERIES.ALL_SENT_MESSAGES) as SentMessage[];
    } catch {
      sentMessages = [];
    }
    return { messages, sentMessages };
  } catch {
    return { messages: [], sentMessages: [] };
  }
}

export async function sendAsMaestro(
  ensemble: string,
  targetPlayerId: string,
  text: string,
): Promise<void> {
  const client = await getTemporalClient();
  const targetHandle = await resolveSession(client, ensemble, targetPlayerId);
  if (!targetHandle) {
    throw new Error(`Player "${targetPlayerId}" not found`);
  }
  await targetHandle.signal(SIGNALS.RECEIVE_MESSAGE, { from: 'maestro', text });

  // Record outbound on maestro's workflow
  const maestroId = sessionWorkflowId(ensemble, 'maestro');
  try {
    const maestroHandle = client.workflow.getHandle(maestroId);
    await maestroHandle.signal(SIGNALS.RECORD_SENT_MESSAGE, { to: targetPlayerId, text });
  } catch {
    // Maestro workflow may not exist yet
  }
}

export async function getPlayerDetail(
  ensemble: string,
  playerId: string,
): Promise<{
  metadata: SessionMetadata;
  part: string;
  messages: Message[];
  sentMessages: SentMessage[];
}> {
  const client = await getTemporalClient();
  const handle = await resolveSession(client, ensemble, playerId);
  if (!handle) {
    throw new Error(`Player "${playerId}" not found in ensemble "${ensemble}"`);
  }
  const [metadata, part] = await Promise.all([
    handle.query(QUERIES.GET_METADATA) as Promise<SessionMetadata>,
    handle.query(QUERIES.GET_PART) as Promise<string>,
  ]);

  // Try allMessages first (full history), fall back to pendingMessages (older workflows)
  let messages: Message[];
  try {
    messages = await handle.query(QUERIES.ALL_MESSAGES) as Message[];
  } catch {
    messages = await handle.query(QUERIES.PENDING_MESSAGES) as Message[];
  }

  let sentMessages: SentMessage[];
  try {
    sentMessages = await handle.query(QUERIES.ALL_SENT_MESSAGES) as SentMessage[];
  } catch {
    sentMessages = [];
  }

  return { metadata, part, messages, sentMessages };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function recruitPlayer(
  ensemble: string,
  workDir: string,
  name: string,
  initialMessage?: string,
  isConductor?: boolean,
): Promise<string> {
  // Validate name
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid name "${name}". Names must contain only letters, numbers, hyphens, and underscores.`
    );
  }

  const client = await getTemporalClient();

  // Check if already active
  const existing = await resolveSession(client, ensemble, name);
  if (existing) {
    throw new Error(`Session "${name}" is already active.`);
  }

  // Record existing workflows
  const existingIds = new Set<string>();
  const listQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}"`;
  for await (const wf of client.workflow.list({ query: listQuery })) {
    existingIds.add(wf.workflowId);
  }

  // Spawn new Claude Code session
  const spawnArgs = [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels', 'server:claude-tempo',
    '-n', `"${name}"`,
  ];
  const child = spawn('claude', spawnArgs, {
    cwd: workDir,
    detached: true,
    stdio: 'ignore',
    shell: true,
    env: {
      ...process.env,
      CLAUDE_TEMPO_ENSEMBLE: ensemble,
      CLAUDE_TEMPO_CONDUCTOR: isConductor ? 'true' : '',
    },
  });
  child.unref();

  // Poll for the new workflow (up to ~15s)
  let newWorkflowId: string | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(500);
    for await (const wf of client.workflow.list({ query: listQuery })) {
      if (!existingIds.has(wf.workflowId)) {
        newWorkflowId = wf.workflowId;
        break;
      }
    }
    if (newWorkflowId) break;
  }

  if (!newWorkflowId) {
    return `Session "${name}" spawned but did not register within 15 seconds.`;
  }

  // Send name instruction
  const newHandle = client.workflow.getHandle(newWorkflowId);
  const nameInstruction = `You have been recruited as "${name}". Call set_name("${name}") immediately.`;
  const fullMessage = initialMessage
    ? `${nameInstruction}\n\nThen: ${initialMessage}`
    : nameInstruction;

  await newHandle.signal(SIGNALS.RECEIVE_MESSAGE, { from: 'dashboard', text: fullMessage });

  return `Recruited session "${name}" in ${workDir}.`;
}
