# Multi-host integration harness (PR-F)

Two agent-tempo daemon containers sharing a Temporal dev server. Used by
`test/multi-host-cross-host-restart.test.ts` to validate cross-host
`restart` end-to-end.

**Does not run in the default `npm test` suite.** The integration test
gates on `INTEGRATION_MULTI_HOST=1` and `docker-compose` being available.

## Prerequisites

- Docker + Docker Compose v2
- Ports `7233` (Temporal gRPC) and `8233` (Temporal UI) free on the host

## Running the harness

From the repository root:

```bash
# Boot the three services (Temporal dev + two daemons).
docker-compose -f test/fixtures/multi-host/docker-compose.yml up -d --build

# Wait for Temporal health + daemon warm-up (~15-30s on first run —
# daemon-a and daemon-b both `npm ci && npm run build` against the
# mounted source tree).
docker-compose -f test/fixtures/multi-host/docker-compose.yml ps

# Run the integration test. TEMPORAL_ADDRESS points at the exposed host.
INTEGRATION_MULTI_HOST=1 TEMPORAL_ADDRESS=localhost:7233 \
  npx mocha dist-test/test/multi-host-cross-host-restart.test.js

# Tear down.
docker-compose -f test/fixtures/multi-host/docker-compose.yml down -v
```

## Networking notes

- **Linux**: `network_mode: "host"` is *not* used — the compose file uses
  the default bridge network so that `daemon-*` can reach `temporal` by
  service name. The published port `7233:7233` exposes Temporal to the
  host so the test runner (which executes on the host, not inside a
  container) can connect.
- **macOS / Windows**: identical — containers talk to `temporal:7233`
  via service-DNS; the host talks to `localhost:7233` via the port map.
- If port 7233 is already in use on your host, change the `ports:` block
  (`- "17233:7233"`) and export `TEMPORAL_ADDRESS=localhost:17233` when
  running the test.

## Why local-source build?

The daemon Dockerfiles do `COPY . /app && npm ci && npm run build` — they
build from the current working tree, not a published image. This is
deliberate per PR-F §8 answer 4: the integration test validates the branch
under test. Using `FROM agent-tempo:latest` would test whatever is on npm
(v0.24 or worse) instead of your local changes.

BuildKit cache mounts are available but commented out in
`daemon-a/Dockerfile`; enable them with `DOCKER_BUILDKIT=1` if rebuild
time becomes a friction point.
