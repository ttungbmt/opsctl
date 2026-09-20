# Ubuntu sandbox for exercising the `ops` CLI against a real system.
#
# The CLI shells out to sudo/apt-get/mise for real, so the container mirrors a
# user's machine: an unprivileged account with passwordless sudo, mise on PATH
# and /etc/os-release reporting ubuntu (the apt branch in src/providers/os.ts).
#
# Nothing in here may stop to ask a question. `ops tool setup` runs commands a
# recipe names, and those commands run apt themselves -- `agent-browser install
# --with-deps` does -- so a debconf prompt would hang with no way out. Note that
# the ENV below does NOT prevent that: sudo resets the environment, so a child
# under `sudo apt-get` never sees it. The blocks that follow work around that by
# configuring debconf and apt on disk, where sudo cannot strip them.
FROM ubuntu:24.04

ARG USER=ops
ARG UID=1000
ARG GID=1000

# Pin the timezone at build time; otherwise tzdata interrogates whoever first
# pulls it in. Override with: docker compose build --build-arg TZ=Etc/UTC
ARG TZ=Asia/Ho_Chi_Minh
ENV TZ=${TZ}

# Useful to the build's own RUN steps and, thanks to the sudoers env_keep below,
# to tools that read it at runtime. Not load-bearing on its own.
ENV DEBIAN_FRONTEND=noninteractive

# Answer every debconf question ahead of time, in debconf's own database. This
# is the one switch sudo cannot undo, because it is a file rather than an
# environment variable. ca-certificates: src/providers/deb.ts downloads .deb
# files over https. git/unzip/xz-utils: what mise needs to unpack tools.
# tzdata: installed and configured here so nothing has to ask for it later.
RUN echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      sudo \
      tzdata \
      unzip \
      xz-utils \
 && ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime \
 && echo "${TZ}" > /etc/timezone \
 && dpkg-reconfigure -f noninteractive tzdata \
 && rm -rf /var/lib/apt/lists/*

# dpkg's conffile prompt ("keep the old version or take the new one?") is not a
# debconf question, so the line above does not cover it. Settle it on disk too,
# for the benefit of apt calls made by tools that pass no flags of their own.
RUN printf '%s\n' \
      'APT::Get::Assume-Yes "true";' \
      'Dpkg::Options:: "--force-confdef";' \
      'Dpkg::Options:: "--force-confold";' \
      > /etc/apt/apt.conf.d/90-ops-noninteractive

# ubuntu:24.04 ships a stock "ubuntu" account on uid 1000; drop it so ours can
# take that id and stay in sync with the host owner of the bind-mounted repo.
RUN userdel -r ubuntu 2>/dev/null || true \
 && groupadd -g "${GID}" "${USER}" \
 && useradd -m -u "${UID}" -g "${GID}" -s /bin/bash "${USER}" \
 && printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${USER}" > "/etc/sudoers.d/90-${USER}" \
 && printf 'Defaults env_keep += "DEBIAN_FRONTEND TZ"\n' >> "/etc/sudoers.d/90-${USER}" \
 && chmod 0440 "/etc/sudoers.d/90-${USER}"

# node_modules are named volumes; a fresh volume inherits ownership from the
# image, so create the mount points owned by the user before declaring them.
RUN mkdir -p /workspace/node_modules /workspace/apps/cli/node_modules \
 && chown -R "${UID}:${GID}" /workspace

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER ${USER}
ENV HOME=/home/${USER}
ENV PATH=${HOME}/.local/bin:${HOME}/.local/share/mise/shims:${PATH}
# The repo's mise.toml arrives via bind mount, so mise has never seen it and
# would refuse to read it until trusted.
ENV MISE_TRUSTED_CONFIG_PATHS=/workspace
WORKDIR /workspace

# mise is both the toolchain manager here and the binary the CLI itself invokes
# (src/providers/mise-tools.ts, mise-bootstrap.ts). Versions match mise.toml.
RUN curl -fsSL https://mise.run | sh \
 && mise use -g node@lts pnpm@12 \
 && mise reshim

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
