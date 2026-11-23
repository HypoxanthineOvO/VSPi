#!/bin/sh
set -eu

fail() {
    printf 'VSPi install: %s\n' "$*" >&2
    exit 1
}

check_host() {
    kernel=$(uname -s) || fail 'Cannot detect the operating system.'
    arch=$(uname -m) || fail 'Cannot detect the CPU architecture.'
    [ "$kernel" = Linux ] && [ "$arch" = x86_64 ] ||
        fail "This installer supports Linux x86_64; found $kernel $arch."

    node_version=$(node -p 'process.versions.node' 2>/dev/null) || node_version=unavailable
    if ! printf '%s\n' "$node_version" | awk -F. '
        NF == 3 && /^[0-9]+\.[0-9]+\.[0-9]+$/ &&
            ($1 > 22 || ($1 == 22 && $2 >= 19)) { supported = 1 }
        END { exit !supported }
    '; then
        printf 'VSPi requires Node.js >= 22.19.0 (current: %s).\n' "$node_version" >&2
        printf '%s\n' 'Install Node.js with fnm (fnm install 22 && fnm use 22) or nvm (nvm install 22 && nvm use 22), then rerun the installer.' >&2
        exit 1
    fi
    [ "$(node -p 'process.arch')" = x64 ] || fail 'Use a Linux x64 build of Node.js.'
}

fetch_asset() {
    curl -q -g -fsSL --connect-timeout 15 --max-time 300 \
        --proto '=http,https' --proto-redir "$redirect_protocols" \
        -o "$temp_dir/$1" -- "$dist_base/$1" || fail "Could not download $1."
}

verify_asset() {
    expected=$(LC_ALL=C awk '
        { sub(/\r$/, "") }
        NF == 2 && ($2 == "vspi-latest.tgz" || $2 == "*vspi-latest.tgz") { count++; hash = $1 }
        END {
            if (count != 1 || length(hash) != 64 || hash !~ /^[0-9a-fA-F]+$/) exit 1
            print tolower(hash)
        }
    ' "$temp_dir/SHA256SUMS") || fail 'SHA256SUMS must contain one valid SHA-256 entry for vspi-latest.tgz.'
    actual=$(sha256sum < "$temp_dir/vspi-latest.tgz") || fail 'Could not compute SHA-256.'
    [ "${actual%% *}" = "$expected" ] || fail 'SHA-256 mismatch; nothing was installed.'
}

can_write_dir() {
    dir=$1
    while [ ! -e "$dir" ] && [ ! -L "$dir" ]; do
        dir=$(dirname "$dir")
    done
    [ -d "$dir" ] && [ -w "$dir" ] && [ -x "$dir" ]
}

warn_running_daemon() {
    vspi_home=${VSPI_HOME-$HOME/.vspi}
    if node -e '
        const { readFileSync } = require("node:fs");
        let pid;
        try {
            pid = JSON.parse(readFileSync(process.argv[1], "utf8")).pid;
            if (!Number.isSafeInteger(pid) || pid <= 0) process.exit(1);
            process.kill(pid, 0);
        } catch (error) {
            process.exit(error.code === "EPERM" && pid > 0 ? 0 : 1);
        }
    ' "${vspi_home:-.}/server/runtime.json"; then
        printf '%s\n' 'A VSPi daemon appears to be running. Let its work finish, close old clients, then run vspi daemon stop before starting the new version.' >&2
    fi
}

main() {
    check_host
    for tool in curl sha256sum npm; do
        command -v "$tool" >/dev/null 2>&1 || fail "Required command not found: $tool."
    done
    [ -n "${HOME:-}" ] || fail 'HOME must be set.'

    dist_base=${VSPI_DIST_BASE:-https://github.com/HypoxanthineOvO/VSPi/releases/latest/download}
    while [ "${dist_base%/}" != "$dist_base" ]; do dist_base=${dist_base%/}; done
    case "$dist_base" in
        https://*) redirect_protocols='=https' ;;
        http://*) redirect_protocols='=http,https' ;;
        *) fail 'VSPI_DIST_BASE must be an HTTP or HTTPS base URL.' ;;
    esac
    temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/vspi-install.XXXXXXXX") || fail 'Could not create a temporary directory.'
    trap 'rm -f "$temp_dir/vspi-latest.tgz" "$temp_dir/SHA256SUMS"; rmdir "$temp_dir"' 0
    trap 'exit 1' HUP INT TERM
    fetch_asset vspi-latest.tgz
    fetch_asset SHA256SUMS
    verify_asset

    prefix=$(npm prefix --global) || fail 'Could not determine the npm global prefix.'
    npm_root=$(npm root --global) || fail 'Could not determine the npm global module directory.'
    case "$prefix" in /*) ;; *) fail 'npm did not return an absolute global prefix.' ;; esac
    case "$npm_root" in /*) ;; *) fail 'npm did not return an absolute global module directory.' ;; esac
    path_hint=false
    if ! can_write_dir "$npm_root" || ! can_write_dir "$prefix/bin"; then
        prefix=$HOME/.local
        path_hint=true
        printf 'The npm global directories are not writable; installing under %s.\n' "$prefix"
    fi

    warn_running_daemon
    npm install --global --prefix "$prefix" --ignore-scripts --no-audit --no-fund "$temp_dir/vspi-latest.tgz" ||
        fail 'npm installation failed.'
    installed=$prefix/bin/vspi
    "$installed" --version || fail 'The installed vspi --version command failed.'
    if [ "$path_hint" = true ] || [ "$(command -v vspi || :)" != "$installed" ]; then
        printf 'Put %s/bin first in PATH in your current shell and shell startup file:\n' "$prefix"
        escaped_prefix=$(printf '%s\n' "$prefix" | sed "s/'/'\\\\''/g")
        printf "  export PATH='%s/bin':\"\$PATH\"\n" "$escaped_prefix"
    fi
    printf '%s\n' 'Run vspi to get started.'
}

main "$@"
