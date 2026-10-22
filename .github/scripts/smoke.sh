#!/usr/bin/env bash
# Start an image the way the server runs it (read-only, no capabilities, non-root) and check it.
#   .github/scripts/smoke.sh status <image>
#   .github/scripts/smoke.sh status-web <image>
# The web check expects GITHUB_SHA (set in Actions) to be the commit the image was built from.
set -euo pipefail

kind=$1
image=$2
name="smoke-$kind"
base=http://127.0.0.1:18080

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "smoke test failed: $kind ($image); container logs:"
    docker logs "$name" 2>&1 | tail -n 40 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

case "$kind" in
  status)
    docker run -d --name "$name" -p 127.0.0.1:18080:8080 -e TRAEFIK_HOST=proxy.invalid \
      --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --tmpfs /tmp:size=16m,mode=1777 --mount type=volume,dst=/data \
      "$image" >/dev/null
    # The API answers right away but lists endpoints only once they have a result; wait until
    # both checks of the hidden proxy have run.
    proxy='[.[] | select(.key | endswith("reverse-proxy")) | select(.results | length > 0)] | length == 2'
    body=
    for _ in $(seq 1 60); do
      body=$(curl -fsS "$base/api/v1/endpoints/statuses" || true)
      if jq -e "$proxy" <<<"$body" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    test "$(docker inspect -f '{{.State.Running}}' "$name")" = true
    jq -e "$proxy" <<<"$body" >/dev/null
    if grep -q 'proxy\.invalid' <<<"$body"; then echo "hidden hostname leaked through the API"; exit 1; fi
    ;;

  status-web)
    docker run -d --name "$name" -p 127.0.0.1:18080:8080 \
      --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      "$image" >/dev/null
    for _ in $(seq 1 15); do curl -fsS -o /dev/null "$base/" && break; sleep 1; done
    page=$(curl -fsS "$base/")
    headers=$(curl -fsSI "$base/")
    meta=$(curl -fsS "$base/endpoints.json")
    grep -q "${GITHUB_SHA::7}" <<<"$page"
    grep -qi '^content-security-policy:' <<<"$headers"
    jq -e 'length > 0' <<<"$meta" >/dev/null
    if grep -q 'TRAEFIK_HOST' <<<"$meta"; then echo "hidden endpoint URL published"; exit 1; fi
    test "$(curl -s -o /dev/null -w '%{http_code}' "$base/nope")" = 404
    ;;

  *)
    echo "unknown image kind: $kind" >&2
    exit 2
    ;;
esac

echo "smoke test passed: $kind ($image)"
