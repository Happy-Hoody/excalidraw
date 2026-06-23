# Happy Hoody Excalidraw Deployment

Happy-Hoody fork of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw),
deployed at **https://idraw.thehappyhoody.com**.

As of the 2026-06-01 DOKS migration this runs on the **DigitalOcean Kubernetes**
cluster `hhoody-shared-cluster` (SFO2), namespace `excalidraw` — **not** on the old
2012giga Docker + Caddy box. (If you're reading an older revision that talks about
Caddy and the `HHoody-local` cloudflared tunnel, that setup is retired.)

## This is a monorepo of two forks

Both the frontend and the scene-storage backend live in **this one repo**
(`Happy-Hoody/excalidraw`):

| Path | What | Tracks upstream |
|---|---|---|
| repo root (`excalidraw-app/`, `packages/`, `Dockerfile`, …) | the Excalidraw frontend | `excalidraw/excalidraw` via `git rebase upstream/master` |
| `storage-backend/` | NestJS scene-storage service (vendored fork of [`alswl/excalidraw-storage-backend`](https://github.com/alswl/excalidraw-storage-backend)) | vendored plain copy — re-vendor by hand if upstream ever matters |

`storage-backend/` is a plain vendored copy (no separate git history). Rebasing the
frontend on upstream never touches that folder, so the two coexist without conflicts.

### Our divergences from upstream excalidraw

All in `.env.production` (baked into the frontend image at Vite build time):

- `VITE_APP_WS_SERVER_URL=https://idraw.thehappyhoody.com` — live-collab websockets
  point at our self-hosted room server (path-routed `/socket.io`), not `oss-collab.excalidraw.com`.
- `VITE_APP_BACKEND_V2_GET_URL` / `VITE_APP_BACKEND_V2_POST_URL=https://idraw.thehappyhoody.com/api/v2/scenes/`
  — "Export → Shareable link" posts to our self-hosted storage backend (same origin,
  so no CORS), not the public `json.excalidraw.com`.

## Architecture

```
Browser → Cloudflare → ZT tunnel "HHoody-DOKS" → cloudflared pod → ingress-nginx → {
    /socket.io  → excalidraw-room    (:80)   — websocket collab relay
    /api/v2     → excalidraw-storage (:8080) — scene storage (Shareable links)
    /           → excalidraw-web     (:80)   — built nginx static frontend
}
                                   excalidraw-storage → excalidraw-redis (:6379, 1Gi PVC)
```

- ZT tunnel `HHoody-DOKS` UUID `fe26bbe8-af63-4c19-875d-4983aa7239d0`.
- TLS terminates at the Cloudflare edge. The DO Load Balancer exists but is bypassed
  by the tunnel.

## The two "share" features (they are different things)

1. **Live collaboration** — `Share → Start session`, makes a `#room=…` link. Handled
   by **excalidraw-room**. End-to-end encrypted; the room server only relays opaque
   blobs, nothing is stored. Two live participants sync directly; nothing to delete
   server-side if a URL is abused — just stop sharing it.
2. **Shareable link (read-only export)** — `Export → Shareable link`, makes a `#json=…`
   link. Handled by **excalidraw-storage** + **excalidraw-redis**. The encrypted scene
   is POSTed to `/api/v2/scenes`, stored in Redis, and fetched back on open. Scenes
   self-expire after **30 days** (`STORAGE_TTL`).
   - **Known limitation:** drawings with *embedded images* additionally call the public
     Excalidraw Firebase for the image files — those are **not** self-hosted, so images
     in shared links can fail. Plain drawings work. To self-host files too, route
     `/api/v2/files` to the same backend and disable the Firebase config.

## Cluster resources (namespace `excalidraw`)

| Resource | Image / detail |
|---|---|
| `deploy/excalidraw-web` (container `excalidraw`) | `ghcr.io/thejplbc/excalidraw:latest` |
| `deploy/excalidraw-room` | `excalidraw/excalidraw-room:sha-03ff435` (Docker Hub, pinned) |
| `deploy/excalidraw-storage` (container `storage`) | `ghcr.io/thejplbc/excalidraw-storage-backend:latest` |
| `deploy/excalidraw-redis` | `redis:7-alpine`, AOF on, 256MB cap + allkeys-lru, on `pvc/excalidraw-redis-data` (1Gi `do-block-storage`) |
| `ingress/excalidraw` | host `idraw.thehappyhoody.com`, paths above |

`excalidraw-storage` env: `STORAGE_URI=redis://excalidraw-redis:6379`,
`STORAGE_TTL=2592000000` (30 days, ms), `GLOBAL_PREFIX=/api/v2`, `PORT=8080`.
Images pull with the namespace's `ghcr-pull-secret`.

## Where things live

| Path | What |
|---|---|
| `~/projects/excalidraw/excalidraw-main/` | this repo (frontend at root, backend at `storage-backend/`) — build here |
| `~/projects/excalidraw/k8s/` | k8s manifests (`storage-backend.yaml`, `ingress.yaml`) — **mirror to oclaw `~/k8s-migration/` (source of truth)** |
| `~/.config/idraw-kube/config` | kubeconfig (see below) |
| oclaw `~/k8s-migration/` | canonical manifests + cloudflared for the whole DOKS cluster |

Builds happen on **2012giga** (`linux/amd64`, matching the cluster nodes). GHCR auth
persists in `~/.docker/config.json` — never `docker logout ghcr.io`.

## kubectl access

```bash
# Snap doctl can't write ~/.kube directly, so dump the kubeconfig to a path we own:
mkdir -p ~/.config/idraw-kube
doctl kubernetes cluster kubeconfig show f88f34ad-1f64-4ccf-a931-c56f297b5e72 > ~/.config/idraw-kube/config
export KUBECONFIG=~/.config/idraw-kube/config
kubectl -n excalidraw get pods
# (on a non-snap doctl, `doctl kubernetes cluster kubeconfig save <id>` works directly)
```

`kubectl` lives at `~/.local/bin/kubectl`. Context: `do-sfo2-hhoody-shared-cluster`.

## Deploy / upgrade

### Frontend
```bash
cd ~/projects/excalidraw/excalidraw-main
# pull upstream excalidraw changes (optional)
git fetch upstream && git rebase upstream/master   # keep our .env.production lines on conflict
docker build --platform linux/amd64 \
  -t ghcr.io/thejplbc/excalidraw:$(date +%F) -t ghcr.io/thejplbc/excalidraw:latest .
docker push ghcr.io/thejplbc/excalidraw:$(date +%F); docker push ghcr.io/thejplbc/excalidraw:latest
kubectl -n excalidraw set image deploy/excalidraw-web excalidraw=ghcr.io/thejplbc/excalidraw:$(date +%F)
kubectl -n excalidraw rollout status deploy/excalidraw-web
```
> The web deploy is `imagePullPolicy: IfNotPresent`, so always roll out by a **unique
> tag** (the `$(date +%F)`), not by re-pushing `:latest` — otherwise the node won't re-pull.

Verify the new bundle is live (the backend URL is in a code-split chunk, not index.html):
```bash
# find the chunk that holds the URL in your fresh build, then confirm it's served:
grep -rl 'api/v2/scenes' /usr/share/nginx/html  # inside the built image
```

### Storage backend
```bash
cd ~/projects/excalidraw/excalidraw-main/storage-backend
docker build --platform linux/amd64 \
  -t ghcr.io/thejplbc/excalidraw-storage-backend:$(date +%F) \
  -t ghcr.io/thejplbc/excalidraw-storage-backend:latest .
docker push ghcr.io/thejplbc/excalidraw-storage-backend:$(date +%F)
docker push ghcr.io/thejplbc/excalidraw-storage-backend:latest
kubectl -n excalidraw set image deploy/excalidraw-storage storage=ghcr.io/thejplbc/excalidraw-storage-backend:$(date +%F)
kubectl -n excalidraw rollout status deploy/excalidraw-storage
```

### Apply manifest changes (redis / storage / ingress)
```bash
kubectl apply -f ~/projects/excalidraw/k8s/storage-backend.yaml
kubectl apply -f ~/projects/excalidraw/k8s/ingress.yaml
# then mirror the edited file to oclaw ~/k8s-migration/ and commit it there
```

## Smoke tests

```bash
# app up
curl -sI https://idraw.thehappyhoody.com/ | head -1                       # 200
# live-collab room reachable
curl -s "https://idraw.thehappyhoody.com/socket.io/?EIO=4&transport=polling" | head -c 40   # {"sid":...}
# shareable-link backend round-trips
ID=$(curl -s -X POST https://idraw.thehappyhoody.com/api/v2/scenes/ \
      -H 'Content-Type: application/octet-stream' --data-binary 'probe' \
      | sed -n 's/.*"id":"\([0-9]*\)".*/\1/p')
curl -s https://idraw.thehappyhoody.com/api/v2/scenes/$ID   # echoes 'probe'
# redis TTL on stored scenes (~2592000s)
kubectl -n excalidraw exec deploy/excalidraw-redis -- sh -c 'redis-cli ttl "$(redis-cli --scan --pattern "SCENES:*" | head -1)"'
```

## Recovery

| Scenario | Recovery |
|---|---|
| A deployment crashed | `kubectl -n excalidraw rollout restart deploy/<name>` |
| Frontend / backend image bad | re-`set image` to the previous `:YYYY-MM-DD` tag (kept on GHCR) |
| Redis pod rescheduled | data survives on the PVC (AOF); shareable links persist |
| PVC lost | shareable links created before the loss are gone; new ones work once redis is back |
| Manifests lost on 2012giga | restore from oclaw `~/k8s-migration/`; the YAML in `~/projects/excalidraw/k8s/` is a working copy |
| Tunnel 502 | check the `cloudflared` deployment in the cluster and the `HHoody-DOKS` tunnel routes in Cloudflare ZT |
