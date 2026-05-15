# daemon-a — agent-tempo daemon running with hostname=host-a.
#
# Local-source build per PR-F §8 answer 4 — the integration test must
# validate the branch under test, not a published image. Optional
# BuildKit cache mount (commented out) can be enabled by setting
# DOCKER_BUILDKIT=1 if build time becomes painful.

FROM node:20-alpine

WORKDIR /app

# RUN --mount=type=cache,target=/root/.npm \
#     npm ci --no-audit --no-fund

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# Daemon entry — spawned by `node dist/daemon.js` matching production.
CMD ["node", "dist/daemon.js"]
