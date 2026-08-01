# looped/agent — the official base image (Plan 1: minimal, hardened).
# Deno + the framework + native tools. No browser, no extras: capability
# is added per-agent in a derived image (apk add <your-cli>).
#
# Quick run:
#   docker build -f images/agent/Dockerfile -t looped/agent .
#   docker run -v ./agent.yaml:/agent/agent.yaml:ro --env-file .env looped/agent
FROM denoland/deno:alpine-2.9.1

LABEL org.opencontainers.image.description="The Looped AF base agent image: Deno, the framework, and the native tools — hardened, non-root, health-checked. An agent is a file: mount your agent.yaml and run." \
      org.opencontainers.image.source="https://github.com/loopedautomation/agent-framework" \
      org.opencontainers.image.licenses="Apache-2.0"

# bash: the run_bash tool's contract (alpine ships only busybox sh).
# Non-root always. 10001 avoids host-uid collisions.
RUN apk add --no-cache bash \
 && addgroup -S looped && adduser -S -G looped -u 10001 looped \
 && mkdir -p /agent /data /deno-dir \
 && chown -R looped:looped /data /deno-dir

# AF_CONTAINER: tells `af run` it's already inside the container, so the
# entrypoint executes the agent in-process instead of spawning docker.
ENV DENO_DIR=/deno-dir \
    AF_DATA_DIR=/data \
    AF_STATUS_HOST=0.0.0.0 \
    AF_CONTAINER=1

WORKDIR /looped
COPY deno.json deno.lock LICENSE ./
COPY packages/ packages/
RUN deno cache packages/cli/main.ts && chown -R looped:looped /deno-dir

USER looped
VOLUME /data
# 8080: webhook trigger (if configured) · 9090: status surface
EXPOSE 8080 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:9090/healthz || exit 1

# Deno sandbox = enforcement layer 1 (reads scoped to config/data/secrets,
# writes to /data only, bash spawnable only for the permission engine to
# gate). These flags are the widest an agent can run under, chosen at build
# time before any agent.yaml is known.
#
# An agent that spawns nothing — no permissions.run, no stdio MCP — doesn't
# need them. The entrypoint reads its config and re-execs itself with the net
# allowlist compiled into --allow-net (hermetic mode, Plan 6), so the sandbox
# holds every host, not just the ones http_request asks for. `deno` is
# spawnable for that re-exec; it happens before the model is in the loop, and
# the child gets no --allow-run at all. Agents that do spawn subprocesses keep
# these flags, and the container is their egress boundary — see
# docs/permission-model.md.
#
# Keep the read/write paths in step with RUNTIME_READ_PATHS and
# RUNTIME_WRITE_PATHS (packages/core/permissions/hermetic.ts); a test compares
# this ENTRYPOINT against them.
ENTRYPOINT ["deno", "run", \
  "--allow-env", \
  "--allow-read=/agent,/skills,/data,/looped,/deno-dir,/run/secrets,/etc/af", \
  "--allow-write=/data", \
  "--allow-net", \
  "--allow-run=bash,deno", \
  "packages/cli/main.ts"]
CMD ["run", "/agent/agent.yaml"]
