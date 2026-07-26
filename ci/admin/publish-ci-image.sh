#!/usr/bin/env bash
set -euo pipefail

REGISTRY="${REGISTRY:-gitlab.vsplab.cn:5050}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-$REGISTRY/heyx/vspi/ci-node}"
IMAGE_VERSION="$(<ci/image/VERSION)"
IMAGE="$IMAGE_REPOSITORY:$IMAGE_VERSION"
PROJECT_PATH="${PROJECT_PATH:-heyx/vspi}"

command -v glab >/dev/null
command -v jq >/dev/null
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to publish a CI image from a dirty worktree." >&2
  exit 1
fi
PROJECT_ID="$(glab api "projects/${PROJECT_PATH//\//%2F}" | jq -er .id)"
REPOSITORY_ID="$(glab api "projects/$PROJECT_ID/registry/repositories" \
  | jq -r --arg path "$PROJECT_PATH/ci-node" '.[] | select(.path == $path) | .id' \
  | head -n 1)"
if [[ -n "$REPOSITORY_ID" ]] && glab api \
  "projects/$PROJECT_ID/registry/repositories/$REPOSITORY_ID/tags?per_page=100" \
  | jq -e --arg version "$IMAGE_VERSION" 'any(.[]; .name == $version)' >/dev/null; then
  echo "Refusing to overwrite existing image tag $IMAGE_VERSION." >&2
  exit 1
fi
TOKEN_NAME="vspi-ci-image-publish-$(date -u +%Y%m%dT%H%M%SZ)"
TOKEN_JSON="$(jq -n --arg name "$TOKEN_NAME" \
  '{name: $name, scopes: ["read_registry", "write_registry"]}' \
  | glab api --method POST --header 'Content-Type: application/json' --input - \
    "projects/$PROJECT_ID/deploy_tokens")"
TOKEN_ID="$(jq -er .id <<<"$TOKEN_JSON")"

cleanup() {
  docker logout "$REGISTRY" >/dev/null 2>&1 || true
  glab api --method DELETE "projects/$PROJECT_ID/deploy_tokens/$TOKEN_ID" >/dev/null 2>&1 || true
  unset TOKEN TOKEN_JSON
}
trap cleanup EXIT

TOKEN_USER="$(jq -er .username <<<"$TOKEN_JSON")"
TOKEN="$(jq -er .token <<<"$TOKEN_JSON")"

docker login --username "$TOKEN_USER" --password-stdin "$REGISTRY" <<<"$TOKEN"
docker build --pull \
  --build-arg "VCS_REF=$(git rev-parse HEAD)" \
  --tag "$IMAGE" \
  --file ci/image/Dockerfile .
docker push "$IMAGE"
docker buildx imagetools inspect "$IMAGE"
