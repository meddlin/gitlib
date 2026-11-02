# syntax=docker/dockerfile:1

# ---- build ----
FROM node:26-slim AS build
WORKDIR /app

# Install dependencies first so this layer is cached until a manifest changes.
COPY package.json package-lock.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/web apps/web
RUN npm run build -w @gitlib/web

# Drop dev dependencies; the server bundle still imports react, tanstack, etc. at runtime.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:26-slim
ENV NODE_ENV=production \
    PORT=3000 \
    GITLIB_HOME=/data

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/package.json package.json
COPY --from=build --chown=node:node /app/packages packages
COPY --from=build --chown=node:node /app/apps/web/package.json apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/server.mjs apps/web/server.mjs
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist

# Config + SQLite live in /data (a volume); repositories are mounted at /home/node/git,
# which is the default scan root (~/git) for the node user.
RUN mkdir -p /data /home/node/git && chown node:node /data /home/node/git
USER node
WORKDIR /app/apps/web

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
