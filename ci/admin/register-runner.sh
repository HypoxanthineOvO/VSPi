#!/usr/bin/env bash
set -euo pipefail

GITLAB_URL="${GITLAB_URL:-https://gitlab.vsplab.cn}"
PROJECT_PATH="${PROJECT_PATH:-heyx/vspi}"
RUNNER_DESCRIPTION="${RUNNER_DESCRIPTION:-vspi-docker}"
DEFAULT_IMAGE="node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"

command -v glab >/dev/null
command -v jq >/dev/null
PROJECT_ID="$(glab api "projects/${PROJECT_PATH//\//%2F}" | jq -er .id)"
RUNNER_JSON="$(glab api --method POST user/runners \
  --field runner_type=project_type \
  --field "project_id=$PROJECT_ID" \
  --field "description=$RUNNER_DESCRIPTION" \
  --field 'tag_list=vspi-docker' \
  --field run_untagged=false \
  --field locked=true)"
RUNNER_ID="$(jq -er .id <<<"$RUNNER_JSON")"
RUNNER_TOKEN="$(jq -er .token <<<"$RUNNER_JSON")"
REGISTERED=false

cleanup() {
  if [[ "$REGISTERED" != true ]]; then
    glab api --method DELETE "runners/$RUNNER_ID" >/dev/null 2>&1 || true
  fi
  unset RUNNER_TOKEN RUNNER_JSON
}
trap cleanup EXIT

sudo gitlab-runner register --non-interactive \
  --url "$GITLAB_URL" \
  --token "$RUNNER_TOKEN" \
  --executor docker \
  --docker-image "$DEFAULT_IMAGE" \
  --docker-pull-policy if-not-present \
  --docker-volumes /cache \
  --limit 2 \
  --description "$RUNNER_DESCRIPTION"

sudo systemctl restart gitlab-runner
REGISTERED=true
echo "Registered the $RUNNER_DESCRIPTION Docker runner for $PROJECT_PATH."
