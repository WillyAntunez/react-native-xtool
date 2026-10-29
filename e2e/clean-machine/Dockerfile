# A bare Ubuntu 24.04 desktop-like machine for end-to-end tests of rn-xtool from scratch:
# nothing from the host toolchain, only what the README asks a user to have.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# README requirements: Node 22.12+, libfuse2 (AppImage), python3 (shims), iproute2 (`ip`), plus git/curl/sudo
# that any desktop install has. `fuse3` provides the fusermount binary the AppImage runtime calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git sudo python3 iproute2 xz-utils unzip tar gzip \
    libfuse2t64 fuse3 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# A regular user with sudo, like a fresh Ubuntu install.
RUN useradd -m -s /bin/bash me && echo 'me ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/me

# Docker denies FUSE mounts to an unprivileged container; the AppImage runtime extracts itself instead.
# (So the libfuse2 path of the README is not exercised here.)
ENV APPIMAGE_EXTRACT_AND_RUN=1

USER me
WORKDIR /home/me
CMD ["sleep", "infinity"]
