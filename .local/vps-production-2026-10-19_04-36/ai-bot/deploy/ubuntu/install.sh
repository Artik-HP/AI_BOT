#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'Usage: sudo bash deploy/ubuntu/install.sh [--update]\n'
  printf 'Installs a verified release. Does not start the bot or change Caddy/DNS/firewall.\n'
}
if [[ ${1:-} == --help ]]; then usage; exit 0; fi
mode=install
if [[ $# == 1 && $1 == --update ]]; then mode=update
elif [[ $# != 0 ]]; then usage; exit 1
fi
[[ $(uname -s) == Linux ]] || fail 'This installer requires Linux with systemd.'
[[ $EUID == 0 ]] || fail 'Run using sudo.'
[[ -f /etc/debian_version && -d /run/systemd/system ]] || fail 'Use an Ubuntu/Debian server booted with systemd.'
for command in systemctl systemd-analyze runuser useradd getent tar flock readlink; do
  command -v "$command" >/dev/null || fail "Missing command: $command"
done
[[ -x /usr/bin/node && -x /usr/bin/npm ]] || fail 'Install system-wide Node.js 24 LTS with /usr/bin/node and /usr/bin/npm first.'
/usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)) process.exit(1); const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(":memory:"); d.close();' || fail 'Node.js >=22.13 with node:sqlite is required.'

source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
/usr/bin/node "$source_root/scripts/package-vps.js" --verify
base=/opt/ai-bot
state=/var/lib/ai-bot
unit=/etc/systemd/system/ai-bot.service
exec 9>/run/lock/ai-bot-deploy.lock
flock -n 9 || fail 'Another deployment is in progress.'
for directory in "$base" "$base/releases" "$base/backups" "$state" "$state/config" /var/cache/ai-bot; do
  [[ ! -L $directory ]] || fail "Refusing symlink directory: $directory"
done
previous=''
if [[ $mode == update ]]; then
  [[ -f $base/.vps-layout-v1 && -L $base/current && -f $unit && -f $state/config/.env ]] || fail 'No managed installation found. Do not use --update for a legacy layout.'
  previous=$(readlink -f -- "$base/current")
  [[ $previous == "$base/releases/"* && -d $previous ]] || fail 'Current release is outside the managed releases directory.'
  active=$(systemctl show ai-bot.service --property=ActiveState --value)
  [[ $active == inactive || $active == failed ]] || fail 'Stop ai-bot.service before updating so its data can be backed up consistently.'
else
  [[ ! -e $unit && ! -L $unit && ! -e $base/current && ! -L $base/current && ! -e $base/index.js ]] || fail 'An installation already exists. Use the documented update or migration procedure.'
fi
if [[ -e $base/previous || -L $base/previous ]]; then
  [[ -L $base/previous ]] || fail 'The previous release path must be a symlink.'
fi

if ! id -u ai-bot >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$state" --shell /usr/sbin/nologin ai-bot
fi
[[ $(id -u ai-bot) != 0 ]] || fail 'ai-bot must be an unprivileged user.'
getent group ai-bot >/dev/null || fail 'Missing ai-bot group.'
install -d -m 0755 -o root -g root "$base" "$base/releases"
install -d -m 0700 -o root -g root "$base/backups"
install -d -m 0700 -o ai-bot -g ai-bot "$state" "$state/config" /var/cache/ai-bot
release_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
release="$base/releases/$release_id"
[[ ! -e $release ]] || fail 'Release directory already exists.'
if [[ $mode == update ]]; then
  backup="$base/backups/$release_id"
  install -d -m 0700 "$backup"
  tar -czf "$backup/state.tar.gz" -C "$state" .
  cp -- "$unit" "$backup/ai-bot.service"
  printf '%s\n' "$previous" > "$backup/previous-release.txt"
  printf 'Data and service backup: %s\n' "$backup"
fi
trap 'printf "Installation failed; the service has not been started. Inspect the error and the existing release/backup before retrying.\n" >&2' ERR
install -d -m 0755 -o ai-bot -g ai-bot "$release"
/usr/bin/node "$source_root/scripts/package-vps.js" --stage "$release"
chown -R ai-bot:ai-bot "$release"
runuser -u ai-bot -- env PATH=/usr/bin:/bin NODE_ENV=production /usr/bin/npm --prefix "$release" ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /var/cache/ai-bot
if [[ ! -e $state/config/.env ]]; then
  runuser -u ai-bot -- /usr/bin/node "$release/scripts/check-vps.js" --init "$state/config/.env"
fi
[[ ! -L $state/config/.env && -f $state/config/.env ]] || fail 'Config must be a regular file.'
if [[ $mode == update ]]; then
  runuser -u ai-bot -- /usr/bin/node "$release/scripts/check-vps.js" --env "$state/config/.env"
fi
install -m 0644 "$release/deploy/ubuntu/ai-bot.service.example" "$release/ai-bot.service"
systemd-analyze verify "$release/ai-bot.service"
chown -R root:root "$release"
chmod -R u=rwX,go=rX "$release"
if [[ -n $previous ]]; then
  ln -s -- "$previous" "$base/.previous-$release_id"
  mv -Tf -- "$base/.previous-$release_id" "$base/previous"
fi
ln -s -- "$release" "$base/.current-$release_id"
mv -Tf -- "$base/.current-$release_id" "$base/current"
install -m 0644 "$release/ai-bot.service" "$unit"
printf 'v1\n' > "$base/.vps-layout-v1"
systemctl daemon-reload
printf '\nRelease installed: %s\n' "$release"
printf 'Config: /var/lib/ai-bot/config/.env\n'
printf 'Next: follow deploy/ubuntu/README.md to configure, check and start the service.\n'
printf 'The bot is still stopped. Caddy, DNS and firewall settings were not changed.\n'
