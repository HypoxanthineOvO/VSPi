#!/bin/bash -p
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin
command="${SSH_ORIGINAL_COMMAND:-list}"
if [[ "$command" == list ]]; then
  exec /opt/vsp-feedback/node /opt/vsp-feedback/feedback-admin.mjs scan /var/lib/vsp-feedback/ready /var/lib/vsp-feedback-reader/state/cursor.json
elif [[ "$command" =~ ^show\ ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$ ]]; then
  exec /opt/vsp-feedback/node /opt/vsp-feedback/feedback-admin.mjs show /var/lib/vsp-feedback/ready "${BASH_REMATCH[1]}"
elif [[ "$command" =~ ^ack\ ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$ ]]; then
  exec /usr/bin/flock --nonblock /var/lib/vsp-feedback-reader/state/cursor.lock /opt/vsp-feedback/node /opt/vsp-feedback/feedback-admin.mjs ack /var/lib/vsp-feedback-reader/state/cursor.json "${BASH_REMATCH[1]}"
fi
printf 'Only list, show <feedback UUID>, and ack <feedback UUID> are permitted.\n' >&2
exit 2
