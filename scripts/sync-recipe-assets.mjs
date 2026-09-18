import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const source = path.join(repositoryRoot, "shared", "recipes");
const destination = path.join(repositoryRoot, "home", "public", "shared", "recipes");
const generatedAssetsRoot = path.join(repositoryRoot, "home", "public", "shared");

if (!destination.startsWith(`${generatedAssetsRoot}${path.sep}`)) {
  throw new Error("Refusing to sync outside the generated shared-assets directory.");
}

await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

console.log(`Synced recipe assets to ${path.relative(repositoryRoot, destination)}`);
