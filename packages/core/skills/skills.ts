import { parse } from "@std/yaml";
import { z } from "zod";
import { ConfigError } from "../config/load.ts";
import { defineTool, type NativeTool } from "../tools/types.ts";

/**
 * A skill is markdown know-how: how to drive a CLI or an API well.
 * Skills carry knowledge, never capability — permissions stay the sole
 * authority on what's runnable/reachable (Plan 1).
 */
export interface Skill {
  /** Skill name; the model uses it with the read_skill tool. */
  name: string;
  /** One line shown in the system prompt. */
  description: string;
  /** Full markdown body, loaded into context only when the agent asks. */
  content: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const FrontmatterSchema = z.looseObject({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

/** Parse a skill file: optional YAML frontmatter (name, description) + body. */
export function parseSkill(text: string, fallbackName: string): Skill {
  let name = fallbackName;
  let description: string | undefined;
  let body = text;

  const fm = text.match(FRONTMATTER);
  if (fm) {
    body = text.slice(fm[0].length);
    const parsed = FrontmatterSchema.safeParse(parse(fm[1]) ?? {});
    if (parsed.success) {
      name = parsed.data.name ?? name;
      description = parsed.data.description;
    }
  }
  if (!description) {
    // First non-empty, non-heading line stands in for a description.
    description = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ??
      "(no description)";
  }
  return { name, description, content: body.trim() };
}

/** Load the skills a config references, relative to the config's directory. */
export async function loadSkills(paths: string[], baseDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const path of paths) {
    const resolved = path.startsWith("/") ? path : `${baseDir}/${path}`;
    let text: string;
    try {
      text = await Deno.readTextFile(resolved);
    } catch (err) {
      throw new ConfigError(`cannot read skill ${resolved}: ${(err as Error).message}`, resolved);
    }
    const fallback = resolved.split("/").at(-1)!.replace(/\.md$/, "");
    skills.push(parseSkill(text, fallback));
  }
  const names = new Set<string>();
  for (const s of skills) {
    if (names.has(s.name)) throw new ConfigError(`duplicate skill name: ${s.name}`);
    names.add(s.name);
  }
  return skills;
}

/**
 * Progressive disclosure: the system prompt carries one line per skill;
 * the full content costs context only when actually used.
 */
export function skillsPromptSection(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `\n\nYou have skills — instruction documents you can read with the read_skill tool ` +
    `when a task calls for them:\n${lines}`;
}

/** Build the read_skill native tool: returns a skill's full content by name. */
export function createSkillTool(skills: Skill[]): NativeTool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return defineTool({
    name: "read_skill",
    description: "Read the full instructions of one of your skills by name.",
    schema: z.strictObject({ name: z.string().min(1) }),
    readOnly: true,
    execute({ name }) {
      const skill = byName.get(name);
      if (!skill) {
        return `unknown skill: ${name}. Available: ${[...byName.keys()].join(", ")}`;
      }
      return skill.content;
    },
  });
}
