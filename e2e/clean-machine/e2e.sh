#!/usr/bin/env bash
# Clean-machine end-to-end test of rn-xtool inside a throwaway Ubuntu container.
#
# The container shares the host network (to reach the iPhone over Wi‑Fi and serve Metro); the xtool
# AppImage runs extracted (no FUSE in Docker). Everything else is a fresh home directory on a Docker volume.
#
#   e2e.sh up                      build the image, start the container
#   e2e.sh install [<npm spec>]    install react-native-xtool (default: github:WillyAntunez/react-native-xtool)
#   e2e.sh setup                   rn-xtool setup --xcode-xip (the slow part: Swift, xtool, Darwin SDK)
#   e2e.sh auth                    copy the host's xtool login and the iPhone pair record into the container
#   e2e.sh project [--sdk <n>] [<name>]
#                                  npx create-expo-app <name> (default: demo); --sdk <n> picks the Expo SDK (blank-typescript@sdk-<n>), not with --bare
#   e2e.sh project --bare [<name>] [--rn <version>]
#                                  bare React Native app (default 0.88.0) via @react-native-community/cli init, without pod install (default name: demo)
#   e2e.sh sh [<cmd...>]           run a command (or a shell) as the test user, in the project dir if it exists
#   e2e.sh down                    remove the container and its home volume
#
# Environment: XCODE_XIP (default ~/Downloads/Xcode_27.1.xip), E2E_NAME (default rn-xtool-e2e),
# E2E_UDID (pair record to copy; default: every record in ~/.cache/rn-xtool/pair-records).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${E2E_NAME:-rn-xtool-e2e}"
IMAGE="$NAME:ubuntu-24.04"
VOLUME="$NAME-home"
XIP="${XCODE_XIP:-$HOME/Downloads/Xcode_27.1.xip}"
PROJECT_FILE="$HOME/.cache/$NAME.project"

as_user() { docker exec -i -u me -e HOME=/home/me -w "${1}" "$NAME" bash -lc "${2}"; }

cmd_up() {
  [ -f "$XIP" ] || { echo "Xcode xip not found: $XIP (set XCODE_XIP)"; exit 1; }
  docker build -t "$IMAGE" "$HERE"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume create "$VOLUME" >/dev/null
  docker run -d --name "$NAME" \
    --network host \
    -v "$VOLUME:/home/me" \
    -v "$XIP:/xcode/$(basename "$XIP"):ro" \
    "$IMAGE" >/dev/null
  # A fresh volume is owned by root; hand it to the test user.
  docker exec -u root "$NAME" chown me:me /home/me
  echo "container $NAME up (home volume: $VOLUME)"
}

cmd_install() {
  local spec="${1:-github:WillyAntunez/react-native-xtool}"
  if [ -f "$spec" ]; then
    docker cp "$spec" "$NAME:/home/me/$(basename "$spec")"
    spec="/home/me/$(basename "$spec")"
  fi
  as_user /home/me "sudo npm i -g $(printf '%q' "$spec") && rn-xtool --version"
}

cmd_setup() {
  as_user /home/me "rn-xtool setup --xcode-xip '/xcode/$(basename "$XIP")'"
}

cmd_auth() {
  as_user /home/me "mkdir -p ~/.config/xtool/data ~/.cache/rn-xtool/pair-records && chmod 700 ~/.cache/rn-xtool/pair-records"
  # Copy the directory's contents: copying the directory itself nests it as data/data on a second run.
  docker cp "$HOME/.config/xtool/data/." "$NAME:/home/me/.config/xtool/data"
  local records=()
  if [ -n "${E2E_UDID:-}" ]; then
    records=("$HOME/.cache/rn-xtool/pair-records/$E2E_UDID.plist")
  else
    shopt -s nullglob; records=("$HOME"/.cache/rn-xtool/pair-records/*.plist); shopt -u nullglob
  fi
  [ ${#records[@]} -gt 0 ] || { echo "no pair record in ~/.cache/rn-xtool/pair-records (run rn-xtool setup --wifi on the host)"; exit 1; }
  for r in "${records[@]}"; do docker cp "$r" "$NAME:/home/me/.cache/rn-xtool/pair-records/"; done
  docker exec -u root "$NAME" bash -c 'chown -R me:me /home/me/.config /home/me/.cache && chmod 600 /home/me/.cache/rn-xtool/pair-records/*.plist'
  as_user /home/me '"$(ls -t ~/.cache/rn-xtool/xtool-*.AppImage | head -1)" auth status'
}

cmd_project() {
  local bare=0 rn="" sdk="" name=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --bare) bare=1; shift ;;
      --rn)
        [ $# -ge 2 ] || { echo "--rn needs a version" >&2; exit 1; }
        rn="$2"; shift 2 ;;
      --sdk)
        { [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; } || { echo "--sdk needs a version" >&2; exit 1; }
        sdk="$2"; shift 2 ;;
      *) name="$1"; shift ;;
    esac
  done
  [ -z "$rn" ] || [ "$bare" -eq 1 ] || { echo "--rn needs --bare" >&2; exit 1; }
  [ -z "$sdk" ] || [ "$bare" -eq 0 ] || { echo "--sdk cannot be combined with --bare" >&2; exit 1; }
  name="${name:-demo}"
  local qname="${name//\'/\'\\\'\'}" # single-quote-safe: ' becomes '\''
  rn="${rn:-0.88.0}"
  if [ "$bare" -eq 1 ]; then
    # --install-pods false: the container has no CocoaPods, and rn-xtool does not need Pods. npm deps are installed.
    as_user /home/me "npx --yes @react-native-community/cli@latest init '$qname' --version $rn --install-pods false --skip-git-init"
  else
    local template="blank-typescript"
    [ -z "$sdk" ] || template="blank-typescript@sdk-$sdk"
    as_user /home/me "npx --yes create-expo-app@latest '$qname' --template $template"
  fi
  echo "$name" > "$PROJECT_FILE"
}

cmd_sh() {
  local dir=/home/me
  [ -f "$PROJECT_FILE" ] && dir="/home/me/$(cat "$PROJECT_FILE")"
  if [ $# -eq 0 ]; then docker exec -it -u me -e HOME=/home/me -w "$dir" "$NAME" bash -l; else as_user "$dir" "$(printf '%q ' "$@")"; fi
}

cmd_down() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$PROJECT_FILE"
  echo "removed $NAME and $VOLUME (image $IMAGE kept; docker rmi it to free space)"
}

case "${1:-}" in
  up|install|setup|auth|project|sh|down) fn="cmd_$1"; shift; "$fn" "$@" ;;
  *) sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
