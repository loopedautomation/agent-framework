# The environment for a Claude-Code-backed agent: the base image plus the
# claude CLI (via node), git, and gh. The YAML stays the agent.
#
# Build from the repo root (compose.yaml does this for you):
#   docker build -f examples/release-bot/Dockerfile -t release-bot .
FROM ghcr.io/loopedautomation/agent:latest

USER root
# nodejs/npm: the claude CLI is an npm package. git: claude's bread and
# butter. gh from the official release for the same reason as
# gh-issues-bot — Alpine's package lags upstream.
ARG GH_VERSION=2.96.0
ARG TARGETARCH
RUN apk add --no-cache nodejs npm git \
 && npm install -g @anthropic-ai/claude-code \
 && wget -qO /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
 && claude --version && gh --version
USER looped

# claude writes state under $HOME/.claude and clones live in /data/work —
# both on the /data volume, keeping the rootfs read-only.
ENV HOME=/data/home

COPY --chown=looped:looped examples/release-bot/agent.yaml /agent/agent.yaml
