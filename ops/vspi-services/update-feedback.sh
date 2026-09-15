#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 && "$(hostname)" == eden ]] || { echo 'Run as administrator on Eden only.' >&2; exit 1; }
base="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
expected='__FEEDBACK_SHA256__'
previous='__PREVIOUS_SHA256__'
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$previous" =~ ^[a-f0-9]{64}$ ]] || { echo 'Prepare this template with verified artifact hashes first.' >&2; exit 1; }
target=/opt/vsp-feedback/feedback-server.mjs
[[ -f "$target" && ! -L "$target" && -x /opt/vsp-feedback/node ]] || exit 1
systemctl is-active --quiet vspi-feedback.service
printf '%s  %s\n' "$previous" "$target" | sha256sum --check -
backup="/var/backups/vspi-feedback/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 "$backup"
install -m 600 "$base/feedback-server.mjs" "$backup/candidate.mjs"
printf '%s  %s\n' "$expected" "$backup/candidate.mjs" | sha256sum --check -
/opt/vsp-feedback/node --check "$backup/candidate.mjs"
cp --preserve=mode,ownership,timestamps "$target" "$backup/previous.mjs"
rollback() {
  status=$?
  trap - ERR
  echo 'Feedback update failed; restoring the previous receiver.' >&2
  install -m 644 "$backup/previous.mjs" "$target.next"
  mv -f "$target.next" "$target"
  systemctl restart vspi-feedback.service
  exit "$status"
}
trap rollback ERR
install -m 644 "$backup/candidate.mjs" "$target.next"
mv -f "$target.next" "$target"
systemctl restart vspi-feedback.service
/opt/vsp-feedback/node --input-type=module <<'NODE'
let passed = false;
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:18761/api/feedback', {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json', 'x-feedback-action': 'register', 'x-feedback-consent': 'reviewed-v1' },
      body: JSON.stringify({ device: 'release-smoke', username: 'probe' }),
    });
    const result = await response.json();
    if (response.status === 201 && result.id === 'release-smoke-probe' && result.token?.startsWith('vspi1.')) { passed = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!passed) throw new Error('Automatic registration health check failed');
console.log('Automatic registration: OK (credential not printed).');
NODE
systemctl is-active --quiet vspi-feedback.service
trap - ERR
echo "Feedback receiver updated. Backup: $backup"
echo 'No per-user credential distribution is needed. Nginx, Hypo and stored feedback were not changed.'
