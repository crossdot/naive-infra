ARG CADDY_VERSION=2.11.7
ARG FORWARDPROXY_VERSION=v2.11.7-naive2

FROM caddy:${CADDY_VERSION}-alpine
RUN set -eux; \
    apk add --no-cache curl tar xz; \
    curl -fsSL \
      "https://github.com/klzgrad/forwardproxy/releases/download/${FORWARDPROXY_VERSION}/caddy-forwardproxy-naive.tar.xz" \
      -o /tmp/caddy-forwardproxy-naive.tar.xz; \
    tar -xJf /tmp/caddy-forwardproxy-naive.tar.xz -C /tmp; \
    BIN="$(find /tmp -type f -name caddy -perm /111 | head -n 1)"; \
    test -n "$BIN"; \
    install -m 0755 "$BIN" /usr/bin/caddy; \
    rm -rf /tmp/*; \
    apk del curl tar xz; \
    /usr/bin/caddy version; \
    /usr/bin/caddy list-modules | grep -qx 'http.handlers.forward_proxy'
