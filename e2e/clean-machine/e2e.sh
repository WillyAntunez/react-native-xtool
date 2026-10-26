#!/usr/bin/env bash
# Clean-machine end-to-end test of expo-xtool inside a throwaway Ubuntu container.
#
# The container shares the host network (to reach the iPhone over Wi‑Fi and serve Metro); the xtool
# AppImage runs extracted (no FUSE in Docker). Everything else is a fresh home directory on a Docker volume.
#
#   e2e.sh up                      build the image, start the container
#   e2e.sh install [<npm spec>]    install expo-xtool (default: github:WillyAntunez/expo-xtool)
#   e2e.sh setup                   expo-xtool setup --xcode-xip (the slow part: Swift, xtool, Darwin SDK)
#   e2e.sh auth                    copy the host's xtool login and the iPhone pair record into the container
#   e2e.sh project [<name>]        npx create-expo-app <name> (default: demo)
#   e2e.sh sh [<cmd...>]           run a command (or a shell) as the test user, in the project dir if it exists
#   e2e.sh down                    remove the container and its home volume
#
# Environment: XCODE_XIP (default ~/Downloads/Xcode_27.1.xip), E2E_NAME (default expo-xtool-e2e),
# E2E_UDID (pair record to copy; default: every record in ~/.cache/expo-xtool/pair-records).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${E2E_NAME:-expo-xtool-e2e}"
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
    --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
    -v "$VOLUME:/home/me" \
    -v "$XIP:/xcode/$(basename "$XIP"):ro" \
    "$IMAGE" >/dev/null
  # A fresh volume is owned by root; hand it to the test user.
  docker exec -u root "$NAME" chown me:me /home/me
  echo "container $NAME up (home volume: $VOLUME)"
}

cmd_install() {
  local spec="${1:-github:WillyAntunez/expo-xtool}"
  if [ -f "$spec" ]; then
    docker cp "$spec" "$NAME:/home/me/$(basename "$spec")"
    spec="/home/me/$(basename "$spec")"
  fi
  as_user /home/me "sudo npm i -g $(printf '%q' "$spec") && expo-xtool --version"
}

cmd_setup() {
  as_user /home/me "expo-xtool setup --xcode-xip '/xcode/$(basename "$XIP")'"
}

cmd_auth() {
  as_user /home/me "mkdir -p ~/.config/xtool/data ~/.cache/expo-xtool/pair-records && chmod 700 ~/.cache/expo-xtool/pair-records"
  # Copy the directory's contents: copying the directory itself nests it as data/data on a second run.
  docker cp "$HOME/.config/xtool/data/." "$NAME:/home/me/.config/xtool/data"
  local records=()
  if [ -n "${E2E_UDID:-}" ]; then
    records=("$HOME/.cache/expo-xtool/pair-records/$E2E_UDID.plist")
  else
    shopt -s nullglob; records=("$HOME"/.cache/expo-xtool/pair-records/*.plist); shopt -u nullglob
  fi
  [ ${#records[@]} -gt 0 ] || { echo "no pair record in ~/.cache/expo-xtool/pair-records (run expo-xtool setup --wifi on the host)"; exit 1; }
  for r in "${records[@]}"; do docker cp "$r" "$NAME:/home/me/.cache/expo-xtool/pair-records/"; done
  docker exec -u root "$NAME" bash -c 'chown -R me:me /home/me/.config /home/me/.cache && chmod 600 /home/me/.cache/expo-xtool/pair-records/*.plist'
  as_user /home/me '"$(ls -t ~/.cache/expo-xtool/xtool-*.AppImage | head -1)" auth status'
}

cmd_project() {
  local name="${1:-demo}"
  as_user /home/me "npx --yes create-expo-app@latest '$name' --template blank-typescript"
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
