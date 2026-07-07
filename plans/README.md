# Looped AF — Plans

This directory is the source of truth for what Looped AF is and where it's going. Code follows plans, not the other way around.

## The series

| Plan | Doc | What it covers |
|------|-----|----------------|
| 0 | [000-vision.md](000-vision.md) | Why this exists, goals, principles, non-goals |
| 1 | [001-architecture.md](001-architecture.md) | Core concepts and system design |
| 2 | [002-mvp.md](002-mvp.md) | The proving ground: Discord → GitHub issue agent |
| 3 | [003-roadmap.md](003-roadmap.md) | Milestones from manifesto to deployed MVP and the meta-agent |
| 4 | [004-landscape.md](004-landscape.md) | Competitive landscape, positioning, target market, adopted lessons |
| 5 | [005-platform.md](005-platform.md) | Hosted platform, service business, agent hub |
| 6 | [006-security.md](006-security.md) | Enforcement layers, egress gaps, hermetic mode and the egress proxy |
| 7 | [007-email-triggers.md](007-email-triggers.md) | Email as a trigger: inbound webhooks, mailbox polling, Gmail and Outlook |

## How to read and amend these

- **Plans are living documents.** When a decision changes, amend the plan in place — don't write a new doc that contradicts an old one. Git history is the changelog.
- **Open questions are explicit.** Each doc ends with an "Open questions" section. If something isn't decided, it lives there — nothing gets decided silently.
- **New plans get the next number.** Big new areas (e.g. multi-agent design, hosting platform) become `004-...`, `005-...` when they're ready to be planned properly.
- **Plan 0 wins conflicts.** If a lower-numbered plan and a higher-numbered plan disagree, the lower number is the authority until amended.
