// Builds the CDN bundle served by apps/api at GET /embed/sdk.js (RV44).
// esbuild comes from the workspace root (transitive dep of vite); no new dependency.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
// esbuild is not a direct dependency (lockfile must not change): resolve the copy
// that vite (apps/web) pulls in, so CI and local builds use the same locked version.
const webRequire = createRequire(resolve(root, "apps/web/package.json"));
const viteRequire = createRequire(webRequire.resolve("vite/package.json"));
const { build } = viteRequire("esbuild");

const { version } = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));
export const outfile = resolve(root, "apps/api/public/embed/sdk.js");

export const buildOptions = {
  entryPoints: [resolve(here, "src/browser.ts")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2018",
  banner: { js: `/* @assessiq/embed ${version} */` },
  define: { __SDK_VERSION__: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "error",
  outfile,
  write: false,
};

export async function render() {
  const r = await build(buildOptions);
  return r.outputFiles[0].text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = await render();
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, text);
  process.stdout.write(`built ${outfile} (${Buffer.byteLength(text)} bytes)
`);
}
