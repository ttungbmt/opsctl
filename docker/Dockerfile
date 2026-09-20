# Ubuntu sandbox for exercising the `ops` CLI against a real system.
#
# The CLI shells out to sudo/apt-get/mise for real, so the container mirrors a
# user's machine: an unprivileged account with passwordless sudo, mise on PATH
# and /etc/os-release reporting ubuntu (the apt branch in src/providers/os.ts).
FROM ubuntu:24.04

ARG USER=ops
ARG UID=1000
ARG GID=1000
ENV DEBIAN_FRONTEND=noninteractive

# ca-certificates: src/providers/deb.ts downloads .deb files over https.
# git/unzip/xz-utils: what mise needs to fetch and unpack tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      sudo \
      unzip \
      xz-utils \
 && rm -rf /var/lib/apt/lists/*

# ubuntu:24.04 ships a stock "ubuntu" account on uid 1000; drop it so ours can
# take that id and stay in sync with the host owner of the bind-mounted repo.
RUN userdel -r ubuntu 2>/dev/null || true \
 && groupadd -g "${GID}" "${USER}" \
 && useradd -m -u "${UID}" -g "${GID}" -s /bin/bash "${USER}" \
 && printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${USER}" > "/etc/sudoers.d/90-${USER}" \
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
