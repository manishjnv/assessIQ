/**
 * Mirror the brand kit into apps/web/public/brand/ at predev / prebuild time.
 *
 * Source of truth: modules/17-ui-system/AccessIQ_UI_Template/Logo/{favicon,logo,social}/
 * Vite serves apps/web/public/ at the site root, so files appear at /brand/...
 *
 * The destination folder is gitignored — never edit it directly. To update an
 * asset, edit the SVG in the kit, run `pnpm --filter @assessiq/ui-system
 * brand:regen` for the PNGs, then `pnpm --filter @assessiq/web dev|build`
 * which re-runs this script via the predev/prebuild hooks.
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "..", "modules", "17-ui-system", "AccessIQ_UI_Template", "Logo");
const dst = resolve(here, "..", "public", "brand");

const folders = ["favicon", "logo", "social"];

for (const folder of folders) {
  await mkdir(resolve(dst, folder), { recursive: true });
  const entries = await readdir(resolve(src, folder));
  for (const entry of entries) {
    await copyFile(resolve(src, folder, entry), resolve(dst, folder, entry));
  }
  console.log(`mirrored ${entries.length.toString().padStart(2)} → public/brand/${folder}/`);
}
