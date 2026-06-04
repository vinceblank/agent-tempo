/**
 * Ingest-token registry (3c Tier-2 ingest-auth) — per security's design.
 *
 * The `/inner/ingest` + `/inner/presence` endpoints are the SOURCE-side
 * (publisher → daemon) half of the off-wire fine-tail channel. Loopback-only is
 * necessary but NOT sufficient: any local process could POST fake frames or
 * inject into ANOTHER player's tail. So each headless Pi player is minted a
 * per-player ingest token at spawn, scoped to its session `workflowId`; the
 * ingest/presence handlers validate the presented token against the token minted
 * for the URL-derived workflowId, binding every frame to its owning player.
 *
 * Lifecycle (driven from the daemon-only outbox.ts — NOT spawn.ts, which runs
 * outside the daemon and must not import this):
 *   - MINT before `spawnPiHeadless` (token injected into the subprocess env).
 *   - REVOKE on detach + destroy.
 *   - REVOKE-ALL on daemon shutdown.
 *
 * Phase-4+ deferrals (carry-items, NOT 3c): token rotation, per-token
 * rate-limiting, durable ingest audit.
 */
import * as crypto from 'crypto';
import { tokensMatch } from './auth';

/** Bytes of entropy per ingest token (base64url → 43 chars, same as the HTTP bearer). */
const INGEST_TOKEN_BYTES = 32;

/**
 * In-memory map of `workflowId → ingest token`, owned by the daemon (one
 * instance shared between the outbox minter and the HTTP ingest/presence
 * validators). Tokens never persist — they live only for the player's lifetime.
 */
export class IngestTokenRegistry {
  private readonly tokens = new Map<string, string>();

  /**
   * Mint a fresh ingest token for a player, replacing any prior one (a restart
   * re-mints). Returns the token to inject into the subprocess env.
   */
  mint(workflowId: string): string {
    const token = crypto.randomBytes(INGEST_TOKEN_BYTES).toString('base64url');
    this.tokens.set(workflowId, token);
    return token;
  }

  /**
   * Validate a presented token against the token minted for `workflowId`
   * (timing-safe, via {@link tokensMatch}). Returns `false` for an unknown
   * player or a mismatch — so a compromised player presenting its OWN token for
   * another player's URL is rejected (cross-player-spoof guard). The workflowId
   * is public (it's in the URL); the token is the secret, and only its
   * comparison is constant-time.
   */
  validate(workflowId: string, presented: string): boolean {
    const expected = this.tokens.get(workflowId);
    if (expected === undefined) return false;
    return tokensMatch(presented, expected);
  }

  /** Revoke a player's ingest token (detach / destroy). Idempotent. */
  revoke(workflowId: string): void {
    this.tokens.delete(workflowId);
  }

  /** Revoke every token (daemon shutdown / clear-all). */
  revokeAll(): void {
    this.tokens.clear();
  }

  /** Whether a player currently holds a minted token. */
  has(workflowId: string): boolean {
    return this.tokens.has(workflowId);
  }

  /** Active token count (diagnostics / tests). */
  size(): number {
    return this.tokens.size;
  }
}
