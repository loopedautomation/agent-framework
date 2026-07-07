# The custom-image story: the Dockerfile is the environment, the YAML is
# the agent. The base image is minimal, and this agent needs curl for the
# Resend API and the calendar feed, so one layer adds it.
#
# Build from the repo root (compose.yaml does this for you):
#   docker build -f examples/mail-assistant/Dockerfile -t mail-assistant .
FROM ghcr.io/loopedautomation/agent:latest

USER root
RUN apk add --no-cache curl
USER looped

# Self-contained artifact: config + skill baked in, deploy anywhere.
COPY --chown=looped:looped examples/mail-assistant/mail-and-calendar.md /agent/mail-and-calendar.md
COPY --chown=looped:looped examples/mail-assistant/agent.yaml /agent/agent.yaml
