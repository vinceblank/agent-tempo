/**
 * #777 standalone repro — NOT committed. Boots a TestWorkflowEnvironment,
 * loops {start conductor session, setStage signal, playerReport signal,
 * poll stagesQuery}; on a wedge (report not applied within BUDGET_MS),
 * dumps the workflow's EVENT HISTORY — the ground-truth discriminator:
 *   - WorkflowExecutionSignaled (signal 2) absent  → server lost the signal
 *   - present, no WorkflowTaskScheduled after it   → server dispatch bug
 *   - TaskScheduled, never TaskStarted             → dispatched to a queue
 *     nobody polls (the event names the queue — sticky vs normal)
 *   - TaskStarted → Failed/TimedOut loops          → worker-side failure
 * Run pinned to 2 cores alongside pinned burners (see repro-777.ps1).
 */
/* eslint-disable no-console */
const { TestWorkflowEnvironment } = require('@temporalio/testing');
const { Worker } = require('@temporalio/worker');
const fs = require('fs');
const path = require('path');

const BUDGET_MS = 8_000;       // generous vs normal ~50ms application
const ITERATIONS = 120;

function findBundle() {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const c = path.join(dir, 'workflow-bundle.js');
    if (fs.existsSync(c)) return c;
    dir = path.dirname(dir);
  }
  throw new Error('workflow-bundle.js not found — npm run build first');
}

async function main() {
  const env = await TestWorkflowEnvironment.createLocal({
    server: {
      extraArgs: [
        '--search-attribute', 'AgentTempoEnsemble=Keyword',
        '--search-attribute', 'AgentTempoPlayerId=Keyword',
        '--search-attribute', 'AgentTempoHostname=Keyword',
        '--search-attribute', 'AgentTempoGitRoot=Keyword',
        '--search-attribute', 'AgentTempoPlayerType=Keyword',
        '--search-attribute', 'AgentTempoIsConductor=Bool',
        '--search-attribute', 'AgentTempoAttachedHost=Keyword',
        '--search-attribute', 'AgentTempoAttachmentState=Keyword',
        '--search-attribute', 'AgentTempoAttachmentId=Keyword',
      ],
    },
  });
  const bundle = { code: fs.readFileSync(findBundle(), 'utf-8') };
  console.log('[repro] env up');

  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const queue = `repro-777-${i}`;
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: queue,
        workflowBundle: bundle,
        stickyQueueScheduleToStartTimeout: '1s', // post-#778 config
      });

      const wedged = await worker.runUntil(async () => {
        const wfId = `repro-777-sess-${i}`;
        const handle = await env.client.workflow.start('agentSessionWorkflow', {
          workflowId: wfId,
          taskQueue: queue,
          args: [{
            metadata: {
              playerId: `cond-${i}`, ensemble: `repro-${i}`, hostname: 'test-host',
              workDir: '/tmp/repro', isConductor: true, agentType: 'claude',
            },
            autoSummary: 'repro', disableStaleDetection: true,
          }],
        });
        await handle.signal('setStage', { name: 'st', players: ['alice', 'bob'], createdBy: `cond-${i}` });
        await handle.signal('playerReport', { playerId: 'alice', text: 'ok', type: 'result' });

        const deadline = Date.now() + BUDGET_MS;
        let last;
        while (Date.now() < deadline) {
          try {
            const stages = await handle.query('stages');
            last = stages;
            const alice = stages?.[0]?.players?.find((p) => p.playerId === 'alice');
            if (alice && alice.status === 'reported') return null; // healthy
          } catch (e) { last = `QUERY ERR: ${e.message}`; }
          await new Promise((r) => setTimeout(r, 50));
        }
        // WEDGED — capture history before teardown.
        console.log(`[repro] WEDGE at iteration ${i}; last state: ${JSON.stringify(last)}`);
        const hist = await handle.fetchHistory();
        const lines = (hist.events ?? []).map((e) => {
          const t = e.eventType;
          const attrs = e.workflowTaskScheduledEventAttributes;
          const q = attrs?.taskQueue ? ` queue=${attrs.taskQueue.name} kind=${attrs.taskQueue.kind}` : '';
          const sig = e.workflowExecutionSignaledEventAttributes?.signalName
            ? ` signal=${e.workflowExecutionSignaledEventAttributes.signalName}` : '';
          return `#${e.eventId} ${t}${q}${sig}`;
        });
        fs.writeFileSync(path.join(__dirname, `repro-777-wedge-${i}.history.txt`), lines.join('\n'));
        console.log(lines.join('\n'));
        return wfId;
      });

      try { // cleanup: terminate the session either way
        await env.client.workflow.getHandle(`repro-777-sess-${i}`).terminate('repro cleanup');
      } catch { /* already done */ }

      if (wedged) {
        console.log(`[repro] WEDGE CAPTURED (iteration ${i}) — history written. Stopping.`);
        break;
      }
      if (i % 10 === 0) console.log(`[repro] iteration ${i} ok`);
    }
  } finally {
    await env.teardown();
    console.log('[repro] done');
  }
}

main().catch((e) => { console.error('[repro] fatal:', e); process.exit(1); });
