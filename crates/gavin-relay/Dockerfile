# syntax=docker/dockerfile:1
#
# The Relay's image. Build it from the REPOSITORY ROOT -- the crate is a
# workspace member and resolves against the workspace's Cargo.lock:
#
#   docker build -f crates/gavin-relay/Dockerfile -t gavin-relay .
#
# The local dev stack (`docker compose -f dev-stack/compose.yaml up`) builds
# this. Configuration is the environment alone; see the table in
# crates/gavin-relay/src/main.rs.

FROM rust:1.97-slim-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY app/src-tauri/Cargo.toml app/src-tauri/Cargo.toml
RUN mkdir -p app/src-tauri/src \
 && echo 'fn main() {}' > app/src-tauri/src/main.rs \
 && touch app/src-tauri/src/lib.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p gavin-relay --bin gavin-relay \
 && cp target/release/gavin-relay /usr/local/bin/

FROM debian:trixie-slim
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin relay
COPY --from=build /usr/local/bin/gavin-relay /usr/local/bin/gavin-relay
USER relay
ENV GAVIN_RELAY_LISTEN=0.0.0.0:8443
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/gavin-relay"]
