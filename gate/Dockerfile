FROM rust:1-bookworm AS build

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY backend/Cargo.toml backend/Cargo.toml
COPY cli/Cargo.toml cli/Cargo.toml
COPY gate/Cargo.toml gate/Cargo.toml
COPY backend/src backend/src
COPY cli/src cli/src
COPY gate/src gate/src

RUN cargo build --release -p xpool-gate

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/target/release/xpool-gate /usr/local/bin/xpool-gate

EXPOSE 3333 8082

CMD ["xpool-gate"]
