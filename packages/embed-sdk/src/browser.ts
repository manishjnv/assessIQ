// Browser entry for the CDN bundle (served at /embed/sdk.js).
// Keeps the public API of the old inline stub: window.AssessIQ.mount(sel, opts).
// __SDK_VERSION__ is replaced by esbuild `define` (see build.mjs).
import { AssessIQEmbed, AssessIQEmbedUrl } from './index.js';

declare const __SDK_VERSION__: string;

(window as unknown as { AssessIQ: unknown }).AssessIQ = {
  version: __SDK_VERSION__,
  mount: AssessIQEmbed.mount,
  buildUrl: AssessIQEmbedUrl,
};
