# The MCP-server story: the Dockerfile installs the server binary, the YAML
# wires it up under tools.mcp. Compare with ../gh-issues-cli, where the same
# layer installs the gh CLI instead.
#
# Build from the repo root (compose.yaml does this for you):
#   docker build -f examples/gh-issues-mcp/Dockerfile -t gh-issues-mcp .
FROM ghcr.io/loopedautomation/agent:latest

ARG MCP_VERSION=1.5.0
ARG TARGETARCH

USER root
# TARGETARCH comes from BuildKit; older builders leave it empty, so fall
# back to the build machine's own architecture.
RUN arch="${TARGETARCH:-$(uname -m)}" \
 && case "$arch" in \
      arm64|aarch64) arch=arm64 ;; \
      *) arch=x86_64 ;; \
    esac \
 && wget -qO- "https://github.com/github/github-mcp-server/releases/download/v${MCP_VERSION}/github-mcp-server_Linux_${arch}.tar.gz" \
  | tar -xz -C /usr/local/bin github-mcp-server
USER looped

# Self-contained artifact: config baked in, deploy anywhere.
COPY --chown=looped:looped examples/gh-issues-mcp/agent.yaml /agent/agent.yaml
