# looped/agent — the official base image (Plan 1: minimal, hardened).
# Deno + the framework + native tools. No browser, no extras: capability
# is added per-agent in a derived image (apk add <your-cli>).
#
# Quick run:
#   docker build -f images/agent/Dockerfile -t looped/agent .
#   docker run -v ./agent.yaml:/agent/agent.yaml:ro --env-file .env looped/agent
FROM denoland/deno:alpine-2.9.1

# bash: the run_bash tool's contract (alpine ships only busybox sh).
# Non-root always. 10001 avoids host-uid collisions.
RUN apk add --no-cache bash \
 && addgroup -S looped && adduser -S -G looped -u 10001 looped \
 && mkdir -p /agent /data /deno-dir \
 && chown -R looped:looped /data /deno-dir

ENV DENO_DIR=/deno-dir \
    LOOPED_DATA_DIR=/data \
    LOOPED_STATUS_HOST=0.0.0.0

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
# gate). Net is open at this layer: hosts are enforced app-level by the
# permission engine, and layer 2 is container egress policy — see
# docs/deployment.md.
ENTRYPOINT ["deno", "run", \
  "--allow-env", \
  "--allow-read=/agent,/skills,/data,/looped,/deno-dir,/run/secrets", \
  "--allow-write=/data", \
  "--allow-net", \
  "--allow-run=bash", \
  "packages/cli/main.ts"]
CMD ["run", "/agent/agent.yaml"]
