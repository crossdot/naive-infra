ARG CADDY_VERSION=2.11.7
FROM caddy:${CADDY_VERSION}-builder AS builder

RUN xcaddy build \
    --with github.com/caddyserver/forwardproxy=github.com/klzgrad/forwardproxy@v2.11.7-naive2 \
    --output /usr/bin/caddy

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
RUN /usr/bin/caddy list-modules | grep -q '^http.handlers.forward_proxy$'
