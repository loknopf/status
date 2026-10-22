# syntax=docker/dockerfile:1
# ghcr.io/loknopf/status: Gatus with this repo's config baked in.
# Only its /api/* routes are exposed publicly (see deploy/docker-compose.status.yml).

FROM ghcr.io/twin/gatus:v5.37.0@sha256:094eb186e55235db367e90e9d56140e5897b7044c41de23cde4cc18e6da1242e

ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="loknopf-status" \
      org.opencontainers.image.description="Gatus checks behind status.loknopf.dev" \
      org.opencontainers.image.source="https://github.com/loknopf/status" \
      org.opencontainers.image.revision="${GIT_SHA}"

COPY --chown=0:0 config/config.yaml /config/config.yaml
ENV GATUS_CONFIG_PATH=/config/config.yaml

USER 65534:65534
# Created as 65534 because it comes after USER: a fresh named volume mounted at /data inherits
# that ownership, so Gatus keeps its sqlite database without running as root.
WORKDIR /data
EXPOSE 8080
