#!/usr/bin/env bash
set -euo pipefail
umask 077
base="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
action="${1:-preflight}"
[[ $EUID -eq 0 ]] || { echo 'Run the reviewed script with sudo.' >&2; exit 1; }
[[ "$(hostname -s)" == "__EDEN_HOSTNAME__" ]] || { echo 'Wrong host; refusing changes.' >&2; exit 1; }
node_bin="${VSPI_NODE_BINARY:-/usr/bin/node}"
preflight() {
  for cmd in nginx systemctl flock sha256sum install getent; do command -v "$cmd" >/dev/null; done
  "$node_bin" -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&(b<19||(b===19&&c<0))))process.exit(1)'
  (cd "$base"; sha256sum --check SHA256SUMS)
  test -f /etc/vsp-feedback/tls/fullchain.pem
  test -f /etc/vsp-feedback/tls/privkey.pem
  for path in /opt/vsp-feedback /srv/vsp-downloads /etc/vsp-feedback /var/lib/vsp-feedback /var/lib/vsp-feedback/staging /var/lib/vsp-feedback/ready; do test ! -L "$path"; done
  test ! -L /etc/vsp-feedback/server.json
  echo 'Preflight passed. Existing Nginx sites will be preserved.'
}
case "$action" in
  preflight) preflight ;;
  install)
    preflight
    backup="/var/backups/vspi-services/$(date -u +%Y%m%dT%H%M%SZ)-$$"
    install -d -m 700 "$backup"
    for path in /etc/nginx/sites-available/vspi-distribution /etc/systemd/system/vspi-feedback.service /opt/vsp-feedback/feedback-server.mjs /opt/vsp-feedback/feedback-admin.mjs /opt/vsp-feedback/distribution-admin.mjs /usr/local/sbin/vspi-feedback-readonly /opt/vsp-feedback/node; do
      if [[ -L "$path" ]]; then echo "Refusing symlink: $path" >&2; exit 1; fi
      if [[ -e "$path" ]]; then cp --preserve=all "$path" "$backup/$(basename "$path")"; fi
    done
    getent group vspi-feedback >/dev/null || groupadd --system vspi-feedback
    getent group vspi-feedback-read >/dev/null || groupadd --system vspi-feedback-read
    id vspi-feedback >/dev/null 2>&1 || useradd --system --gid vspi-feedback --groups vspi-feedback-read --home-dir /var/lib/vsp-feedback --shell /usr/sbin/nologin vspi-feedback
    install -d -m 755 /opt/vsp-feedback /srv/vsp-downloads
    install -d -m 750 -o root -g vspi-feedback /etc/vsp-feedback
    install -d -m 2750 -o vspi-feedback -g vspi-feedback-read /var/lib/vsp-feedback
    install -d -m 2700 -o vspi-feedback -g vspi-feedback-read /var/lib/vsp-feedback/staging
    install -d -m 2750 -o vspi-feedback -g vspi-feedback-read /var/lib/vsp-feedback/ready
    next="/opt/vsp-feedback/.node.$$.next"
    test ! -e "$next"; test ! -L "$next"
    install -m 755 "$node_bin" "$next"
    mv -f "$next" /opt/vsp-feedback/node
    install -m 644 "$base/feedback-server.mjs" /opt/vsp-feedback/feedback-server.mjs
    install -m 644 "$base/feedback-admin.mjs" /opt/vsp-feedback/feedback-admin.mjs
    install -m 644 "$base/distribution-admin.mjs" /opt/vsp-feedback/distribution-admin.mjs
    install -m 755 "$base/hermes-readonly.sh" /usr/local/sbin/vspi-feedback-readonly
    install -m 644 "$base/vspi-feedback.service" /etc/systemd/system/vspi-feedback.service
    install -m 644 "$base/eden.nginx.conf" /etc/nginx/sites-available/vspi-distribution
    if [[ ! -e /etc/nginx/sites-enabled/vspi-distribution && ! -L /etc/nginx/sites-enabled/vspi-distribution ]]; then
      ln -s /etc/nginx/sites-available/vspi-distribution /etc/nginx/sites-enabled/vspi-distribution
      touch "$backup/created-site-link"
    elif [[ "$(readlink -f /etc/nginx/sites-enabled/vspi-distribution)" != /etc/nginx/sites-available/vspi-distribution ]]; then echo 'Existing site link conflicts; stop and inspect.' >&2; exit 1; fi
    if [[ ! -e /etc/vsp-feedback/server.json ]]; then install -m 640 -o root -g vspi-feedback "$base/server.example.json" /etc/vsp-feedback/server.json; fi
    chown root:vspi-feedback /etc/vsp-feedback/server.json
    chmod 640 /etc/vsp-feedback/server.json
    nginx -t
    echo "Installed but not activated. Backup: $backup"
    echo 'Run this script with activate. Device-user submission credentials are issued automatically.'
    ;;
  activate)
    preflight
    test -s /etc/vsp-feedback/server.json
    /opt/vsp-feedback/node -e 'const c=require(process.argv[1]);if(!c.submitters?.length||c.submitters.some(s=>s.token?.length<32))process.exit(1)' /etc/vsp-feedback/server.json
    nginx -t
    systemctl daemon-reload
    systemctl enable vspi-feedback.service
    if systemctl is-active --quiet vspi-feedback.service; then systemctl restart vspi-feedback.service; else systemctl start vspi-feedback.service; fi
    systemctl reload nginx
    systemctl is-active vspi-feedback.service
    ;;
  authorize-reader)
    key="${2:?Provide a dedicated SSH public-key file, never a private key}"
    test -f "$key"; test ! -L "$key"
    [[ $(wc -c < "$key") -le 4096 && $(grep -c '^ssh-ed25519 ' "$key") -eq 1 && $(grep -c . "$key") -eq 1 ]] || { echo 'Expected exactly one Ed25519 public key.' >&2; exit 1; }
    ssh-keygen -l -f "$key" >/dev/null
    getent group vspi-feedback-read >/dev/null
    id vspi-feedback-reader >/dev/null 2>&1 || useradd --system --gid vspi-feedback-read --home-dir /var/lib/vsp-feedback-reader --shell /bin/sh vspi-feedback-reader
    [[ "$(getent passwd vspi-feedback-reader | cut -d: -f6)" == /var/lib/vsp-feedback-reader ]] || exit 1
    [[ "$(id -nG vspi-feedback-reader)" == vspi-feedback-read ]] || { echo 'Reader account has unexpected groups; review it before authorizing a key.' >&2; exit 1; }
    usermod --lock vspi-feedback-reader
    install -d -m 755 -o root -g root /var/lib/vsp-feedback-reader /var/lib/vsp-feedback-reader/.ssh
    install -d -m 700 -o vspi-feedback-reader -g vspi-feedback-read /var/lib/vsp-feedback-reader/state
    keys=/var/lib/vsp-feedback-reader/.ssh/authorized_keys
    test ! -L "$keys"
    touch "$keys"; chown root:root "$keys"; chmod 644 "$keys"
    line="restrict,command=\"/usr/local/sbin/vspi-feedback-readonly\" $(cat "$key")"
    grep -Fxq "$line" "$keys" || printf '%s\n' "$line" >> "$keys"
    echo 'Reader key installed. Only list/show/ack are permitted; feedback remains read-only, only the isolated receipt cursor is writable.'
    ;;
  rollback)
    backup="${2:?Provide the exact backup directory printed by install}"
    [[ "$backup" =~ ^/var/backups/vspi-services/[0-9]{8}T[0-9]{6}Z-[0-9]+$ && -d "$backup" && ! -L "$backup" ]] || exit 1
    systemctl stop vspi-feedback.service || true
    for path in /etc/nginx/sites-available/vspi-distribution /etc/systemd/system/vspi-feedback.service /opt/vsp-feedback/feedback-server.mjs /opt/vsp-feedback/feedback-admin.mjs /opt/vsp-feedback/distribution-admin.mjs /usr/local/sbin/vspi-feedback-readonly /opt/vsp-feedback/node; do
      name="$(basename "$path")"
      if [[ -f "$backup/$name" ]]; then cp --preserve=all "$backup/$name" "$path"; else rm -f -- "$path"; fi
    done
    if [[ -f "$backup/created-site-link" ]]; then rm -f /etc/nginx/sites-enabled/vspi-distribution; fi
    nginx -t
    systemctl daemon-reload
    systemctl reload nginx
    echo 'Configuration restored. Feedback data, accounts and credentials preserved. Review before starting any restored receiver.'
    ;;
  *) echo 'Usage: eden-admin.sh preflight|install|activate|authorize-reader <public-key>|rollback <backup-directory>' >&2; exit 2 ;;
esac
