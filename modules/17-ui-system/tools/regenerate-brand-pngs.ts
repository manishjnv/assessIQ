/**
 * Regenerate brand-kit PNGs from their SVG masters.
 *
 * Run: `pnpm --filter @assessiq/ui-system brand:regen`
 *
 * Whenever an SVG under AccessIQ_UI_Template/Logo/{logo,favicon,social}/
 * changes (typo fix, recolor, mark redesign, tenant-pack accent), rerun this
 * to keep the rasterized PNG variants in sync. PNGs are committed because
 * favicons and OG cards are served as raw assets without a build-time
 * rasterizer in the deploy pipeline.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const kit = resolve(here, "..", "AccessIQ_UI_Template", "Logo");

interface Job {
  src: string;
  out: string;
  width: number;
  height: number;
}

const jobs: Job[] = [
  { src: "logo/assessiq-mark.svg",            out: "logo/assessiq-mark-512.png",      width:  512, height:  512 },
  { src: "logo/assessiq-horizontal.svg",      out: "logo/assessiq-horizontal.png",    width: 1280, height:  256 },
  { src: "logo/assessiq-horizontal-dark.svg", out: "logo/assessiq-horizontal-dark.png", width: 1280, height: 256 },
  { src: "logo/assessiq-stacked.svg",         out: "logo/assessiq-stacked.png",       width: 1000, height:  800 },

  { src: "favicon/favicon.svg",          out: "favicon/favicon-16.png",          width:   16, height:   16 },
  { src: "favicon/favicon.svg",          out: "favicon/favicon-32.png",          width:   32, height:   32 },
  { src: "favicon/favicon.svg",          out: "favicon/favicon-48.png",          width:   48, height:   48 },
  { src: "favicon/app-icon-1024.svg",    out: "favicon/apple-touch-icon-180.png", width:  180, height:  180 },
  { src: "favicon/app-icon-1024.svg",    out: "favicon/app-icon-192.png",        width:  192, height:  192 },
  { src: "favicon/app-icon-1024.svg",    out: "favicon/app-icon-512.png",        width:  512, height:  512 },
  { src: "favicon/app-icon-1024.svg",    out: "favicon/app-icon-1024.png",       width: 1024, height: 1024 },
  { src: "favicon/app-icon-1024-dark.svg", out: "favicon/app-icon-1024-dark.png", width: 1024, height: 1024 },

  { src: "social/og-image.svg", out: "social/og-image.png", width: 1200, height: 630 },
];

async function render(job: Job): Promise<void> {
  const svg = await readFile(resolve(kit, job.src), "utf8");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: job.width },
    font: { loadSystemFonts: true },
  });
  const png = resvg.render().asPng();
  await writeFile(resolve(kit, job.out), png);
  console.log(`  ${job.out.padEnd(44)} ${job.width}×${job.height}  ${png.byteLength.toLocaleString()} B`);
}

console.log(`Regenerating ${jobs.length} PNG(s) from SVG masters under ${kit}\n`);
for (const job of jobs) {
  await render(job);
}
console.log(`\nDone. Commit the regenerated PNGs.`);
