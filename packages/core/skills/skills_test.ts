import { assert, assertEquals, assertRejects } from "@std/assert";
import { ConfigError } from "../config/load.ts";
import { createSkillTool, loadSkills, parseSkill, skillsPromptSection } from "./skills.ts";

Deno.test("parseSkill: frontmatter wins, body is content", () => {
  const skill = parseSkill(
    `---\nname: gh-issues\ndescription: Manage GitHub issues via the gh CLI.\n---\n# Usage\ngh issue create ...`,
    "fallback",
  );
  assertEquals(skill.name, "gh-issues");
  assertEquals(skill.description, "Manage GitHub issues via the gh CLI.");
  assert(skill.content.startsWith("# Usage"));
});

Deno.test("parseSkill: no frontmatter falls back to filename and first line", () => {
  const skill = parseSkill(`# Title\nTeach the agent to use curl well.\nMore.`, "curl-basics");
  assertEquals(skill.name, "curl-basics");
  assertEquals(skill.description, "Teach the agent to use curl well.");
});

Deno.test("loadSkills: resolves relative to config dir, rejects duplicates", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/a.md`, "---\nname: alpha\n---\nAlpha skill.");
  await Deno.writeTextFile(`${dir}/b.md`, "Beta skill body.");

  const skills = await loadSkills(["./a.md", "b.md"], dir);
  assertEquals(skills.map((s) => s.name), ["alpha", "b"]);

  await Deno.writeTextFile(`${dir}/dup.md`, "---\nname: alpha\n---\nDuplicate.");
  await assertRejects(() => loadSkills(["a.md", "dup.md"], dir), ConfigError, "duplicate");
  await assertRejects(() => loadSkills(["missing.md"], dir), ConfigError, "cannot read");
});

Deno.test("progressive disclosure: one line in prompt, full content via tool", async () => {
  const skills = [
    { name: "gh-issues", description: "GitHub issues via gh.", content: "# Full instructions" },
  ];
  const section = skillsPromptSection(skills);
  assert(section.includes("- gh-issues: GitHub issues via gh."));
  assert(!section.includes("# Full instructions"));

  const tool = createSkillTool(skills);
  assertEquals(await tool.execute('{"name":"gh-issues"}'), "# Full instructions");
  assert((await tool.execute('{"name":"nope"}')).includes("unknown skill"));
  assertEquals(skillsPromptSection([]), "");
});
