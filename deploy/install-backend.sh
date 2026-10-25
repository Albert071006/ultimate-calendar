#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Ubuntu backend-only installer. Review before running as root on the target host.
bundle='' expected='' origin='' node_bin='/usr/local/bin/node'
while (($#)); do
  (($# >= 2)) || { echo 'Missing argument' >&2; exit 2; }
  case "$1" in
    --bundle) bundle=$2;; --sha256) expected=$2;; --origin) origin=$2;; --node-bin) node_bin=$2;;
    *) echo 'Unknown argument' >&2; exit 2;;
  esac; shift 2
done
[[ $EUID == 0 && $bundle == /* && -f $bundle && ! -L $bundle && $expected =~ ^[a-f0-9]{64}$ && $node_bin == /* && $node_bin =~ ^[A-Za-z0-9/_+.-]+$ && -x $node_bin ]] || { echo 'Require root, regular absolute bundle, SHA256 and absolute node executable' >&2; exit 2; }
[[ $(sha256sum -- "$bundle" | cut -d' ' -f1) == "$expected" ]] || { echo 'Archive SHA256 mismatch' >&2; exit 2; }
"$node_bin" -e 'if(process.versions.node.split(".")[0]!=="24")process.exit(1)' || { echo 'Node.js 24 is required' >&2; exit 2; }
host=$("$node_bin" -e 'const u=new URL(process.argv[1]);if(u.origin!==process.argv[1]||u.username||u.password||!(u.protocol==="https:"||process.argv[1]==="http://127.0.0.1:3210"))process.exit(1);process.stdout.write(u.host)' "$origin") || { echo 'Require canonical HTTPS origin (only http://127.0.0.1:3210 allowed for bootstrap)' >&2; exit 2; }
for command in tar realpath flock runuser systemctl install getent useradd; do command -v "$command" >/dev/null; done
base='/opt/ultimate-calendar'; releases="$base/releases"; config='/etc/ultimate-calendar'; data='/var/lib/ultimate-calendar/data'; backups='/var/lib/ultimate-calendar/backups'; unit='/etc/systemd/system/ultimate-calendar.service'
[[ ! -L $base && ! -L $releases && ! -L $config && ! -L /var/lib/ultimate-calendar ]] || { echo 'Managed paths cannot be links' >&2; exit 2; }
install -d -o root -g root -m 0755 "$base" "$releases"
exec 9>"$base/.deploy.lock"; flock -n 9 || { echo 'Another deployment is running' >&2; exit 2; }
stage=$(mktemp -d "$base/.install-XXXXXXXX")
cleanup() {
  local actual
  if [[ -n ${stage:-} && -d $stage && ! -L $stage ]]; then
    actual=$(realpath -e -- "$stage")
    [[ $(dirname -- "$actual") == "$base" && $(basename -- "$actual") == .install-* ]] || { echo 'Refuse unsafe staging cleanup' >&2; return 1; }
    rm -rf -- "$actual"
  fi
}
trap cleanup EXIT
mapfile -t paths < <(tar -tzf "$bundle")
((${#paths[@]} > 0 && ${#paths[@]} < 100)) || { echo 'Unexpected archive entries' >&2; exit 2; }
release=${paths[0]%%/*}
[[ $release =~ ^backend-[0-9A-Za-z._-]+$ ]] || { echo 'Invalid release name' >&2; exit 2; }
for path in "${paths[@]}"; do
  [[ $path == "$release/"* && $path != *'..'* && $path != *'//'* && $path =~ ^[A-Za-z0-9._/-]+$ ]] || { echo 'Unsafe archive path' >&2; exit 2; }
done
# Regular files and directories only; never extract links, devices or special entries.
tar -tvzf "$bundle" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' || { echo 'Archive links/special files forbidden' >&2; exit 2; }
tar -xzf "$bundle" --no-same-owner --no-same-permissions -C "$stage"
incoming="$stage/$release"; "$node_bin" "$incoming/deploy/verify-release.mjs" "$incoming"
[[ $("$node_bin" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).releaseId' "$incoming/release-manifest.json") == "$release" ]] || { echo 'Release identity mismatch' >&2; exit 2; }
previous=''
if [[ -e $base/current || -L $base/current ]]; then
  [[ -L $base/current ]] || { echo 'Refuse unmanaged current directory' >&2; exit 2; }
  previous=$(realpath -e "$base/current")
  [[ $(dirname "$previous") == "$releases" && -f $previous/release-manifest.json ]] || { echo 'Refuse unmanaged previous release' >&2; exit 2; }
  "$node_bin" "$previous/deploy/verify-release.mjs" "$previous"
elif [[ -e $unit ]]; then echo 'Existing unmanaged service unit: review manually first' >&2; exit 2
fi
if getent passwd ultimate-calendar >/dev/null; then
  [[ $(id -u ultimate-calendar) != 0 && $(id -g ultimate-calendar) != 0 ]] || { echo 'Service identity cannot be root' >&2; exit 2; }
else useradd --system --user-group --home-dir /var/lib/ultimate-calendar --shell /usr/sbin/nologin ultimate-calendar
fi
install -d -o root -g root -m 0700 "$config"
if [[ -e $config/server.env || -L $config/server.env ]]; then
  [[ -f $config/server.env && ! -L $config/server.env && $(stat -c '%u:%a:%h' "$config/server.env") == '0:600:1' ]] || { echo 'Existing server.env must be root-owned regular 0600' >&2; exit 2; }
  [[ $(sed -n 's/^CALENDAR_ORIGIN=//p' "$config/server.env") == "$origin" ]] || { echo 'Existing origin differs; do not overwrite configuration' >&2; exit 2; }
else printf 'CALENDAR_ORIGIN=%s\n' "$origin" >"$config/server.env"; chmod 0600 "$config/server.env"
fi
if [[ -e $config/secrets.env || -L $config/secrets.env ]]; then
  [[ -f $config/secrets.env && ! -L $config/secrets.env && $(stat -c '%u:%a:%h' "$config/secrets.env") == '0:600:1' ]] || { echo 'secrets.env must be root-owned regular 0600' >&2; exit 2; }
fi
install -d -o ultimate-calendar -g ultimate-calendar -m 0700 /var/lib/ultimate-calendar "$data" "$backups"
old_stopped=0; switched=0
on_error() {
  local code=$?; trap - ERR
  if ((switched)); then
    systemctl stop ultimate-calendar.service || true
    if [[ -n $previous ]]; then
      switch_current "$previous"; install -o root -g root -m 0644 "$stage/previous.service" "$unit"; systemctl daemon-reload; systemctl start ultimate-calendar.service || true
    else
      [[ -L $base/current && $(realpath -e "$base/current") == "$destination" ]] && unlink "$base/current"
      systemctl disable ultimate-calendar.service || true
    fi
  elif ((old_stopped)); then systemctl start ultimate-calendar.service || true
  fi
  echo 'DEPLOY_FAILED: code switch reverted where possible; persistent data retained' >&2
  exit "$code"
}
trap on_error ERR
if [[ -n $previous ]]; then
  cp -- "$unit" "$stage/previous.service"
  systemctl stop ultimate-calendar.service
  old_stopped=1
  runuser -u ultimate-calendar -- "$node_bin" "$previous/dist-server/cli.mjs" backup --data-dir "$data" --backup-dir "$backups"
fi
destination="$releases/$release"
if [[ -e $destination || -L $destination ]]; then
  [[ -d $destination && ! -L $destination ]] || { echo 'Invalid existing release path' >&2; exit 2; }
  "$node_bin" "$destination/deploy/verify-release.mjs" "$destination"
  cmp "$incoming/release-manifest.json" "$destination/release-manifest.json" || { echo 'Existing release differs' >&2; exit 2; }
else
  find "$incoming" -type d -exec chmod 0755 {} +; find "$incoming" -type f -exec chmod 0644 {} +
  mv -- "$incoming" "$destination"
fi
switch_current() { ln -s -- "$1" "$base/.current-pending"; mv -Tf -- "$base/.current-pending" "$base/current"; }
[[ ! -e $base/.current-pending && ! -L $base/.current-pending ]] || { echo 'Pending switch exists; inspect before retry' >&2; exit 2; }
switch_current "$destination"
switched=1
sed "s|^ExecStart=/usr/local/bin/node |ExecStart=$node_bin |" "$destination/deploy/ultimate-calendar.service" >"$stage/new.service"
install -o root -g root -m 0644 "$stage/new.service" "$unit"
systemctl daemon-reload
healthy=0
if systemctl start ultimate-calendar.service; then
  for ((attempt=0; attempt<60; attempt++)); do
    if "$node_bin" "$destination/deploy/check-health.mjs" --url http://127.0.0.1:3210/readyz --host "$host"; then healthy=1; break; fi
    sleep 2
  done
fi
if ((healthy)); then
  if [[ -n $previous && $previous != "$destination" ]]; then printf '%s\n' "$previous" >"$base/.previous-release"; install -o root -g root -m 0600 "$stage/previous.service" "$base/.previous-unit"; fi
  systemctl enable ultimate-calendar.service
  trap - ERR
  printf 'DEPLOYED %s\n' "$release"
else
  trap - ERR
  systemctl stop ultimate-calendar.service || true
  if [[ -n $previous ]]; then
    switch_current "$previous"; install -o root -g root -m 0644 "$stage/previous.service" "$unit"; systemctl daemon-reload; systemctl start ultimate-calendar.service
    echo 'HEALTH_FAILED: previous code/unit restored; persistent data retained' >&2
  else
    [[ -L $base/current && $(realpath -e "$base/current") == "$destination" ]] && unlink "$base/current"
    echo 'HEALTH_FAILED: initial service stopped; persistent data retained for inspection' >&2
  fi
  exit 1
fi
