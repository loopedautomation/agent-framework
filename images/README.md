# Images

Dockerfiles for the official `looped/agent` base image: Deno + the framework + native tools, hardened (non-root, read-only rootfs, no capabilities, egress off by default) and minimal — no browser, no extras.

Custom agent environments extend it:

```dockerfile
FROM looped/agent
RUN apk add --no-cache github-cli
```

Lands in M4 (plans/003-roadmap.md).
