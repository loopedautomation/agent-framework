# The image for the CLI variant (agent.cli.yaml): the base image plus git,
# the gh CLI and headless Claude Code. agent.yaml needs none of this — it
# runs on ghcr.io/loopedautomation/agent:latest unchanged.
#
# Build from the repo root (compose.cli.yaml does this for you):
#   docker build -f examples/github-bot/Dockerfile -t github-bot .
FROM ghcr.io/loopedautomation/agent:latest

USER root
# gh from the official release rather than Alpine's package, which lags
# upstream. nodejs/npm because the claude CLI is an npm package.
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

COPY --chown=looped:looped examples/github-bot/agent.cli.yaml /agent/agent.yaml
COPY --chown=looped:looped examples/github-bot/github-profile.md /agent/github-profile.md
