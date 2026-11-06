# The database image of projects made on Postgres 17: Supabase's image plus wal-g, which Supabase's
# Postgres 17 image does not have (its Postgres 15 image ships wal-g 3.0.5, at the same path).
# Point-in-time recovery (deploy/platform/SPEC.md §22) runs /usr/local/bin/wal-g in the database
# container: archive_command, backup-push, backup-fetch for the read-only copy at a moment.
#
# wal-g is built here from its release tag, statically (musl), with libsodium for the encryption
# the platform uses (WALG_LIBSODIUM_KEY): it runs on the image's Alpine base whatever its libc.
# Bump either version below and the image tag the build script derives from them changes with it.
ARG POSTGRES_IMAGE=supabase/postgres:17.6.1.136
ARG WALG_VERSION=v3.0.5

# Go 1.22: wal-g 3.0.5's go.mod; its vendored dependencies predate Go 1.23's linkname rules.
FROM golang:1.22-alpine AS walg
ARG WALG_VERSION
RUN apk add --no-cache bash build-base curl git linux-headers
RUN git clone --depth 1 --branch "${WALG_VERSION}" https://github.com/wal-g/wal-g /src
WORKDIR /src
# A static libsodium in tmp/libsodium, where the crypter's cgo flags look (internal/crypto/libsodium).
RUN ./link_libsodium.sh && go mod vendor
WORKDIR /src/main/pg
RUN CGO_ENABLED=1 go build -mod vendor -trimpath -tags "libsodium netgo osusergo" \
      -ldflags "-s -w -linkmode external -extldflags -static \
        -X github.com/wal-g/wal-g/cmd/pg.walgVersion=${WALG_VERSION#v} \
        -X github.com/wal-g/wal-g/cmd/pg.gitRevision=$(git rev-parse --short HEAD)" \
      -o /wal-g . \
 && /wal-g --version

FROM ${POSTGRES_IMAGE}
COPY --from=walg /wal-g /usr/local/bin/wal-g
