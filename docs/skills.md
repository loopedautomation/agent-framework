---
title: "Skills"
description: "Teach the agent to use any CLI or API with a markdown file. Skills add knowledge; capability stays with the config."
---

A skill is a markdown file that teaches the agent how to use something well. A skill carries knowledge and nothing else: it cannot grant permissions, and the config's `permissions:` block stays the sole authority over what the agent is allowed to do. This means that the worst a bad skill can be is misleading documentation.

```yaml
skills:
  - ./skills/gh-issues.md
permissions:
  run: [gh]        # the grant that makes gh runnable
```

This split is how you integrate almost anything: the [custom image](docker-run.md#the-custom-image-story) provides the binary, the skill explains how to use it and the [permissions](permissions.md) block allows it to run. For most integrations, you don't need an MCP server. A CLI and a well written skill can go a long way.

## Authoring a skill

A skill file can open with YAML frontmatter (`name` and `description`); if you leave it out, the filename and the first line stand in:

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

A skill stays out of the model's context until it's needed. The system prompt carries one line per skill (its name and description), and the agent reads the full document with the `read_skill` tool when the task calls for it. This means that an agent with ten skills spends ten lines of context on them until one is actually read.

## First-party skills

The [`skills/`](https://github.com/loopedautomation/agent-framework/tree/main/skills) directory holds the skills maintained with the framework:

- [`gh-issues`](https://github.com/loopedautomation/agent-framework/blob/main/skills/gh-issues.md) - create and manage GitHub issues with the `gh` CLI. The [gh-issues-bot example](https://github.com/loopedautomation/agent-framework/tree/main/examples/gh-issues-bot) uses it.
- [`looped-authoring`](https://github.com/loopedautomation/agent-framework/blob/main/skills/looped-authoring.md) - scaffold and validate Looped agents with the `af` CLI. The [agent-zero-bot example](https://github.com/loopedautomation/agent-framework/tree/main/examples/agent-zero-bot), the agent that builds agents, uses it.
