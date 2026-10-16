// AssessIQ — modules/18-certification/src/logo-pattern.ts
// Dependency-free so pdf/template.ts can use it without pulling in tenancy.

/** Only PNG/JPEG base64 survives, so the value is safe in a quoted attribute / SVG href. */
export const SAFE_LOGO_DATA_URI = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
