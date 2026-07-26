#!/usr/bin/env bash
set -euo pipefail

GITLAB_HOST="${GITLAB_HOST:-gitlab.vsplab.cn}"
REGISTRY_PORT="${REGISTRY_PORT:-5050}"
GITLAB_RB="/etc/gitlab/gitlab.rb"
NGINX_SITE="/etc/nginx/sites-available/gitlab-registry"
NGINX_LINK="/etc/nginx/sites-enabled/gitlab-registry"
CERT="/etc/letsencrypt/live/$GITLAB_HOST/fullchain.pem"
KEY="/etc/letsencrypt/live/$GITLAB_HOST/privkey.pem"
BEGIN_MARKER="# BEGIN VSPI MANAGED REGISTRY"
END_MARKER="# END VSPI MANAGED REGISTRY"

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi
if [[ ! -r "$CERT" || ! -r "$KEY" ]]; then
  echo "Let's Encrypt certificate or key is missing: $CERT / $KEY" >&2
  exit 1
fi
if ! runuser -u git -- test -r /var/opt/gitlab/gitlab-rails/etc/gitlab.yml; then
  echo "The GitLab service user cannot read gitlab.yml; repair host ACLs before reconfigure." >&2
  exit 1
fi

UNMANAGED_CONFIG="$(sed "/$BEGIN_MARKER/,/$END_MARKER/d" "$GITLAB_RB")"
if grep -Eq '^[[:space:]]*registry_external_url[[:space:]]' <<<"$UNMANAGED_CONFIG"; then
  echo "An unmanaged registry_external_url already exists; refusing to override it." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp --preserve=all "$GITLAB_RB" "$GITLAB_RB.vspi.$STAMP.bak"
if [[ -e "$NGINX_SITE" ]]; then
  cp --preserve=all "$NGINX_SITE" "$NGINX_SITE.vspi.$STAMP.bak"
fi

sed -i "/$BEGIN_MARKER/,/$END_MARKER/d" "$GITLAB_RB"
cat >> "$GITLAB_RB" <<EOF

$BEGIN_MARKER
registry_external_url 'https://$GITLAB_HOST:$REGISTRY_PORT'
registry_nginx['enable'] = false
$END_MARKER
EOF

cat > "$NGINX_SITE" <<EOF
server {
    listen $REGISTRY_PORT ssl;
    listen [::]:$REGISTRY_PORT ssl;
    server_name $GITLAB_HOST;

    ssl_certificate $CERT;
    ssl_certificate_key $KEY;

    client_max_body_size 0;
    chunked_transfer_encoding on;

    location / {
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 900;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:5000;
    }
}
EOF
ln -sfn "$NGINX_SITE" "$NGINX_LINK"

nginx -t
gitlab-ctl reconfigure
systemctl reload nginx

HTTP_STATUS=000
for _ in {1..15}; do
  HTTP_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    "https://$GITLAB_HOST:$REGISTRY_PORT/v2/" || true)"
  if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "401" ]]; then
    break
  fi
  sleep 2
done
if [[ "$HTTP_STATUS" != "200" && "$HTTP_STATUS" != "401" ]]; then
  echo "Registry did not answer after configuration (HTTP $HTTP_STATUS)." >&2
  exit 1
fi
echo "Registry is available at https://$GITLAB_HOST:$REGISTRY_PORT"
