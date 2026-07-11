# The custom-image story: the Dockerfile is the environment, the YAML is
# the agent. One layer adds the one binary this agent needs.
#
# Build from the repo root (compose.yaml does this for you):
#   docker build -f examples/gh-issues-bot/Dockerfile -t gh-issues-bot .
FROM ghcr.io/loopedautomation/agent:latest

# Install gh from the official release, not apk: Alpine's github-cli package
# lags upstream by months, and the skill relies on newer flags (issue types,
# sub-issues, blocked-by). Pinning also makes the build
# reproducible. gh is a static Go binary, so the release tarball runs fine
# on musl.
ARG GH_VERSION=2.96.0
ARG TARGETARCH
USER root
RUN wget -qO /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
 && gh --version
USER looped

# Self-contained artifact: config + skills baked in, deploy anywhere.
COPY --chown=looped:looped skills/gh-issues.md /skills/gh-issues.md
COPY --chown=looped:looped examples/gh-issues-bot/agent.yaml /agent/agent.yaml
