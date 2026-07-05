// Copy each package's version from package.json (bumped by changesets)
// into its deno.json (the file JSR publishes from).
// Run via: deno task version (after `changeset version`).
const root = new URL("..", import.meta.url);
const rootConfig = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));

for (const dir of rootConfig.workspace as string[]) {
  const pkgUrl = new URL(`${dir}/package.json`, root);
  const denoUrl = new URL(`${dir}/deno.json`, root);
  const { version } = JSON.parse(await Deno.readTextFile(pkgUrl));
  const denoConfig = JSON.parse(await Deno.readTextFile(denoUrl));
  if (denoConfig.version === version) continue;
  denoConfig.version = version;
  await Deno.writeTextFile(denoUrl, JSON.stringify(denoConfig, null, 2) + "\n");
  console.log(`${denoConfig.name} → ${version}`);
}
