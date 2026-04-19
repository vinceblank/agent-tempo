/**
 * Shared terminal-class error classifier for adapter code (#249 Bug 4).
 *
 * The Temporal TS SDK conflates two terminal sub-kinds on pinned-runId
 * signal/query failures:
 *   (a) the closed run's specific runId no longer accepting traffic (CAN,
 *       true COMPLETE, TERMINATED, FAILED), and
 *   (b) the workflow id having been fully GC'd.
 * Both surface as `WorkflowNotFoundError` with message
 * "workflow execution already completed". This classifier says "yes, this is a
 * terminal-class error" vs "transient, keep retrying" — it does NOT distinguish
 * the sub-kinds. Callers that need sub-kind resolution consult
 * `fetchHistory` (see {@link BaseAttachment.handleRunEndError}).
 *
 * **Extracted from `BaseAttachment.isTerminalErr` to break a code-duplication
 * risk** — both the heartbeat/watcher ticks (in `base.ts`) and the delivery
 * poller (in `claude-code/adapter.ts`) need to classify the same errors, and
 * divergence between the two would re-create the #249 Bug 4 regression surface.
 * One implementation, one import point.
 *
 * Uses name/message-sniffing rather than `instanceof` to tolerate the slightly
 * different shapes errors take between `@temporalio/client` and the raw gRPC
 * layer. The tradeoff is a narrow window where gRPC could add a new phrasing
 * for the same error class — but that's caught by the existing adapter
 * reconnect integration tests.
 */
export function isTerminalWorkflowError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | undefined;
  const name = e?.name ?? '';
  const msg = e?.message ?? '';
  return (
    name.includes('WorkflowNotFound') ||
    name.includes('WorkflowExecutionAlreadyCompleted') ||
    msg.includes('WorkflowGone') ||
    msg.includes('NOT_FOUND') ||
    msg.includes('workflow execution already completed')
  );
}
