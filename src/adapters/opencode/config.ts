/**
 * `OPENCODE_CONFIG_CONTENT` synthesis for the opencode adapter.
 *
 * The adapter inlines the OpenCode config rather than writing a file —
 * no filesystem cleanup risk, no permissions concerns, secrets-redacted
 * stderr config-log preserves debuggability. ADR 0015 Q2.
 *
 * The synthesized config:
 *   - Hardcodes `--hostname 127.0.0.1` and `mdns: false` (security
 *     mitigation for OpenCode's no-Bearer-auth in v1.14.x). NOT
 *     configurable — see ADR 0015 §53 + design §6.
 *   - Auto-detects the provider from the `model` arg's `provider/...`
 *     prefix and emits a `provider.<name>.options` block for whichever
 *     env vars are present (mirrors OpenCode's own behavior).
 *   - Registers agent-tempo as an OpenCode MCP child via `type: "local"`
 *     stdio. OpenCode spawns a SECOND copy of `dist/server.js` as its
 *     MCP subprocess and dispatches tool calls there directly — the
 *     adapter is never on the tool-dispatch hot path.
 *
 * Design reference: docs/design/449-opencode-adapter.md §3.7, §4.1.
 */

/**
 * Map of provider id (matches the prefix in `model: 'provider/name'`) to
 * the env var name that holds the API key. Population is best-effort —
 * if the env var isn't set, the corresponding `provider.X.options` block
 * is omitted and OpenCode either falls back to its own auth chain (e.g.
 * macOS Keychain for Anthropic OAuth) or fails the session-create with
 * a clear error.
 */
export const PROVIDER_ENV_MAP: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cohere: 'COHERE_API_KEY',
  xai: 'XAI_API_KEY',
  // Bedrock and Vertex use AWS / GCP creds, not a single bearer token.
  // OpenCode reads the standard AWS/GCP env chain — no `provider.X.options`
  // block needed here.
  bedrock: '',
  vertex: '',
  // Ollama is local; no API key.
  ollama: '',
  // GitHub Copilot via OpenCode uses OAuth; no API key in env.
  github: '',
});

export type ProviderEnvMap = Readonly<Record<string, string>>;

/**
 * Extract the provider id from a `provider/model` string. Returns `null`
 * when the input doesn't have a `/` (e.g. legacy claude-api ids like
 * `claude-opus-4-7`) — caller decides whether to default to a particular
 * provider or surface the error.
 */
export function detectProviderEnvFromModel(model: string): string | null {
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  return model.slice(0, slash).toLowerCase();
}

/**
 * Inputs for {@link synthesizeOpenCodeConfig}. Each field maps to one
 * branch of the synthesized JSON.
 */
export interface SynthesizeOpenCodeConfigOpts {
  /** Combined `provider/model` recruit-arg, e.g. `'anthropic/claude-opus-4-7'`. */
  model: string;
  /** Probed-free port `opencode serve` will bind. */
  port: number;
  /** Absolute path to agent-tempo's `dist/server.js` — runs as OpenCode's MCP child. */
  mcpServerPath: string;
  /** Ensemble name — passed through to the MCP child env. */
  ensemble: string;
  /** Player name — passed through to the MCP child env. */
  playerName: string;
  /** Temporal address — passed through to the MCP child env. */
  temporalAddress: string;
  /** Temporal namespace — passed through to the MCP child env. */
  temporalNamespace: string;
  /**
   * Test seam — defaults to `process.env`. Tests inject a stub map to
   * exercise the provider-detection + env-var-presence branches without
   * mutating the real environment.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Synthesize the inline `OPENCODE_CONFIG_CONTENT` JSON value. Returns the
 * stringified JSON, ready to set as the env var on the `opencode serve`
 * spawn. Caller passes through {@link redactSecrets} before logging.
 *
 * Shape per design §3.7:
 * ```json
 * {
 *   "model": "anthropic/claude-opus-4-7",
 *   "provider": { "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } } },
 *   "server": { "port": 4732, "hostname": "127.0.0.1", "mdns": false },
 *   "mcp": {
 *     "agent-tempo": {
 *       "type": "local",
 *       "command": ["node", "/abs/path/to/dist/server.js"],
 *       "environment": { "AGENT_TEMPO_ENSEMBLE": "{env:AGENT_TEMPO_ENSEMBLE}", … }
 *     }
 *   }
 * }
 * ```
 *
 * The `{env:VAR}` markers are OpenCode-native substitutions — OpenCode
 * resolves them at config-read time, so credentials never appear in the
 * literal JSON we hand to the subprocess.
 */
export function synthesizeOpenCodeConfig(opts: SynthesizeOpenCodeConfigOpts): string {
  const env = opts.env ?? process.env;
  const providerId = detectProviderEnvFromModel(opts.model);
  const providerBlock: Record<string, { options: Record<string, string | boolean> }> = {};

  if (providerId) {
    const envVarName = PROVIDER_ENV_MAP[providerId];
    if (envVarName && env[envVarName]) {
      const options: Record<string, string | boolean> = {
        apiKey: `{env:${envVarName}}`,
      };
      // Anthropic provider supports prompt caching; opt-in via the
      // OpenCode-native `setCacheKey` knob. Other providers don't have an
      // analog, so we only set this for the anthropic block.
      if (providerId === 'anthropic') {
        options.setCacheKey = true;
      }
      providerBlock[providerId] = { options };
    }
    // Bedrock / Vertex / Ollama / GitHub-Copilot intentionally skipped —
    // they don't use a bearer-token env var; OpenCode reads their native
    // auth chains (AWS env vars, gcloud ADC, local server, OAuth file).
  }

  const config = {
    model: opts.model,
    ...(Object.keys(providerBlock).length > 0 ? { provider: providerBlock } : {}),
    server: {
      port: opts.port,
      // SECURITY: hardcoded loopback. NOT configurable. ADR 0015 §53.
      hostname: '127.0.0.1',
      // SECURITY: avoid leaking session presence over Bonjour. ADR 0015 §82.
      mdns: false,
    },
    mcp: {
      'agent-tempo': {
        type: 'local',
        command: ['node', opts.mcpServerPath],
        environment: {
          AGENT_TEMPO_ENSEMBLE: '{env:AGENT_TEMPO_ENSEMBLE}',
          AGENT_TEMPO_PLAYER_NAME: '{env:AGENT_TEMPO_PLAYER_NAME}',
          TEMPORAL_ADDRESS: '{env:TEMPORAL_ADDRESS}',
          TEMPORAL_NAMESPACE: '{env:TEMPORAL_NAMESPACE}',
        },
      },
    },
  };

  return JSON.stringify(config);
}
