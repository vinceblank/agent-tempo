#!/usr/bin/env node
// Mints a short-lived GitHub App installation token for claude-tempo[bot].
//
// Usage:
//   node scripts/gh-app-token.js           → prints installation token to stdout
//   node scripts/gh-app-token.js --json    → prints full API response
//   node scripts/gh-app-token.js --force   → bypasses cache
//
// Reads AGENT_TEMPO_GH_APP_{ID,INSTALLATION_ID,PRIVATE_KEY} from env, or from
// ~/.agent-tempo/github-app.env if not already set. Caches the token at
// ~/.agent-tempo/github-app.token.json and reuses it while >5min remain.
//
// Plain CommonJS — runs without a build step. Kept out of the TS build per
// the same convention as scripts/lint-skip-reasons.js.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.agent-tempo');
const ENV_FILE = path.join(CONFIG_DIR, 'github-app.env');
const CACHE_FILE = path.join(CONFIG_DIR, 'github-app.token.json');
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\$HOME/g, HOME);
    if (value.startsWith('~/')) value = path.join(HOME, value.slice(2));
    if (!process.env[key]) process.env[key] = value;
  }
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}

async function fetchInstallationToken(jwt, installationId) {
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agent-tempo',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body}`);
  }
  return JSON.parse(body);
}

function readCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const expiresAt = new Date(cached.expires_at).getTime();
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
      return cached;
    }
  } catch {
    // fall through — treat as no cache
  }
  return null;
}

function writeCache(data) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function die(msg) {
  process.stderr.write(`[gh-app-token] ${msg}\n`);
  process.exit(1);
}

async function main() {
  loadEnvFile();
  const appId = process.env.AGENT_TEMPO_GH_APP_ID;
  const installationId = process.env.AGENT_TEMPO_GH_APP_INSTALLATION_ID;
  const keyPath = process.env.AGENT_TEMPO_GH_APP_PRIVATE_KEY;
  const missing = [];
  if (!appId) missing.push('AGENT_TEMPO_GH_APP_ID');
  if (!installationId) missing.push('AGENT_TEMPO_GH_APP_INSTALLATION_ID');
  if (!keyPath) missing.push('AGENT_TEMPO_GH_APP_PRIVATE_KEY');
  if (missing.length) die(`missing env: ${missing.join(', ')} (expected in env or ${ENV_FILE})`);
  if (!fs.existsSync(keyPath)) die(`private key not found at ${keyPath}`);

  const wantJson = process.argv.includes('--json');
  const force = process.argv.includes('--force');

  let token = force ? null : readCache();
  if (!token) {
    const pem = fs.readFileSync(keyPath, 'utf8');
    const jwt = mintJwt(appId, pem);
    token = await fetchInstallationToken(jwt, installationId);
    writeCache(token);
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(token, null, 2) + '\n');
  } else {
    process.stdout.write(token.token);
  }
}

main().catch((err) => die(err.message || String(err)));
