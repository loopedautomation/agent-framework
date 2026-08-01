import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  DEFAULT_FLOOR_PATH,
  describeViolation,
  FLOOR_ENV,
  floorViolations,
  loadFloor,
  parseFloor,
  type PermissionFloor,
} from "./floor.ts";

const refused = (perms: Parameters<typeof floorViolations>[0], floor: PermissionFloor) =>
  floorViolations(perms, floor).map((v) => `${v.kind}:${v.requested}`);

Deno.test("an axis the floor omits is unconstrained", () => {
  const floor: PermissionFloor = { run: ["gh"] };
  assertEquals(
    refused({ run: ["gh"], net: ["anything.example.com"], write: ["/tmp"] }, floor),
    [],
  );
});

Deno.test("run is matched by exact basename, and only * is wider", () => {
  assertEquals(refused({ run: ["gh", "git"] }, { run: ["gh", "git", "jq"] }), []);
  assertEquals(refused({ run: ["curl"] }, { run: ["gh"] }), ["run:curl"]);
  // A file asking for everything is refused by a floor that named names.
  assertEquals(refused({ run: ["*"] }, { run: ["gh"] }), ["run:*"]);
  // A floor of * permits anything, including the file's own wildcard.
  assertEquals(refused({ run: ["*"] }, { run: ["*"] }), []);
});

Deno.test("net covers subdomains downward and never upward", () => {
  const floor: PermissionFloor = { net: ["*.example.com", "api.github.com"] };
  assertEquals(refused({ net: ["a.example.com"] }, floor), []);
  assertEquals(refused({ net: ["*.eu.example.com"] }, floor), []);
  assertEquals(refused({ net: ["*.example.com"] }, floor), []);
  assertEquals(refused({ net: ["api.github.com"] }, floor), []);

  // The apex is not a subdomain, matching the engine's own rule.
  assertEquals(refused({ net: ["example.com"] }, floor), ["net:example.com"]);
  // A file cannot widen a floor's exact host into a wildcard.
  assertEquals(refused({ net: ["*.github.com"] }, floor), ["net:*.github.com"]);
  assertEquals(refused({ net: ["evil.com"] }, floor), ["net:evil.com"]);
  assertEquals(refused({ net: ["*"] }, floor), ["net:*"]);
  // A floor of * is the operator declining to constrain the axis.
  assertEquals(refused({ net: ["*"] }, { net: ["*"] }), []);
});

Deno.test("paths are covered by prefix, in one direction", () => {
  const floor: PermissionFloor = { write: ["/data"], read: ["/data", "/etc/ssl"] };
  assertEquals(refused({ write: ["/data"], read: ["/data/in", "/etc/ssl"] }, floor), []);
  assertEquals(refused({ write: ["/data/runs/2026"] }, floor), []);
  // Broader than the floor, so refused rather than quietly narrowed.
  assertEquals(refused({ write: ["/"] }, floor), ["write:/"]);
  assertEquals(refused({ write: ["/etc"] }, floor), ["write:/etc"]);
  // A prefix that only looks like a child.
  assertEquals(refused({ write: ["/database"] }, floor), ["write:/database"]);
});

Deno.test("deny applies whether or not the axis has an allow list", () => {
  // No run allow list at all: everything is permitted except what deny names.
  const floor: PermissionFloor = { deny: { run: ["sudo", "curl"] } };
  assertEquals(refused({ run: ["gh", "jq"] }, floor), []);
  assertEquals(refused({ run: ["gh", "sudo"] }, floor), ["run:sudo"]);
  // A wildcard grant reaches the denied executable, so it is refused too.
  assertEquals(refused({ run: ["*"] }, floor), ["run:*"]);
});

Deno.test("deny wins over an allow list that would have permitted the grant", () => {
  const floor: PermissionFloor = { run: ["gh", "sudo"], deny: { run: ["sudo"] } };
  const violations = floorViolations({ run: ["sudo"] }, floor);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].deniedBy, "sudo");
});

Deno.test("a denied host is refused through any grant that could reach it", () => {
  const floor: PermissionFloor = { deny: { net: ["metadata.google.internal"] } };
  assertEquals(refused({ net: ["metadata.google.internal"] }, floor), [
    "net:metadata.google.internal",
  ]);
  // The wildcard could resolve to the denied host, so it goes too.
  assertEquals(refused({ net: ["*.google.internal"] }, floor), ["net:*.google.internal"]);
  assertEquals(refused({ net: ["*"] }, floor), ["net:*"]);
  // An unrelated host is untouched.
  assertEquals(refused({ net: ["api.github.com"] }, floor), []);
});

Deno.test("a denied path is refused through a parent grant", () => {
  const floor: PermissionFloor = { deny: { read: ["/run/secrets"] } };
  assertEquals(refused({ read: ["/run/secrets"] }, floor), ["read:/run/secrets"]);
  // Granting the parent would reach the denied directory.
  assertEquals(refused({ read: ["/run"] }, floor), ["read:/run"]);
  assertEquals(refused({ read: ["/run/other"] }, floor), []);
});

Deno.test("undefined permissions ask for nothing and violate nothing", () => {
  assertEquals(floorViolations(undefined, { run: ["gh"], deny: { run: ["sh"] } }), []);
  assertEquals(floorViolations({}, { run: ["gh"] }), []);
});

Deno.test("violations say which floor entry refused them", () => {
  const denied = floorViolations({ run: ["sudo"] }, { deny: { run: ["sudo"] } })[0];
  assertEquals(
    describeViolation(denied, "/etc/af/floor.yaml"),
    'permissions.run asks for "sudo", which /etc/af/floor.yaml denies (deny.run: "sudo")',
  );
  const uncovered = floorViolations({ net: ["evil.com"] }, { net: ["api.github.com"] })[0];
  assertEquals(
    describeViolation(uncovered, "/etc/af/floor.yaml"),
    'permissions.net asks for "evil.com", which is not covered by /etc/af/floor.yaml\'s net list',
  );
});

Deno.test("parseFloor rejects a shape it does not recognize", () => {
  assertEquals(parseFloor("", "f.yaml"), {});
  assertEquals(parseFloor("run: [gh]", "f.yaml"), { run: ["gh"] });
  // Unknown keys fail here for the same reason they fail in an agent file: a
  // misspelled policy that loads is worse than one that does not.
  assertThrows(() => parseFloor("rn: [gh]", "f.yaml"), Error, "not a valid permission floor");
  assertThrows(() => parseFloor("run: gh", "f.yaml"), Error, "not a valid permission floor");
  assertThrows(() => parseFloor("run: [", "f.yaml"), Error, "not valid YAML");
});

Deno.test("loadFloor is absent by default and loud when a named file is missing", async () => {
  // No env var, and the default path does not exist on a dev machine.
  assertEquals(await loadFloor(() => undefined), undefined);

  const path = await Deno.makeTempFile({ suffix: ".yaml" });
  await Deno.writeTextFile(path, "run: [gh]\ndeny:\n  net: [metadata.google.internal]\n");
  const loaded = await loadFloor((k) => (k === FLOOR_ENV ? path : undefined));
  assertEquals(loaded?.floor.run, ["gh"]);
  assertEquals(loaded?.floor.deny?.net, ["metadata.google.internal"]);
  assertEquals(loaded?.source, path);
  await Deno.remove(path);

  // A typo in the env var must not silently produce an unpoliced agent.
  await assertRejects(
    () => loadFloor((k) => (k === FLOOR_ENV ? "/nonexistent/floor.yaml" : undefined)),
    Error,
    "cannot read the permission floor",
  );
});

Deno.test("an unreadable default path does not stop the agent, and says so", async () => {
  // What the sandboxed image actually produces: the runtime's narrowed Deno
  // flags make /etc/af/floor.yaml unreadable, so readTextFile throws
  // PermissionDenied rather than NotFound. Treating only NotFound as "no
  // floor" took the whole agent down at startup.
  const warnings: string[] = [];
  const denied = await loadFloor(() => undefined, (m) => warnings.push(m));
  // With no env var set the real default path is missing on a dev machine,
  // which is the silent case: absent means no floor and nothing to say.
  assertEquals(denied, undefined);
  assertEquals(warnings, []);
});

Deno.test("a floor that exists and cannot be read is never silent", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/floor.yaml`;
  await Deno.writeTextFile(path, "run: [gh]\n");
  // Simulate the sandbox refusing the default path: the loader is handed an
  // env lookup that produces no explicit path, and a reader that denies.
  const realRead = Deno.readTextFile;
  const warnings: string[] = [];
  try {
    // deno-lint-ignore no-explicit-any
    (Deno as any).readTextFile = () => {
      throw new Deno.errors.PermissionDenied(`Requires read access to "${DEFAULT_FLOOR_PATH}"`);
    };
    const loaded = await loadFloor(() => undefined, (m) => warnings.push(m));
    // The agent still starts: a floor it cannot read must not be fatal.
    assertEquals(loaded, undefined);
    // But it is named, because a floor that applies to nobody is the exact
    // silence this feature exists to remove.
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes(DEFAULT_FLOOR_PATH));
    assert(warnings[0].includes("could not be read"));
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).readTextFile = realRead;
    await Deno.remove(dir, { recursive: true });
  }
});
