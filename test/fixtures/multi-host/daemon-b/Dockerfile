# daemon-b — agent-tempo daemon running with hostname=host-b.
#
# Identical to daemon-a Dockerfile; kept as a separate file so compose's
# two services can have distinct build contexts if they ever need to
# diverge (e.g. different flags, different npm scripts). Today they're
# pure copies.

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

CMD ["node", "dist/daemon.js"]
