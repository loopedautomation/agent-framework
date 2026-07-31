import { parse } from "@std/yaml";
import { z } from "zod";
import type { Permissions } from "../config/schema.ts";
import type { PermissionKind } from "./engine.ts";

/**
 * The env var naming a floor file. Set it to a path and that file is the
 * operator's policy for every agent this process starts.
 */
export const FLOOR_ENV = "AF_PERMISSION_FLOOR";

/**
 * Where a floor is looked for when {@linkcode FLOOR_ENV} is unset. Absolute,
 * because the thing that has to read it is a container: a policy under a
 * developer's `~/.config` is invisible to the process it is meant to bind.
 */
export const DEFAULT_FLOOR_PATH = "/etc/af/floor.yaml";

const AxisListSchema = z.array(z.string().min(1)).optional();

const FloorSchema = z.strictObject({
  net: AxisListSchema.describe(
    "Hosts an agent file may ask for. Omit the key to leave net unconstrained.",
  ),
  run: AxisListSchema.describe(
    "Executables an agent file may ask for, by basename. Omit to leave run unconstrained.",
  ),
  read: AxisListSchema.describe("Path prefixes an agent file may ask to read."),
  write: AxisListSchema.describe("Path prefixes an agent file may ask to write."),
  deny: z.strictObject({
    net: AxisListSchema,
    run: AxisListSchema,
    read: AxisListSchema,
    write: AxisListSchema,
  }).optional().describe(
    "Grants no agent file may hold, whatever the allow lists above say. Use this to forbid a " +
      "few things without enumerating everything permitted.",
  ),
}).describe(
  "An operator's ceiling on what any agent file may be granted. It can only refuse; nothing " +
    "here grants an agent anything it did not ask for.",
);

/** An operator's ceiling on what any agent file may be granted. */
export interface PermissionFloor {
  /** Hosts an agent file may ask for; absent leaves the axis unconstrained. */
  net?: string[];
  /** Executables an agent file may ask for, by basename. */
  run?: string[];
  /** Path prefixes an agent file may ask to read. */
  read?: string[];
  /** Path prefixes an agent file may ask to write. */
  write?: string[];
  /** Grants no agent file may hold, whatever the allow lists say. */
  deny?: {
    net?: string[];
    run?: string[];
    read?: string[];
    write?: string[];
  };
}

/** One grant the floor refused, and why. */
export interface FloorViolation {
  /** Which axis the refused grant was on. */
  kind: PermissionKind;
  /** The entry the agent file asked for. */
  requested: string;
  /**
   * The floor entry that refused it, when a deny list did. Absent means the
   * axis has an allow list and nothing in it covered the request.
   */
  deniedBy?: string;
}

/**
 * `*.example.com` covers `api.example.com` and `*.eu.example.com`; an exact
 * host covers only itself. Asymmetric on purpose: this asks whether the
 * floor's pattern is at least as wide as the file's, so a file asking for a
 * wildcard is refused by a floor that named one host.
 */
function hostCovers(floor: string, requested: string): boolean {
  if (floor === "*") return true;
  if (requested === "*") return false;
  if (floor.startsWith("*.")) {
    const suffix = floor.slice(1); // ".example.com"
    // A requested wildcard is covered when everything it can match also ends
    // in the floor's suffix.
    if (requested.startsWith("*.")) return requested.slice(1).endsWith(suffix);
    return requested.endsWith(suffix) && requested !== floor.slice(2);
  }
  return floor === requested;
}

/** Two host patterns overlap when either could resolve to a host the other also matches. */
function hostOverlaps(a: string, b: string): boolean {
  return hostCovers(a, b) || hostCovers(b, a);
}

/** `/data` covers `/data/runs`; it does not cover `/`. */
function pathCovers(floor: string, requested: string): boolean {
  const normal = floor.endsWith("/") ? floor : floor + "/";
  return requested === floor || requested.startsWith(normal);
}

function pathOverlaps(a: string, b: string): boolean {
  return pathCovers(a, b) || pathCovers(b, a);
}

/** Executables are basenames; only a bare `*` is wider than an exact name. */
function runCovers(floor: string, requested: string): boolean {
  if (floor === "*") return true;
  if (requested === "*") return false;
  return floor === requested;
}

function runOverlaps(a: string, b: string): boolean {
  return runCovers(a, b) || runCovers(b, a);
}

const COVERS: Record<PermissionKind, (floor: string, requested: string) => boolean> = {
  net: hostCovers,
  run: runCovers,
  read: pathCovers,
  write: pathCovers,
};

const OVERLAPS: Record<PermissionKind, (a: string, b: string) => boolean> = {
  net: hostOverlaps,
  run: runOverlaps,
  read: pathOverlaps,
  write: pathOverlaps,
};

const KINDS: PermissionKind[] = ["net", "run", "read", "write"];

/**
 * Every grant in `permissions` the floor refuses.
 *
 * The floor never rewrites the agent file. It either lets the file's grants
 * stand exactly as written or refuses them by name, so reading the file still
 * tells you the agent's blast radius. Silently running with less than the file
 * says would break that, which is why this returns violations for a caller to
 * fail on rather than an intersected {@linkcode Permissions}.
 *
 * An axis the floor omits is unconstrained. A `deny` entry applies whether or
 * not the axis has an allow list, and matches on overlap in either direction:
 * a file granting `*.example.com` is refused by a deny of `evil.example.com`,
 * because the grant could reach it.
 */
export function floorViolations(
  permissions: Permissions | undefined,
  floor: PermissionFloor,
): FloorViolation[] {
  const violations: FloorViolation[] = [];
  if (!permissions) return violations;
  for (const kind of KINDS) {
    for (const requested of permissions[kind] ?? []) {
      const denied = (floor.deny?.[kind] ?? []).find((d) => OVERLAPS[kind](d, requested));
      if (denied !== undefined) {
        violations.push({ kind, requested, deniedBy: denied });
        continue;
      }
      const allowed = floor[kind];
      if (allowed && !allowed.some((f) => COVERS[kind](f, requested))) {
        violations.push({ kind, requested });
      }
    }
  }
  return violations;
}

/** One violation as a line an operator can act on. */
export function describeViolation(v: FloorViolation, source: string): string {
  return v.deniedBy !== undefined
    ? `permissions.${v.kind} asks for "${v.requested}", which ${source} denies ` +
      `(deny.${v.kind}: "${v.deniedBy}")`
    : `permissions.${v.kind} asks for "${v.requested}", which is not covered by ` +
      `${source}'s ${v.kind} list`;
}

/** Parse a floor file. Throws with a readable message on invalid YAML or shape. */
export function parseFloor(yamlText: string, source: string): PermissionFloor {
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch (err) {
    throw new Error(`${source} is not valid YAML: ${(err as Error).message}`);
  }
  // An empty file is a floor that constrains nothing, which is a reasonable
  // thing to deploy as a placeholder.
  if (data === null || data === undefined) return {};
  const result = FloorSchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`${source} is not a valid permission floor: ${detail}`);
  }
  return result.data;
}

/**
 * The floor in effect, or undefined when there is none. Reads
 * {@linkcode FLOOR_ENV} when set, otherwise {@linkcode DEFAULT_FLOOR_PATH}.
 *
 * A path named explicitly in the env var that cannot be read is an error: an
 * operator who pointed at a policy file should not get an unpoliced agent
 * because of a typo. The default path missing is not an error, because that is
 * every developer on their own machine.
 */
export async function loadFloor(
  env: (key: string) => string | undefined = Deno.env.get,
): Promise<{ floor: PermissionFloor; source: string } | undefined> {
  const explicit = env(FLOOR_ENV);
  const path = explicit ?? DEFAULT_FLOOR_PATH;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (explicit === undefined && err instanceof Deno.errors.NotFound) return undefined;
    throw new Error(
      `cannot read the permission floor at ${path}: ${(err as Error).message}` +
        (explicit !== undefined ? ` (${FLOOR_ENV} names it)` : ""),
    );
  }
  return { floor: parseFloor(text, path), source: path };
}
