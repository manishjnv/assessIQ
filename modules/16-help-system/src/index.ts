export type { Audience, HelpEntry, HelpReadEnvelope, UpsertHelpInput } from "./types.js";
export {
  getHelpForPage,
  getHelpKey,
  upsertHelpForTenant,
  exportHelp,
  importHelp,
  recordHelpEvent,
  shouldSampleHelpEvent,
} from "./service.js";
export { registerHelpPublicRoutes } from "./routes-public.js";
export { registerHelpAuthRoutes } from "./routes-auth.js";
export type { HelpAuthDeps } from "./routes-auth.js";
export { registerHelpAdminRoutes } from "./routes-admin.js";
export type { HelpAdminDeps } from "./routes-admin.js";
export { registerHelpTrackRoutes } from "./routes-track.js";
