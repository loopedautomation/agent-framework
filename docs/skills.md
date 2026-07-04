---
title: "Skills"
description: "Teach any CLI or API with a markdown file — knowledge, never capability."
---

A skill is a markdown file that teaches the agent how to use something well. Skills carry **knowledge, never capability**: a skill can't grant permissions — the config's `permissions:` block stays the sole authority, so the worst a bad skill can be is misleading documentation.

```yaml
skills:
  - ./skills/gh-issues.md
permissions:
  run: [gh]        # the capability half of the recipe
```

This split is the default recipe for integrating anything: **the [custom image](deployment.md#the-custom-image-story) provides the binary, the skill provides the knowledge, the [permissions](permissions.md) provide the safety.** Most integrations don't need an MCP server — a good CLI plus a page of know-how beats forty tool schemas in a small model's context.

## Authoring a skill

Skill files take optional YAML frontmatter (`name`, `description`); otherwise the filename and first line stand in:

```markdown
---
name: gh-issues
description: Create and manage GitHub issues with the gh CLI.
---

# Managing GitHub issues with `gh`
...full instructions...
```

Paths in `skills:` are relative to the agent file. Write a skill the way you'd write a runbook for a new hire: the commands that work, the flags that matter, the failure modes and what to do about them.

## Progressive disclosure

Skills stay cheap-model friendly by staying out of context until needed: the system prompt carries **one line per skill** (its name and description); the agent reads the full document with the `read_skill` tool only when the task calls for it. A shelf of ten skills costs ten lines, not ten documents.

## First-party skills

The [`skills/`](https://github.com/loopedautomation/agent-framework/tree/main/skills) directory holds the skills maintained with the framework:

- [`gh-issues`](https://github.com/loopedautomation/agent-framework/blob/main/skills/gh-issues.md) — create and manage GitHub issues with the `gh` CLI (used by the [issue-bot example](https://github.com/loopedautomation/agent-framework/tree/main/examples/issue-bot)).
- [`looped-authoring`](https://github.com/loopedautomation/agent-framework/blob/main/skills/looped-authoring.md) — how to scaffold and validate Looped agents with the `af` CLI (used by the [agent-builder example](https://github.com/loopedautomation/agent-framework/tree/main/examples/agent-builder) — the agent that builds agents).
