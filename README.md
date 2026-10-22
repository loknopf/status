# status.loknopf.dev

Status page for the services behind loknopf.dev. [Gatus](https://github.com/TwiN/gatus) runs the checks.
A static page (plain HTML, CSS and JS, no server-side rendering) shows the results.

```
                  ┌──────────── Traefik (status.loknopf.dev) ────────────┐
  browser ──────► │ /api/*  GET/HEAD ──► gatus:8080    (ghcr.io/loknopf/status)
                  │ everything else  ──► web:8080      (ghcr.io/loknopf/status-web)
                  └──────────────────────────────────────────────────────┘
```

- **`ghcr.io/loknopf/status`**: Gatus `v5.37.0` (pinned by tag and digest) with
  [`config/config.yaml`](config/config.yaml) baked in. Results are stored in sqlite at
  `/data/data.db`. Only `/api/*` is routed publicly, so Gatus' own UI is never exposed.
- **`ghcr.io/loknopf/status-web`**: the page in [`web/public`](web/public), served read-only by
  [static-web-server](https://static-web-server.net) with a strict CSP (`'self'` only, Trusted
  Types, no inline code, fonts self-hosted). The page polls
  `/api/v1/endpoints/statuses` every 60 s from the same origin, so no CORS is involved.

## What's monitored

All checks go through the public URLs, the same way a visitor would.

| Group          | Name          | Check                                         | Expects                                                                |
| -------------- | ------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| Public         | Portfolio     | `GET https://loknopf.dev`                     | `200`                                                                  |
| Public         | Excalidraw    | `GET https://excalidraw.loknopf.dev`          | `200`                                                                  |
| Services       | n8n           | `GET https://n8n.loknopf.dev/healthz`         | `200`, `status == ok`                                                  |
| Services       | Nextcloud     | `GET https://cloud.loknopf.dev/status.php`    | `200`, `installed == true`, `maintenance == false`, `needsDbUpgrade == false` |
| Services       | Grafana       | `GET https://grafana.loknopf.dev/api/health`  | `200`, `database == ok`                                                |
| Infrastructure | Reverse proxy | `GET` Traefik dashboard (hostname hidden)     | `401` (basic auth in front)                                            |
| Certificates   | 7 domains     | `tls://<domain>:443` every 5 min              | handshake OK, certificate valid > 7 days                               |

Every HTTP check also requires `[RESPONSE_TIME] < 1500` and `[CERTIFICATE_EXPIRATION] > 168h`.
HTTP checks run every 60 s.

The certificate group covers `loknopf.dev`, `status.`, `excalidraw.`, `n8n.`, `cloud.`, `grafana.`,
and the proxy. The page folds it into a single **TLS certificates** row under Infrastructure.
Because it has its own history, a certificate that's about to expire doesn't show up as downtime
of the service behind it.

The reverse proxy's hostname is not in this repo or the image. The config reads it from
`TRAEFIK_HOST`, which the server sets in a `.env` next to the compose file. `ui.hide-hostname` and
`ui.hide-url` keep it out of the API results and error messages, and therefore off the page.

## How the page reads the data

- **Current state** comes from each check's latest result. `operational` means it passed.
  `degraded` means only `[RESPONSE_TIME]` or `[CERTIFICATE_EXPIRATION]` failed: the service
  answers correctly, but it's slow or its certificate needs renewing. `down` means anything else
  failed.
- **Hero**: *All systems operational*, *Some systems degraded*, *Partial outage*, or *Major outage*
  (every check down).
- **90-day bars** are rebuilt from Gatus' events, which record every flip between passing and
  failing. Gatus keeps the newest 1000 per endpoint. On each day:
  - a finished failure shorter than 5 min shows as degraded, and a longer one as downtime;
  - an ongoing one shows as the current state;
  - days before monitoring started show as "no data".

  Hover a bar for the minutes. Uptime next to each service is the share of time not failing over
  the same window. The service page shows Gatus' own 24 h / 7 d / 30 d uptime instead.
- **Incident banner**: active `announcements` from the config (first line of the message is the
  headline). During an outage with no announcement, the page shows a neutral notice generated from
  the checks.
- **URLs and intervals** aren't exposed by the Gatus API. They're extracted from the config at build
  time into `/endpoints.json` ([`web/endpoints.yq`](web/endpoints.yq)), without the URLs of hidden
  endpoints.

## Common changes

- **Add or change a check**: edit `config/config.yaml` and push. The API key is
  `<group>_<name>`, lower case, with spaces and dots replaced by `-` (e.g. `services_n8n`).
- **Post an incident**: add an entry under `announcements:` (example in the config) and push. To
  close it, set `archived: true` or delete it.

## CI and deploy

Same pattern as the portfolio repo:

- **Build Docker Image** ([`docker_test_build.yml`](.github/workflows/docker_test_build.yml)) runs on
  every push. It builds both images and smoke-tests them, and publishes nothing.
- **Build and Push Docker Image** ([`docker_build.yml`](.github/workflows/docker_build.yml)) runs
  when a `v*` tag is pushed. Its single `build-and-push` job builds and smoke-tests both images,
  then publishes `linux/amd64` + `linux/arm64` images. The tags are `X.Y.Z`, `X.Y`, `X`, `latest`
  and the full commit sha.

The smoke test ([`.github/scripts/smoke.sh`](.github/scripts/smoke.sh)) starts each image the way
the server runs it: read-only, without capabilities, as a non-root user. It then checks the API,
the CSP header, the build stamp, and that the hidden hostname doesn't leak.

To release, tag and push:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

Dependabot keeps the pinned images and actions current, and stays on Gatus v5.

The server deploys separately with the same n8n workflow as the portfolio: a GitHub `workflow_job`
webhook → n8n → SSH forced command → `manage.sh pull`. A deploy happens once the release job has
finished. The server uses
[`deploy/docker-compose.status.yml`](deploy/docker-compose.status.yml). That file sets:

- read-only root filesystems, `cap_drop: ALL`, `no-new-privileges`, non-root user;
- memory, pids and CPU limits, and log rotation;
- its own `proxy-status` network;
- Traefik routers for both containers (the API router allows GET/HEAD only, with a rate limit).

It assumes Traefik's entrypoint is `websecure` and its certresolver is `letsencrypt`, and that
Traefik is attached to `proxy-status`. Next to the compose file, a `.env` must set
`TRAEFIK_HOST=<dashboard hostname>`; compose refuses to start without it. Set `STATUS_TAG=<sha>`
in the same file to pin or roll back.

## Local development

Run the real checks behind the same routing as production at <http://localhost:8080>. Export
`TRAEFIK_HOST` first, or the reverse-proxy check fails against a placeholder:

```bash
docker compose -f dev/compose.yml up --build
```

Preview any state with 90 days of made-up history at <http://127.0.0.1:8090>. Generate
`endpoints.json` once, then start the mock:

```bash
docker run --rm -v "$PWD":/w -w /w mikefarah/yq:4.54.1 -o=json -I=0 --from-file web/endpoints.yq config/config.yaml > web/public/endpoints.json
```

```bash
python3 dev/mock.py --state outage --announce
```

`--state` takes `operational`, `degraded` or `outage`.

## Layout

```
config/config.yaml              Gatus checks (the source of truth)
Dockerfile                      ghcr.io/loknopf/status
web/public/                     the page: index.html, service.html, assets/
web/endpoints.yq                config -> /endpoints.json at build time
web/sws.toml, web/Dockerfile    ghcr.io/loknopf/status-web
deploy/docker-compose.status.yml  what runs on the server
dev/                            local stack (compose + Traefik file config) and mock API
```

Geist and Geist Mono are © Vercel, under the SIL Open Font License
([`web/public/assets/fonts/OFL.txt`](web/public/assets/fonts/OFL.txt)).
