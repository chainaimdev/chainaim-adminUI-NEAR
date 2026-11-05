# near-watch in Docker (DOCKERIZE-PLAN.md section 5). Build context = the repo root, because near-watch imports
# ../../../packages/chain-core/src. No npm install: near-watch has devDependencies only (typescript, @types/node)
# and Node 24 runs the .ts sources directly, exactly as `node src/main.ts` does on the PC.
#   docker compose build near-watch        (from the repo root; see docker-compose.yml)
FROM node:24-slim

WORKDIR /app
COPY packages/chain-core/package.json packages/chain-core/package.json
COPY packages/chain-core/src packages/chain-core/src
COPY services/near-watch/package.json services/near-watch/package.json
COPY services/near-watch/src services/near-watch/src

# /data holds the SQLite store (named volume). Created here so a new volume is owned by the node user.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/services/near-watch
EXPOSE 8790

# Secrets and chain values come from the env file mounted by compose, read by Node's own --env-file parser
# (the same as start-live.ps1 today). Flags (--bind, --store, --watch ...) are given by compose `command`.
ENTRYPOINT ["node", "--env-file=/run/secrets/near-watch.env", "src/main.ts"]
CMD ["--help"]
