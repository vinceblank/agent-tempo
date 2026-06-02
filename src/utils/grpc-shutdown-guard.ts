/**
 * Process-level guard for the Temporal/grpc-js "Channel has been shut down"
 * shutdown race.
 *
 * `@temporalio/client`'s gRPC retry interceptor (`grpc-retry.js`) schedules
 * call retries with `setTimeout`. `Connection.close()` shuts down the
 * underlying grpc-js channel but does NOT clear those pending timers. When a
 * retry timer fires *after* the channel is closed, `InternalChannel.createCall`
 * throws `Error: Channel has been shut down` **synchronously inside the timer
 * callback** — off any awaited path, so no surrounding `try/catch` (including
 * the one around `connection.close()`) can catch it. It escapes to
 * `uncaughtException` and kills the process.
 *
 * Observed stack (the crash this guards against):
 *   InternalChannel.createCall (@grpc/grpc-js/.../internal-channel.js)
 *   ...
 *   Timeout.retry [as _onTimeout] (@temporalio/client/lib/grpc-retry.js)
 *
 * This artifact is always benign: it only occurs for a connection we have
 * already finished with (its query result was captured, or we degraded), as
 * the channel tears down. Swallowing exactly this error — and nothing else —
 * removes the crash without masking real failures. Any other uncaught
 * exception is re-thrown, which Node treats as fatal (print + non-zero exit),
 * preserving normal crash semantics.
 *
 * Install once at CLI entry. Idempotent.
 */

const CHANNEL_SHUTDOWN_MESSAGE = 'Channel has been shut down';

let installed = false;

function isBenignChannelShutdown(err: unknown): err is Error {
  return (
    err instanceof Error &&
    typeof err.message === 'string' &&
    err.message.includes(CHANNEL_SHUTDOWN_MESSAGE)
  );
}

const handler = (err: unknown): void => {
  if (isBenignChannelShutdown(err)) {
    // A Temporal gRPC retry timer fired after we closed the connection. The
    // result we cared about was already captured (or degraded). Drop it.
    if (process.env.CLAUDE_TEMPO_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(
        '[agent-tempo] ignored post-shutdown gRPC channel error (benign Temporal retry-after-close race)',
      );
    }
    return;
  }
  // Not ours — restore default crash behavior. Throwing from inside an
  // 'uncaughtException' handler causes Node to print the error and exit with a
  // non-zero code (it does not re-enter this handler), preserving the original
  // failure's visibility and exit semantics.
  throw err;
};

/**
 * Register the guard on `process`. Safe to call multiple times — only the
 * first call attaches a listener.
 */
export function installGrpcShutdownGuard(): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', handler);
}

/**
 * Test-only escape hatch — removes the listener and resets the install latch so
 * a fresh `installGrpcShutdownGuard()` can be exercised. Never call from
 * production code. See docs/adr/0006-test-hooks-naming.md.
 */
export function __resetGrpcShutdownGuardForTests(): void {
  process.off('uncaughtException', handler);
  installed = false;
}
