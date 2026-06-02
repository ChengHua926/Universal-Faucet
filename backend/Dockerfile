FROM rust:1-bookworm AS build

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY backend/Cargo.toml backend/Cargo.toml
COPY backend/src backend/src

RUN cargo build --release -p xpool-backend

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/target/release/xpool-backend /usr/local/bin/xpool-backend

ENV BIND_ADDR=0.0.0.0:8081

EXPOSE 8081

CMD ["xpool-backend"]
