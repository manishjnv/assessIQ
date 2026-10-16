// RW-58/59: upload caps shared by parse.ts and the adapters (kept apart to avoid an import cycle).
// RW-97: 4 MB, the same cap as the route bodyLimit, the multipart fileSize limit and the UI check.
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 2000;
