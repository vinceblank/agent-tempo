/**
 * Unit tests for the Temporal/grpc-js "Channel has been shut down" guard.
 *
 * The guard swallows exactly the benign post-`Connection.close()` retry-timer
 * error and re-throws everything else. We drive it by emitting
 * `'uncaughtException'` synchronously and asserting throw / no-throw behavior.
 * Other listeners in the test runner are stashed and restored around each case
 * so we observe only the guard's own behavior.
 *
 * Limitation: in production, re-throwing from the handler makes Node exit the
 * process (code 7). That cannot be reproduced in-process without killing the
 * test runner, so the "re-throws ..." cases below assert only that the handler
 * does NOT swallow non-benign errors (the throw surfaces synchronously through
 * `process.emit`). They do not — and cannot, here — verify the actual exit-code
 * behavior; that is covered by reasoning, not by this unit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installGrpcShutdownGuard,
  __resetGrpcShutdownGuardForTests,
} from '../../src/utils/grpc-shutdown-guard';

describe('grpc-shutdown-guard', () => {
  let stashed: NodeJS.UncaughtExceptionListener[];

  beforeEach(() => {
    __resetGrpcShutdownGuardForTests();
    // Isolate from the runner's own uncaughtException listeners so emitting
    // a synthetic error doesn't trip vitest's harness.
    stashed = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
  });

  afterEach(() => {
    __resetGrpcShutdownGuardForTests();
    process.removeAllListeners('uncaughtException');
    for (const l of stashed) process.on('uncaughtException', l);
  });

  it('swallows the benign "Channel has been shut down" error', () => {
    installGrpcShutdownGuard();
    const err = new Error('Channel has been shut down');
    expect(() => process.emit('uncaughtException', err)).not.toThrow();
  });

  it('swallows errors whose message merely contains the marker', () => {
    installGrpcShutdownGuard();
    const err = new Error('14 UNAVAILABLE: Channel has been shut down');
    expect(() => process.emit('uncaughtException', err)).not.toThrow();
  });

  it('re-throws any other error to preserve crash semantics', () => {
    installGrpcShutdownGuard();
    const err = new Error('something genuinely broken');
    expect(() => process.emit('uncaughtException', err)).toThrow('something genuinely broken');
  });

  it('re-throws non-Error throwables', () => {
    installGrpcShutdownGuard();
    // grpc/temporal always throw Error instances, but be defensive.
    expect(() => process.emit('uncaughtException', 'plain string' as unknown as Error)).toThrow();
  });

  it('is idempotent — only one listener attaches across repeated installs', () => {
    const before = process.listenerCount('uncaughtException');
    installGrpcShutdownGuard();
    installGrpcShutdownGuard();
    installGrpcShutdownGuard();
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
  });
});
