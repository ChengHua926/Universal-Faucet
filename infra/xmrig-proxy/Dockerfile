FROM debian:bookworm-slim

ARG XMRIG_PROXY_VERSION=6.26.0
ARG XMRIG_PROXY_SHA256=73cceb10be474ba8ce20faddb9d2c6af0cb50bce84e72f7d36a326f7147c01c4

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

RUN curl -fsSLO "https://github.com/xmrig/xmrig-proxy/releases/download/v${XMRIG_PROXY_VERSION}/xmrig-proxy-${XMRIG_PROXY_VERSION}-linux-static-x64.tar.gz" \
    && echo "${XMRIG_PROXY_SHA256}  xmrig-proxy-${XMRIG_PROXY_VERSION}-linux-static-x64.tar.gz" | sha256sum -c - \
    && tar -xzf "xmrig-proxy-${XMRIG_PROXY_VERSION}-linux-static-x64.tar.gz" \
    && cp "xmrig-proxy-${XMRIG_PROXY_VERSION}/xmrig-proxy" /usr/local/bin/xmrig-proxy \
    && rm -rf /tmp/*

EXPOSE 3333 8080

CMD ["xmrig-proxy", "--help"]
