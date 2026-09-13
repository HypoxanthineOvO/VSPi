#!/usr/bin/env bash
set -euo pipefail
umask 077
base="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
action="${1:-preflight}"
[[ $EUID -eq 0 ]] || { echo 'Run the reviewed script with sudo.' >&2; exit 1; }
[[ "$(hostname -s)" == "__PUBLIC_HOSTNAME__" ]] || { echo 'Wrong host; refusing changes.' >&2; exit 1; }
config='__CADDY_CONFIG__'
service='__CADDY_SERVICE__'
pid="$(systemctl show "$service" --property MainPID --value || true)"
caddy="${CADDY_BINARY:-}"
if [[ -z "$caddy" && "$pid" =~ ^[1-9][0-9]*$ ]]; then caddy="$(readlink -f "/proc/$pid/exe" || true)"; fi
if [[ -z "$caddy" && "$action" == rollback && "${2:-}" =~ ^/var/backups/vspi-services/[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]; then
  caddy="$(cat "$2/caddy-binary.path" 2>/dev/null || true)"
fi
preflight() {
  test -x "$caddy"; test -f "$config"; test ! -L "$config"
  test ! -L /etc/vspi-services; test ! -L /etc/vspi-services/hypo.Caddyfile
  (cd "$base"; sha256sum --check SHA256SUMS)
  "$caddy" validate --config "$config" --adapter caddyfile
  echo 'Existing Caddy configuration is valid. No new listening port is allocated.'
}
case "$action" in
  preflight) preflight ;;
  install)
    preflight
    backup="/var/backups/vspi-services/$(date -u +%Y%m%dT%H%M%SZ)-$$"
    install -d -m 700 "$backup"
    cp --preserve=all "$config" "$backup/Caddyfile"
    printf '%s\n' "$caddy" > "$backup/caddy-binary.path"
    if [[ -e /etc/vspi-services/hypo.Caddyfile ]]; then cp --preserve=all /etc/vspi-services/hypo.Caddyfile "$backup/hypo.Caddyfile"; fi
    install -d -m 755 /etc/vspi-services
    install -m 644 "$base/hypo.Caddyfile" /etc/vspi-services/hypo.Caddyfile
    candidate="$backup/candidate.Caddyfile"
    cp --preserve=all "$config" "$candidate"
    grep -Fxq 'import /etc/vspi-services/hypo.Caddyfile' "$candidate" || printf '\nimport /etc/vspi-services/hypo.Caddyfile\n' >> "$candidate"
    if ! "$caddy" validate --config "$candidate" --adapter caddyfile; then
      if [[ -f "$backup/hypo.Caddyfile" ]]; then cp --preserve=all "$backup/hypo.Caddyfile" /etc/vspi-services/hypo.Caddyfile; else rm -f /etc/vspi-services/hypo.Caddyfile; fi
      exit 1
    fi
    cp --preserve=all "$candidate" "$config"
    echo "Installed but not activated. Backup: $backup"
    echo 'Run activate-reload if supported, or explicitly choose activate-restart (briefly interrupts the existing Caddy service).'
    ;;
  activate-reload) preflight; systemctl reload "$service" ;;
  activate-restart) preflight; systemctl restart "$service" ;;
  rollback)
    backup="${2:?Provide the exact backup directory printed by install}"
    [[ "$backup" =~ ^/var/backups/vspi-services/[0-9]{8}T[0-9]{6}Z-[0-9]+$ && -f "$backup/Caddyfile" && ! -L "$backup" ]] || exit 1
    cp --preserve=all "$backup/Caddyfile" "$config"
    if [[ -f "$backup/hypo.Caddyfile" ]]; then cp --preserve=all "$backup/hypo.Caddyfile" /etc/vspi-services/hypo.Caddyfile; else rm -f /etc/vspi-services/hypo.Caddyfile; fi
    "$caddy" validate --config "$config" --adapter caddyfile
    echo 'Configuration restored, not activated. Choose activate-reload or activate-restart explicitly.'
    ;;
  *) echo 'Usage: hypo-admin.sh preflight|install|activate-reload|activate-restart|rollback <backup-directory>' >&2; exit 2 ;;
esac
