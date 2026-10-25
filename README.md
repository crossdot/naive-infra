# NaiveProxy-compatible Caddy forward proxy (Docker Compose)

## Important notes

- This uses Caddy with the NaiveProxy fork of `forwardproxy`; it does not run a separate Naive server process.
- `CADDY_VERSION` is pinned for reproducibility. Before production, test the selected Caddy version against the fork and pin the source revision/digest you have validated.
- The container runs as UID 0 so it can read Certbot's root-restricted certificate tree. Capabilities are dropped except `NET_BIND_SERVICE`, the filesystem is read-only, and the Let's Encrypt tree is mounted read-only. Review this trade-off for your threat model.
- The proxy password is supplied through `.env`. Keep `.env` private and use a long random URL-safe value.
- This configuration does not publish port 80. Existing certificates must remain valid; renew them using the method that issued them.
- Do not expose an unauthenticated forward proxy.

## 1. Install Docker Engine and Compose v2

Install Docker Engine and the Compose plugin using Docker's official Ubuntu instructions. Verify:

```sh
docker --version
docker compose version
```

## 2. Prepare project

```sh
sudo mkdir -p /opt/naive-infra
sudo chown "$USER":"$USER" /opt/naive-infra
# Copy this project directory to /opt/naive-infra.
cd /opt/naive-infra
cp .env.example .env
chmod 600 .env
```

Edit `.env`: set `DOMAIN`, `CERT_NAME`, `PROXY_USER`, and a strong `PROXY_PASSWORD`.
`CERT_NAME` must match the actual Certbot lineage directory under `/etc/letsencrypt/live/`.
The DNS A record for `DOMAIN` must point to this VPS.

Check that these files exist on the host:

```sh
sudo test -r "/etc/letsencrypt/live/$(grep '^CERT_NAME=' .env | cut -d= -f2)/fullchain.pem"
sudo test -r "/etc/letsencrypt/live/$(grep '^CERT_NAME=' .env | cut -d= -f2)/privkey.pem"
```

The container mounts `/etc/letsencrypt` as a whole so symlinks from `live/` to `archive/` resolve.

## 3. Firewall

Allow inbound TCP 443 and SSH from trusted administrative addresses. Do not expose the Docker socket or any proxy control port. Docker-published ports can bypass some UFW expectations, so verify firewall rules at both the cloud-provider and host levels.

## 4. Validate and launch

```sh
chmod +x scripts/*.sh
./scripts/validate.sh
./scripts/deploy.sh
docker compose logs --tail=100 caddy
```

Test the website from another machine:

```sh
curl -I "https://${DOMAIN}"
```

Test proxy access using a NaiveProxy client with a local SOCKS listener. The client config format is documented in the upstream NaiveProxy README:

```json
{
  "listen": "socks://127.0.0.1:1080",
  "proxy": "https://USERNAME:PASSWORD@DOMAIN"
}
```

Use the actual credentials and domain in the local client config. Protect that file because it contains credentials. Test a request through SOCKS5, for example:

```sh
curl --proxy socks5h://127.0.0.1:1080 https://example.com/
```

## 5. Certificate renewal

First identify how the current certificate was issued:

```sh
sudo certbot certificates
sudo systemctl list-timers | grep -i certbot || true
```

If Certbot manages the certificate and renewal configuration supports unattended renewal, enable/test the appropriate Certbot timer and run:

```sh
sudo certbot renew --dry-run
```

Install `scripts/renewal-deploy-hook.sh` as a deploy hook only after changing `PROJECT_DIR` to this project's absolute path and confirming the service name. For example:

```sh
sudo install -D -m 0750 scripts/renewal-deploy-hook.sh \
  /etc/letsencrypt/renewal-hooks/deploy/reload-naive-caddy.sh
```

A deploy hook reloads Caddy after successful renewal. If the certificate was issued using Certbot's manual authenticator without hooks, renewal cannot be automated simply by running `certbot renew`; configure a supported DNS/HTTP authenticator or renew manually. Do not assume renewal is configured until the dry run succeeds.

## 6. Operations

```sh
docker compose ps
docker compose logs -f caddy
docker compose restart caddy
docker compose down
```

Before upgrading, back up `.env`, `Caddyfile`, and the site. Rebuild and validate before rollout. Pin a tested image/source version rather than blindly using `latest`.

## 7. Acceptance checks

- `docker compose config --quiet` succeeds.
- Image builds and `http.handlers.forward_proxy` is present.
- Caddy validates the Caddyfile.
- HTTPS certificate matches the configured domain and is not expired.
- Static site loads.
- Correct credentials allow proxy use; incorrect credentials do not.
- Android and Windows clients work.
- DNS/IPv6 behavior is checked for leaks.
- Certificate renewal dry-run and post-renewal reload are tested.
