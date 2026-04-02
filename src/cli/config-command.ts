import * as readline from 'readline';
import { loadConfigFile, saveConfigFile, CONFIG_FILE_PATH, PersistedConfig } from '../config';
import { createTemporalConnection } from '../connection';
import { getConfig } from '../config';
import * as out from './output';

/** Read a line from stdin with a prompt and optional default value. */
function ask(prompt: string, defaultVal?: string, mask = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const display = defaultVal ? `${prompt} (${defaultVal}): ` : `${prompt}: `;

    if (mask) {
      // For secret input: write prompt manually, mute output
      process.stdout.write(`? ${display}`);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.setRawMode) stdin.setRawMode(true);

      let input = '';
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === '\n' || c === '\r') {
          if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input || defaultVal || '');
        } else if (c === '\u0003') {
          // Ctrl+C
          rl.close();
          process.exit(0);
        } else if (c === '\u007f' || c === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += c;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(`? ${display}`, (answer) => {
        rl.close();
        resolve(answer.trim() || defaultVal || '');
      });
    }
  });
}

/** Ask user to choose from a list of options. Returns the selected option. */
async function choose(prompt: string, options: string[]): Promise<string> {
  console.log(`? ${prompt}:`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }
  const answer = await ask('Choice', '1');
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx];
  return options[0];
}

/** Interactive config setup: `claude-tempo config` */
export async function configInteractive(): Promise<void> {
  out.heading('claude-tempo config');

  const existing = loadConfigFile();

  const address = await ask(
    'Temporal address',
    existing.temporalAddress || 'localhost:7233',
  );

  const namespace = await ask(
    'Temporal namespace',
    existing.temporalNamespace || 'default',
  );

  const authMethod = await choose('Auth method', ['None', 'API key', 'mTLS']);

  const config: PersistedConfig = {
    temporalAddress: address,
    temporalNamespace: namespace,
  };

  if (authMethod === 'API key') {
    config.temporalApiKey = await ask('API key', existing.temporalApiKey, true);
  } else if (authMethod === 'mTLS') {
    config.temporalTlsCertPath = await ask('TLS cert path', existing.temporalTlsCertPath);
    config.temporalTlsKeyPath = await ask('TLS key path', existing.temporalTlsKeyPath);
  }

  saveConfigFile(config);
  out.success(`Saved to ${CONFIG_FILE_PATH}`);

  // Test connection
  try {
    const resolved = getConfig({
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      temporalApiKey: config.temporalApiKey,
      temporalTlsCertPath: config.temporalTlsCertPath,
      temporalTlsKeyPath: config.temporalTlsKeyPath,
    });
    const conn = await Promise.race([
      createTemporalConnection(resolved),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5000),
      ),
    ]);
    await conn.close();
    out.success('Connected successfully');
  } catch (err: any) {
    out.warn(`Could not connect: ${err?.message || err}`);
    out.log(`  Config was saved — you can fix the connection and re-run ${out.dim('claude-tempo config')}`);
  }
}

/** Non-interactive: `claude-tempo config set <key> <value>` */
export function configSet(key: string, value: string): void {
  const config = loadConfigFile();
  const keyMap: Record<string, keyof PersistedConfig> = {
    temporalAddress: 'temporalAddress',
    'temporal-address': 'temporalAddress',
    temporalNamespace: 'temporalNamespace',
    'temporal-namespace': 'temporalNamespace',
    temporalApiKey: 'temporalApiKey',
    'temporal-api-key': 'temporalApiKey',
    temporalTlsCertPath: 'temporalTlsCertPath',
    'temporal-tls-cert': 'temporalTlsCertPath',
    'temporal-tls-cert-path': 'temporalTlsCertPath',
    temporalTlsKeyPath: 'temporalTlsKeyPath',
    'temporal-tls-key': 'temporalTlsKeyPath',
    'temporal-tls-key-path': 'temporalTlsKeyPath',
  };

  const configKey = keyMap[key];
  if (!configKey) {
    out.error(`Unknown config key: "${key}"`);
    out.log(`  Valid keys: ${Object.keys(keyMap).join(', ')}`);
    process.exit(1);
  }

  config[configKey] = value;
  saveConfigFile(config);
  out.success(`Set ${configKey} = ${configKey.includes('Key') ? '****' : value}`);
}

/** Show current config: `claude-tempo config show` */
export function configShow(): void {
  out.heading('claude-tempo config');

  const config = loadConfigFile();
  const resolved = getConfig();

  const rows: Array<[string, string, string]> = [
    ['temporalAddress', resolved.temporalAddress, config.temporalAddress || ''],
    ['temporalNamespace', resolved.temporalNamespace, config.temporalNamespace || ''],
    ['temporalApiKey', resolved.temporalApiKey ? '****' : '(not set)', config.temporalApiKey ? '****' : ''],
    ['temporalTlsCertPath', resolved.temporalTlsCertPath || '(not set)', config.temporalTlsCertPath || ''],
    ['temporalTlsKeyPath', resolved.temporalTlsKeyPath || '(not set)', config.temporalTlsKeyPath || ''],
  ];

  out.log(`  Config file: ${out.dim(CONFIG_FILE_PATH)}`);
  console.log();
  out.log(`  ${'Key'.padEnd(22)} ${'Resolved'.padEnd(35)} ${out.dim('Config file')}`);
  out.log(`  ${'─'.repeat(22)} ${'─'.repeat(35)} ${'─'.repeat(20)}`);
  for (const [key, resolved, file] of rows) {
    out.log(`  ${key.padEnd(22)} ${resolved.padEnd(35)} ${out.dim(file || '-')}`);
  }
  console.log();
}

/** Route `claude-tempo config [subcommand] [args...]` */
export async function configCommand(positional: string[]): Promise<void> {
  const sub = positional[1]; // positional[0] is "config"

  if (!sub) {
    // Interactive setup
    await configInteractive();
  } else if (sub === 'set') {
    const key = positional[2];
    const value = positional[3];
    if (!key || !value) {
      out.error('Usage: claude-tempo config set <key> <value>');
      process.exit(1);
    }
    configSet(key, value);
  } else if (sub === 'show') {
    configShow();
  } else {
    out.error(`Unknown config subcommand: "${sub}"`);
    out.log(`  Usage: ${out.dim('claude-tempo config')}             Interactive setup`);
    out.log(`         ${out.dim('claude-tempo config show')}        Show current config`);
    out.log(`         ${out.dim('claude-tempo config set <k> <v>')} Set a config value`);
    process.exit(1);
  }
}
