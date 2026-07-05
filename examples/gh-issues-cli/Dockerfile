# The custom-image story: the Dockerfile is the environment, the YAML is
# the agent. One layer adds the one binary this agent needs.
#
# Build from the repo root (compose.yaml does this for you):
#   docker build -f examples/gh-issues-cli/Dockerfile -t gh-issues-cli .
FROM ghcr.io/loopedautomation/agent:latest

USER root
RUN apk add --no-cache github-cli
USER looped

# Self-contained artifact: config + skills baked in, deploy anywhere.
COPY --chown=looped:looped skills/gh-issues.md /skills/gh-issues.md
COPY --chown=looped:looped examples/gh-issues-cli/agent.yaml /agent/agent.yaml
