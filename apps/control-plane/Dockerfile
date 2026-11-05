# Build from the repo root, so the project template is in the context:
#   docker build -f apps/control-plane/Dockerfile -t control-plane .
#   docker build -f apps/control-plane/Dockerfile --target runner -t control-plane-runner .
FROM node:24-alpine AS base
# MinIO's client, for buckets and scoped keys (src/minio.ts). Same image and mc as the fork's
# minio-createbucket; a static Go binary.
COPY --from=ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z /usr/bin/mc /usr/local/bin/mc
# The backup service (src/backup) runs from the same image: restic, and Postgres 17 clients for the
# projects' Postgres 15 (pg_dump reads older servers; pg_restore writes to them).
RUN apk add --no-cache restic postgresql17-client && mkdir -p /stage && chown node:node /stage
WORKDIR /app/apps/control-plane
COPY apps/control-plane/package.json apps/control-plane/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/control-plane/src ./src
# src/config.ts finds the template at this path relative to src/ (PROJECT_TEMPLATE_PATH overrides).
COPY deploy/platform/project-compose.yaml /app/deploy/platform/project-compose.yaml
ENV NODE_ENV=production PORT=8080

# The runner (src/runner): runs the project stacks through the host's Docker socket, from the
# template above and nothing else. It stays root: the socket belongs to root.
FROM base AS runner
RUN apk add --no-cache docker-cli docker-cli-compose
ENV RUNNER_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/runner/main.ts"]

# The control plane and the backup service: the last stage, so a build without --target (Coolify's)
# gets it as before.
FROM base
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/main.ts"]
