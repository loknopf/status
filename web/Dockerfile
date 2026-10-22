# syntax=docker/dockerfile:1
# ghcr.io/loknopf/status-web: the static status page (plain HTML/CSS/JS, no server-side code),
# served read-only by static-web-server. Build context is the repo root.

# --- build: stamp the commit and publish endpoint metadata from the Gatus config -------------
# Runs on the build machine's platform; its output is plain files, so no emulation is needed.
FROM --platform=$BUILDPLATFORM mikefarah/yq:4.54.1@sha256:4b3d9475d65571d28cbb19544d3820ec2945e4c8b2f18279394282b8dc3a592e AS build
ARG GIT_SHA=dev
USER root
WORKDIR /build
COPY web/public/ public/
COPY web/endpoints.yq config/config.yaml ./

RUN yq -o=json -I=0 --from-file endpoints.yq config.yaml > public/endpoints.json

RUN short="$(printf '%.7s' "$GIT_SHA")" \
 && find public -name '*.html' -exec sed -i "s/__GIT_SHA_SHORT__/${short}/g; s/__GIT_SHA__/${GIT_SHA}/g" {} + \
 && chmod -R a+rX,go-w public

# --- runtime ---------------------------------------------------------------------------------
FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a

ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="loknopf-status-web" \
      org.opencontainers.image.description="Static status page for status.loknopf.dev" \
      org.opencontainers.image.source="https://github.com/loknopf/status" \
      org.opencontainers.image.revision="${GIT_SHA}"

COPY --from=build --chown=0:0 /build/public /public
COPY --chown=0:0 web/sws.toml /etc/sws.toml
ENV SERVER_CONFIG_FILE=/etc/sws.toml

USER 65534:65534
EXPOSE 8080
