# syntax=docker/dockerfile:1
#
# The Push gateway's image. Build it from the REPOSITORY ROOT -- the crate
# is a workspace member and resolves against the workspace's Cargo.lock:
#
#   docker build -f crates/push-gateway/Dockerfile -t gavin-push-gateway .
#
# Configuration, volumes and running it: docs/push-gateway.md.

FROM rust:1.97-slim-trixie AS build
WORKDIR /src
# Only what the build reads (Dockerfile.dockerignore is an allowlist).
# The desktop host is never built here, but cargo loads every workspace
# member's manifest to resolve the workspace, so it gets its manifest and
# two empty targets.
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY app/src-tauri/Cargo.toml app/src-tauri/Cargo.toml
RUN mkdir -p app/src-tauri/src \
 && echo 'fn main() {}' > app/src-tauri/src/main.rs \
 && touch app/src-tauri/src/lib.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p gavin-push-gateway \
 && cp target/release/gavin-push-gateway /usr/local/bin/

FROM debian:trixie-slim
# The system roots are what rustls verifies Apple and Google against.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin gateway \
 && mkdir /data \
 && chown gateway:gateway /data
COPY --from=build /usr/local/bin/gavin-push-gateway /usr/local/bin/gavin-push-gateway
USER gateway
ENV GAVIN_PUSH_LISTEN=0.0.0.0:8080 \
    GAVIN_PUSH_DATA_DIR=/data
# The database and the permission key. Losing the key invalidates every
# permission ever issued, so this belongs on a volume.
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/gavin-push-gateway"]
