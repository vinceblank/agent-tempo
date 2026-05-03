/**
 * Stream-JSON frame parser for `claude -p --output-format stream-json`.
 *
 * Issue #520 PR-3. Parses the newline-delimited JSON envelope the Claude
 * Code CLI emits during a per-turn invocation, accumulating the bits the
 * adapter needs (assembled assistant text, stop reason, usage, cost, plus
 * the fatal-/transient-classifier inputs).
 *
 * **Schema is grounded in the §11.1 spike fixtures** captured against
 * `claude --version` 2.1.126 — see `tests/adapters/fixtures/claude-code-headless/`.
 * Three deltas vs design §5.3 (documented in §16 spike-findings appendix):
 *
 *   1. **`result` frame has a `subtype: 'success' | 'error'`** — design listed
 *      `result` as a top-level type. Reality: `subtype` distinguishes success
 *      vs error envelopes. Bonus: `is_error: boolean` + `api_error_status:
 *      number | null` are clean classifier inputs (see {@link ResultFrame}).
 *   2. **`system/hook_started` + `system/hook_response` + `system/status`** —
 *      not in design. Emitted whenever the host has Claude Code hooks
 *      configured (most operators do — SessionStart hooks for project
 *      context). The `output`/`stdout` fields can carry arbitrary user
 *      content, so we IGNORE them outright (the fixture corpus shows a
 *      107KB SessionStart hook body in real captures).
 *   3. **`rate_limit_event` is a top-level type** — design assumed it was
 *      a `system/api_retry` subtype. Reality: it's its own frame. AND it
 *      carries TWO signal modes (informational vs action-required) on the
 *      same wire shape, distinguished by `rate_limit_info.status`. See
 *      {@link RateLimitEvent}.
 *
 * Pure code; no I/O; trivially unit-testable with synthesized + captured
 * fixtures. The error classifier (`./error-mapper.ts`) consumes the
 * accumulator state to emit a single `ApiErrorCategory` per turn.
 */

/**
 * Permissive frame shape — `claude -p` may add fields between minor versions.
 * Every concrete frame type is a discriminated subset.
 */
export interface BaseFrame {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
}

/** First frame of every turn. Used for telemetry — not classifier input. */
export interface SystemInitFrame extends BaseFrame {
  type: 'system';
  subtype: 'init';
  /** `'none'` when running on OAuth (subscription billing — the v0.28 default). */
  apiKeySource?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  claude_code_version?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  /** Non-empty array indicates a config error — log loudly. */
  plugin_errors?: unknown[];
}

/** Hook lifecycle frames. Adapter IGNORES these — see Delta #2 above. */
export interface SystemHookFrame extends BaseFrame {
  type: 'system';
  subtype: 'hook_started' | 'hook_response';
  hook_name?: string;
  hook_event?: string;
  /** May contain arbitrary user content (operator's hook output). Ignored. */
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
}

/** Bare status heartbeat. Ignored. */
export interface SystemStatusFrame extends BaseFrame {
  type: 'system';
  subtype: 'status';
  status?: string;
}

/** Documented retry signal. May or may not actually fire on v2.x — see Delta #3. */
export interface SystemApiRetryFrame extends BaseFrame {
  type: 'system';
  subtype: 'api_retry';
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number;
  /** Documented enum: `authentication_failed` | `oauth_org_not_allowed` | `billing_error` | `rate_limit` | `invalid_request` | `server_error` | `unknown` | `max_output_tokens`. */
  error?: string;
}

/** Top-level rate-limit informational AND action-required signal — Delta #3. */
export interface RateLimitEvent extends BaseFrame {
  type: 'rate_limit_event';
  rate_limit_info?: {
    /** `'allowed'` (informational, every turn) | `'blocked'` (action-required). */
    status?: string;
    rateLimitType?: string;
    resetsAt?: number;
    /** `'allowed'` | `'blocked'`. When BOTH this AND `status` are blocked → fatal (subscription + extra-usage exhausted). */
    overageStatus?: string;
    overageResetsAt?: number;
    isUsingOverage?: boolean;
  };
}

/** Mid-turn assistant message. Content array may include text / thinking / tool_use blocks. */
export interface AssistantFrame extends BaseFrame {
  type: 'assistant';
  message?: {
    role?: 'assistant';
    content?: Array<{
      type?: 'text' | 'thinking' | 'tool_use' | string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };
  parent_tool_use_id?: string | null;
}

/** Tool result wrapped as user turn — telemetry only. */
export interface UserFrame extends BaseFrame {
  type: 'user';
  message?: {
    role?: 'user';
    content?: Array<{
      type?: 'tool_result' | string;
      tool_use_id?: string;
      content?: unknown;
    }>;
  };
  tool_use_result?: unknown;
}

/** Token-delta frame. Only emitted with `--include-partial-messages`. v1 ignores. */
export interface StreamEventFrame extends BaseFrame {
  type: 'stream_event';
  event?: unknown;
  ttft_ms?: number;
}

/** Closing frame of every turn. Authoritative source for assembled text + usage + cost. */
export interface ResultFrame extends BaseFrame {
  type: 'result';
  /** `'success'` | `'error'` (and possibly more). Discriminates envelope shape. */
  subtype?: string;
  /** Clean fatal-vs-success boolean — primary classifier input per architect. */
  is_error?: boolean;
  /** HTTP status code on API errors. Reuse claude-api's HTTP-code classifier. */
  api_error_status?: number | null;
  /** Assembled assistant text — the canonical reply the adapter returns. */
  result?: string;
  /** `'end_turn'` | `'max_tokens'` | `'stop_sequence'` | … */
  stop_reason?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  /** Equivalent API cost (NOT real subscription burn). */
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  /** `'completed'` | `'aborted'` | … */
  terminal_reason?: string;
}

/**
 * Discriminated union of everything we recognize. The parser tolerates
 * unknown `type` strings by passing them through as `BaseFrame`.
 */
export type StreamJsonFrame =
  | SystemInitFrame
  | SystemHookFrame
  | SystemStatusFrame
  | SystemApiRetryFrame
  | RateLimitEvent
  | AssistantFrame
  | UserFrame
  | StreamEventFrame
  | ResultFrame
  | BaseFrame;

/**
 * Per-turn accumulator. The parser folds each frame into this state; the
 * adapter reads it after the subprocess exits to assemble the SDK return
 * value AND to feed the error classifier.
 */
export interface TurnAccumulator {
  /** Canonical assembled assistant text — set from `result.result` (preferred) or assistant-frame text fallback. */
  assembledText: string;
  /** `result.stop_reason`. */
  stopReason: string | null;
  /** `result.usage` — opaque token accounting. */
  usage: Record<string, unknown> | null;
  /** `result.total_cost_usd` — equivalent API cost (NOT real subscription burn). */
  totalCostUsd: number | null;
  /** `result.is_error` — primary classifier input. */
  resultIsError: boolean | null;
  /** `result.api_error_status` — HTTP code when is_error=true. */
  resultApiErrorStatus: number | null;
  /** `result.subtype` — `'success'` | `'error'` | … */
  resultSubtype: string | null;
  /** Did we see a `result` frame at all? `false` means subprocess exited before completing the turn. */
  resultFrameSeen: boolean;
  /** `system/api_retry` events observed on stdout — fed into the classifier. */
  apiRetryEvents: SystemApiRetryFrame[];
  /** `rate_limit_event` frames observed — separated by status for the classifier. */
  rateLimitEvents: RateLimitEvent[];
  /** Plugin-config errors from `system/init` — non-empty means config bug. */
  pluginErrors: unknown[];
  /** Model id from `system/init`, e.g. `'claude-opus-4-7[1m]'`. Telemetry only. */
  initModel: string | null;
  /** `apiKeySource` from `system/init` — `'none'` confirms OAuth subscription billing. */
  initApiKeySource: string | null;
}

/** Build a fresh accumulator. */
export function newTurnAccumulator(): TurnAccumulator {
  return {
    assembledText: '',
    stopReason: null,
    usage: null,
    totalCostUsd: null,
    resultIsError: null,
    resultApiErrorStatus: null,
    resultSubtype: null,
    resultFrameSeen: false,
    apiRetryEvents: [],
    rateLimitEvents: [],
    pluginErrors: [],
    initModel: null,
    initApiKeySource: null,
  };
}

/**
 * Fold one stream-json frame into the accumulator. Pure mutation — return
 * the same instance for chaining.
 *
 * Unknown frame types are silently passed through (the parser is tolerant
 * by design — Claude Code may add new frame types between minor versions
 * and we don't want to crash on them; the adapter only ever acts on the
 * categories we recognize).
 *
 * The hook + status frames are explicitly enumerated as IGNORED rather
 * than falling through `default`, so future readers don't think the
 * pass-through is accidental.
 */
export function applyFrame(state: TurnAccumulator, frame: StreamJsonFrame): TurnAccumulator {
  switch (frame.type) {
    case 'system':
      switch (frame.subtype) {
        case 'init': {
          const init = frame as SystemInitFrame;
          state.initModel = init.model ?? null;
          state.initApiKeySource = init.apiKeySource ?? null;
          if (init.plugin_errors && init.plugin_errors.length > 0) {
            state.pluginErrors = init.plugin_errors;
          }
          return state;
        }
        case 'api_retry':
          state.apiRetryEvents.push(frame as SystemApiRetryFrame);
          return state;
        case 'hook_started':
        case 'hook_response':
        case 'status':
          // Delta #2 — explicitly ignored. Hook output may carry arbitrary
          // operator content (107KB+ in real captures); we don't need it.
          return state;
        default:
          return state;
      }
    case 'rate_limit_event':
      // Delta #3 — top-level frame, NOT a system subtype. Two signal modes
      // overloaded on one type: informational (every turn) vs action-required
      // (when capped). Classifier distinguishes by `rate_limit_info.status`.
      state.rateLimitEvents.push(frame as RateLimitEvent);
      return state;
    case 'assistant': {
      // Telemetry only — the canonical assembled text comes from the closing
      // `result` frame's `result` field. Architect-locked: assistant-frame
      // text accumulator is observed-only; `result.result` wins.
      //
      // We DO opportunistically accumulate text-block content as a fallback
      // for the case where the subprocess exits without a `result` frame
      // (turn aborted mid-stream) — better to surface partial output than
      // nothing. Filter on `c.type === 'text'` to skip thinking + tool_use
      // blocks (Delta #1 bonus finding — Opus 4.7 emits 'thinking' blocks).
      const a = frame as AssistantFrame;
      const blocks = a.message?.content ?? [];
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          state.assembledText += block.text;
        }
      }
      return state;
    }
    case 'user':
    case 'stream_event':
      // Tool-result + token-delta frames — telemetry only. We let Claude
      // Code own the entire tool-dispatch loop (it speaks MCP natively
      // with the inline --mcp-config we synthesize); the adapter only
      // observes the conversation, never participates in tool dispatch.
      return state;
    case 'result': {
      const r = frame as ResultFrame;
      state.resultFrameSeen = true;
      state.resultSubtype = r.subtype ?? null;
      state.resultIsError = typeof r.is_error === 'boolean' ? r.is_error : null;
      state.resultApiErrorStatus = typeof r.api_error_status === 'number' ? r.api_error_status : null;
      if (typeof r.result === 'string') {
        // Result frame's `result` field is the canonical assembled text.
        // Overwrites the assistant-frame fallback we accumulated above —
        // the CLI may have applied final formatting / truncation.
        state.assembledText = r.result;
      }
      state.stopReason = r.stop_reason ?? state.stopReason;
      if (r.usage) state.usage = r.usage;
      if (typeof r.total_cost_usd === 'number') state.totalCostUsd = r.total_cost_usd;
      return state;
    }
    default:
      // Unknown frame type — defensive default. Future CLI versions may
      // add new types and we don't want to crash; just observe and move on.
      return state;
  }
}

/**
 * Stateful line-buffered stream-json reader. Feed it raw stdout chunks;
 * call `flush()` after subprocess exit to emit any trailing partial line.
 *
 * Exposed as a class so the adapter can wire it to the `claude -p`
 * subprocess's `stdout.on('data', ...)` event without needing a
 * Transform stream subclass — keeps the dep surface minimal.
 *
 * Malformed JSON lines are skipped with a logged warning (defensive —
 * shouldn't happen in practice but a single bad line shouldn't crash
 * the turn).
 */
export class StreamJsonReader {
  private buffer = '';
  private state = newTurnAccumulator();
  private readonly onParseError?: (line: string, err: Error) => void;

  constructor(opts: { onParseError?: (line: string, err: Error) => void } = {}) {
    this.onParseError = opts.onParseError;
  }

  /** Feed a chunk of stdout. Triggers `applyFrame` for every complete line. */
  feed(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      this.parseLine(line);
    }
  }

  /** Process any trailing line that didn't end with a newline. Idempotent. */
  flush(): void {
    const trailing = this.buffer.trim();
    this.buffer = '';
    this.parseLine(trailing);
  }

  /** Snapshot of the current accumulator. Caller may freely mutate. */
  snapshot(): TurnAccumulator {
    return this.state;
  }

  private parseLine(line: string): void {
    if (!line) return;
    let frame: StreamJsonFrame;
    try {
      frame = JSON.parse(line) as StreamJsonFrame;
    } catch (err) {
      this.onParseError?.(line, err as Error);
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      this.onParseError?.(line, new Error('frame missing required `type` field'));
      return;
    }
    this.state = applyFrame(this.state, frame);
  }
}
