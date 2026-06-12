# Release Notes

## v0.1.0

Image tag: `ghcr.io/<owner>/proxy-control-center:v0.1.0`

This is the first preview release for the Proxy Control Center vertical slice. Use `latest` only for local trials; production-style deployments should pin `IMAGE_TAG=v0.1.0` in `deploy/.env` and keep `install.sh`, Compose files, `.env.example`, deployment README, and this file from the same tag.

### Migrations

The PostgreSQL path applies migrations `001_init.sql` through `008_subscription_source_missing.sql` and records filename, checksum, and execution time in `schema_migrations`.

- `001_init.sql`: base admin, node, audit, realtime, and schema migration tables.
- `002_subscriptions.sql`: subscription source persistence.
- `003_admin_login_lock.sql`: administrator login failure and lock state.
- `004_traffic_summary_source.sql`: daily traffic summary source dimension.
- `005_local_share_tokens.sql`: independent local share token lifecycle.
- `006_backup_jobs.sql`: backup and restore job summaries.
- `007_subscription_source_options.sql`: subscription source type, auto-enable, and private-network options.
- `008_subscription_source_missing.sql`: subscription-missing node flag.

Do not edit published migration files in place. A checksum failure is a release blocker; the app refuses startup with restore/compensating-migration guidance, and `smoke:postgres` verifies that behavior against a real PostgreSQL database.

### Environment Variables

New deployments should start from `deploy/.env.example`. Required production secrets are still empty by default and are filled by `deploy/install.sh` when missing:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `CONFIG_ENCRYPTION_KEY`

Runtime variables now covered by Compose and backend checks include `PUBLIC_BASE_URL`, PostgreSQL pool settings, Redis readiness, realtime TTL limits, subscription fetch and scheduler limits, share rate limits, backup retention, and log rotation.
`NETWORK_MODE` is reported in system status so operators can see when the Linux-only host network template is active.

### Port Mapping

The default local-directory Compose maps `SERVER_PORT` and the local node ranges from `.env`:

- `LOCAL_TCP_PORT_RANGE=20000-20100`
- `LOCAL_UDP_PORT_RANGE=20000-20100`

Docker bridge deployments cannot add host port mappings after containers are running. Change the ranges in `.env` and recreate containers before enabling local nodes outside the current range. Linux users who need arbitrary local listening ports can opt into `docker-compose.host.yml` and manage firewall exposure themselves.

### Proxy Core Config

The app writes the current rendered proxy core config to `data/engine/current.json` and keeps the last usable config in `data/engine/previous.json`. Render or reload failures keep the admin UI available and expose the latest engine error in system status; managed mode can roll back to the previous config.

### Upgrade

Before upgrading:

```bash
cd deploy
docker compose exec app proxy-control-center backup create --reason before-update
```

Then pin the target image tag and recreate services:

```bash
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=v0.1.0/' .env
docker compose pull
docker compose up -d
curl http://127.0.0.1:8080/ready
```

### Rollback

If the new version fails:

1. Set `IMAGE_TAG` in `.env` back to the previous known-good immutable tag.
2. Run `docker compose up -d`.
3. Check `curl http://127.0.0.1:8080/ready` and `docker compose logs app --tail 100`.
4. If migrations or data are no longer usable, restore the pre-upgrade logical backup or the whole deployment directory backup.

### Release Gate

Before publishing this version, run:

```bash
pnpm smoke:all -- --require-postgres
pnpm smoke:all -- --require-postgres --require-compose
docker compose --env-file .env -f deploy/docker-compose.local.yml config --quiet
docker compose --env-file .env -f deploy/docker-compose.host.yml config --quiet
docker compose --env-file .env -f deploy/docker-compose.yml config --quiet
```
