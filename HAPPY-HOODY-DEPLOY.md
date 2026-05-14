# Happy Hoody Excalidraw Deployment

This is the Happy-Hoody fork of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw), deployed at **https://idraw.thehappyhoody.com** on the `2012giga` server.

The only divergence from upstream is `.env.production` — `VITE_APP_WS_SERVER_URL` is pointed at our self-hosted excalidraw-room instead of `oss-collab.excalidraw.com`. Everything else tracks `master`.

## Architecture

```
Browser → Cloudflare → cloudflared tunnel → Caddy (:80) → {
    /socket.io/* → excalidraw-room (:3051) — websocket collab server
    everything else → excalidraw frontend (:3050) — built nginx static
}
```

- **Frontend image:** built locally as `excalidraw-local:latest` from this repo
- **Room image:** `excalidraw/excalidraw-room:sha-03ff435` from Docker Hub (pinned)
- **Auth/storage model:** none. Drawings live in each user's browser localStorage. Live collab uses our room server with end-to-end encryption (server only relays opaque blobs, no plaintext drawing data ever touches our disk). Nothing to delete server-side if abused — just stop sharing the URL.

## Where things live on 2012giga

| Path | What |
|---|---|
| `~/projects/excalidraw/` | compose dir (`docker-compose.yml`) |
| `~/projects/excalidraw/excalidraw.git/` | bare repo (object store, never work here directly) |
| `~/projects/excalidraw/excalidraw-main/` | worktree on `master` (this repo, this is where edits happen) |
| `~/projects/excalidraw/snapshots/` | offline image tarballs for emergency rollback |
| `/etc/caddy/Caddyfile` | hostname → port routing block for `idraw.thehappyhoody.com` |

Subnet `172.46.0.0/24` is reserved for this stack — see `Happy-Hoody/infra` `docs/docker-subnet-allocation.md`.

## Daily ops

```bash
cd ~/projects/excalidraw

# start / restart
docker compose up -d

# stop
docker compose down

# logs
docker compose logs -f excalidraw
docker compose logs -f excalidraw-room

# verify routing through Caddy
curl -sI -H "Host: idraw.thehappyhoody.com" http://localhost:80
curl -s -H "Host: idraw.thehappyhoody.com" "http://localhost:80/socket.io/?EIO=4&transport=polling"
# ↑ second one should return JSON with a "sid" field if room server is reachable
```

## Recovery scenarios

| Scenario | Recovery |
|---|---|
| Container crashed / `down -v` | `docker compose up -d` (image is reused) |
| `excalidraw-local:latest` image deleted | `docker compose build && docker compose up -d` (~3 min, rebuilds from worktree) |
| Image deleted **and** a fresh build is broken (e.g., upstream change broke ours) | `docker load -i ~/projects/excalidraw/snapshots/excalidraw-local-<date>-<sha>.tar` then `docker tag excalidraw-local:<date>-<sha> excalidraw-local:latest` and `docker compose up -d` |
| Source worktree wiped | `cd ~/projects/excalidraw && git clone --bare git@github.com:Happy-Hoody/excalidraw.git excalidraw.git && git -C excalidraw.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git -C excalidraw.git fetch origin && git -C excalidraw.git remote add upstream https://github.com/excalidraw/excalidraw.git && git -C excalidraw.git worktree add ../excalidraw-main master` then rebuild |
| Whole `~/projects/excalidraw/` directory wiped | Same as worktree wipe, but also re-create `docker-compose.yml` (see below) |
| Cloudflare tunnel returns 502 | Check `sudo journalctl -u cloudflared -n 30` — most likely the published-app route URL got typed without `localhost:` prefix; fix in Zero Trust dashboard. Confirm Caddy is up: `systemctl is-active caddy`. |

### `docker-compose.yml` recovery

If the compose file is lost, recreate it as:

```yaml
services:
  excalidraw:
    build:
      context: ./excalidraw-main
      dockerfile: Dockerfile
    image: excalidraw-local:latest
    container_name: excalidraw
    restart: unless-stopped
    ports:
      - "127.0.0.1:3050:80"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost"]
      interval: 30s
      timeout: 5s
      retries: 3

  excalidraw-room:
    image: excalidraw/excalidraw-room:sha-03ff435
    container_name: excalidraw-room
    restart: unless-stopped
    ports:
      - "127.0.0.1:3051:80"

networks:
  default:
    name: excalidraw_default
    ipam:
      driver: default
      config:
        - subnet: 172.46.0.0/24
```

### Caddy block recovery

If `/etc/caddy/Caddyfile` loses our block, add this **before** the `http://*.thehappyhoody.com` brochure-cms catch-all:

```
http://idraw.thehappyhoody.com {
    @socketio path /socket.io/*
    handle @socketio {
        reverse_proxy localhost:3051
    }
    handle {
        reverse_proxy localhost:3050
    }
}
```

Then `sudo systemctl reload caddy`.

### Cloudflare tunnel route recovery

In Zero Trust dashboard → Networks → Connectors → tunnel `HHoody-local` → Published application routes → Add route:
- Subdomain: `idraw`
- Domain: `thehappyhoody.com`
- Service Type: `HTTP`
- URL: **`localhost:80`** (not just `80` — that bug bit us once already)

## Upgrades

To pull in upstream Excalidraw changes:

```bash
cd ~/projects/excalidraw/excalidraw-main
git fetch upstream
git rebase upstream/master
# → resolves cleanly unless upstream touched .env.production; if so,
#   keep our VITE_APP_WS_SERVER_URL line during conflict resolution.
git push origin master --force-with-lease

# Tag the current good image BEFORE rebuilding (insurance)
docker tag excalidraw-local:latest excalidraw-local:rollback-$(date +%Y-%m-%d)
docker save -o ~/projects/excalidraw/snapshots/excalidraw-local-$(date +%Y-%m-%d)-$(git rev-parse --short HEAD).tar excalidraw-local:rollback-$(date +%Y-%m-%d)

cd ~/projects/excalidraw
docker compose build excalidraw
docker compose up -d
```

If the new build breaks the site, `docker tag excalidraw-local:rollback-<date> excalidraw-local:latest && docker compose up -d` to revert.

To upgrade the room server, look up the latest tag at https://hub.docker.com/r/excalidraw/excalidraw-room/tags, edit the `sha-...` pin in `docker-compose.yml`, then `docker compose pull excalidraw-room && docker compose up -d excalidraw-room`.
