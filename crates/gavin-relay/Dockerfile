# syntax=docker/dockerfile:1
#
# The Relay's image. Build it from the REPOSITORY ROOT -- the crate is a
# workspace member and resolves against the workspace's Cargo.lock:
#
#   docker build -f crates/gavin-relay/Dockerfile -t gavin-relay .
#
# Configuration and running it: docs/relay.md.

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
    cargo build --release --locked -p gavin-relay \
 && cp target/release/gavin-relay /usr/local/bin/

FROM debian:trixie-slim
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin relay
COPY --from=build /usr/local/bin/gavin-relay /usr/local/bin/gavin-relay
USER relay
ENV GAVIN_RELAY_LISTEN=0.0.0.0:8443
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/gavin-relay"]
