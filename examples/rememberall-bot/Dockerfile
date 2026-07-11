# The simplest custom-image story: this agent needs no extra binaries, so
# the only layer on the base image is its own config.
#
# Build from the repo root (compose.yaml does this for you):
#   docker build -f examples/rememberall-bot/Dockerfile -t rememberall-bot .
FROM ghcr.io/loopedautomation/agent:latest

# Self-contained artifact: config baked in, deploy anywhere.
COPY --chown=looped:looped examples/rememberall-bot/agent.yaml /agent/agent.yaml
