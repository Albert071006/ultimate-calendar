#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
node_bin=${1:-/usr/local/bin/node}; base='/opt/ultimate-calendar'; releases="$base/releases"; unit='/etc/systemd/system/ultimate-calendar.service'
[[ $EUID == 0 && $node_bin == /* && -x $node_bin && -f $base/.previous-release && ! -L $base/.previous-release && -f $base/.previous-unit && ! -L $base/.previous-unit ]] || { echo 'Require root, node and a recorded previous release/unit' >&2; exit 2; }
exec 9>"$base/.deploy.lock"; flock -n 9 || { echo 'Another deployment is running' >&2; exit 2; }
target=$(cat "$base/.previous-release"); current=$(realpath -e "$base/current")
[[ $target == /* && $(dirname "$target") == "$releases" && -d $target && ! -L $target && $(dirname "$current") == "$releases" && ! -e $base/.current-pending && ! -L $base/.current-pending && ! -e $base/.rollback-unit-pending && ! -L $base/.rollback-unit-pending ]] || { echo 'Invalid managed rollback paths' >&2; exit 2; }
"$node_bin" "$target/deploy/verify-release.mjs" "$target"; "$node_bin" "$current/deploy/verify-release.mjs" "$current"
install -o root -g root -m 0600 "$unit" "$base/.rollback-unit-pending"
stopped=0; switched=0
on_error() {
  local code=$?; trap - ERR
  if ((stopped)); then
    systemctl stop ultimate-calendar.service || true
    if ((switched)); then ln -s -- "$current" "$base/.current-pending"; mv -Tf -- "$base/.current-pending" "$base/current"; fi
    install -o root -g root -m 0644 "$base/.rollback-unit-pending" "$unit"; systemctl daemon-reload; systemctl start ultimate-calendar.service || true
  fi
  [[ -f $base/.rollback-unit-pending && ! -L $base/.rollback-unit-pending ]] && unlink "$base/.rollback-unit-pending"
  echo 'ROLLBACK_FAILED: attempted to restore previously running code/unit; data unchanged' >&2
  exit "$code"
}
trap on_error ERR
systemctl stop ultimate-calendar.service
stopped=1
runuser -u ultimate-calendar -- "$node_bin" "$current/dist-server/cli.mjs" backup --data-dir /var/lib/ultimate-calendar/data --backup-dir /var/lib/ultimate-calendar/backups
ln -s -- "$target" "$base/.current-pending"; mv -Tf -- "$base/.current-pending" "$base/current"
switched=1
install -o root -g root -m 0644 "$base/.previous-unit" "$unit"
systemctl daemon-reload
systemctl start ultimate-calendar.service
host=$("$node_bin" -e 'const rows=require("fs").readFileSync(process.argv[1],"utf8").split(/\r?\n/);const line=rows.find(v=>v.startsWith("CALENDAR_ORIGIN="));if(!line)process.exit(1);process.stdout.write(new URL(line.slice(16)).host)' /etc/ultimate-calendar/server.env)
healthy=0
for ((attempt=0; attempt<60; attempt++)); do if "$node_bin" "$target/deploy/check-health.mjs" --url http://127.0.0.1:3210/readyz --host "$host"; then healthy=1; break; fi; sleep 2; done
((healthy)) || { echo 'Rollback health failed' >&2; false; }
printf '%s\n' "$current" >"$base/.previous-release"; mv -Tf -- "$base/.rollback-unit-pending" "$base/.previous-unit"
trap - ERR
printf 'ROLLED_BACK %s\n' "$(basename "$target")"
