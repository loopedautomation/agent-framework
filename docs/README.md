# Documentation

The Looped AF documentation, **authored here** and published at
<https://docs.looped.sh/agent-framework> — the docs site
([loopedautomation/docs](https://github.com/loopedautomation/docs)) pulls this folder in at build
time. Content ships with every milestone — a feature PR that doesn't touch `docs/` isn't done
(Plan 0, principle 10).

Target bar: a newcomer goes from zero to their own running agent in under 30 minutes.

## Authoring rules

These files are in the docs site's format ([Fumadocs](https://fumadocs.dev)):

- Frontmatter carries `title` and `description`; no `#` H1 in the body (the site renders the title).
- Link to sibling pages with plain relative links (`service-agents.md#permissions`) — these work on
  GitHub and on the site.
- Link to anything else in the repo (plans, examples, schema) with **absolute GitHub URLs** —
  repo-relative paths like `../plans/` would break on the site.
- `meta.json` is the sidebar (order + section headings). `index.mdx` is the tab landing page and
  may use Fumadocs components (it won't render fully on GitHub — that's fine).
- The [manifesto](../MANIFESTO.md) stays canonical at the repo root; the site generates its page
  from it. This `README.md` is not published.

Publishing: the docs site rebuilds on its own pushes; after changing docs here, trigger a rebuild
(deploy hook) or push any commit to `loopedautomation/docs`.
