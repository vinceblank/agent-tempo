import { readFileSync } from 'fs';
import { Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { Config } from './config';

/** Build TLS + metadata options from config for Temporal connections. */
function buildConnectionOptions(config: Config) {
  const opts: {
    address: string;
    tls?: { clientCertPair: { crt: Buffer; key: Buffer } };
    metadata?: Record<string, string>;
    apiKey?: string;
  } = {
    address: config.temporalAddress,
  };

  // mTLS certificate pair
  if (config.temporalTlsCertPath && config.temporalTlsKeyPath) {
    opts.tls = {
      clientCertPair: {
        crt: readFileSync(config.temporalTlsCertPath),
        key: readFileSync(config.temporalTlsKeyPath),
      },
    };
  }

  // API key auth (Temporal Cloud)
  if (config.temporalApiKey) {
    opts.apiKey = config.temporalApiKey;
    // API key requires TLS — if no client cert pair, enable server-only TLS
    if (!opts.tls) {
      (opts as any).tls = true;
    }
  }

  return opts;
}

/** Create a Temporal Client connection (for Client use in tools, CLI commands, etc.). */
export async function createTemporalConnection(config: Config): Promise<Connection> {
  return Connection.connect(buildConnectionOptions(config));
}

/** Create a Temporal NativeConnection (for Worker use). */
export async function createTemporalNativeConnection(config: Config): Promise<NativeConnection> {
  return NativeConnection.connect(buildConnectionOptions(config));
}
