# Build from the repo root, so the project template is in the context:
#   docker build -f apps/control-plane/Dockerfile -t control-plane .
FROM node:24-alpine
# MinIO's client, for buckets and scoped keys (src/minio.ts). Same image and mc as the fork's
# minio-createbucket; a static Go binary.
COPY --from=ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z /usr/bin/mc /usr/local/bin/mc
WORKDIR /app/apps/control-plane
COPY apps/control-plane/package.json apps/control-plane/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/control-plane/src ./src
# src/config.ts finds the template at this path relative to src/ (PROJECT_TEMPLATE_PATH overrides).
COPY deploy/platform/project-compose.yaml /app/deploy/platform/project-compose.yaml
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/main.ts"]
