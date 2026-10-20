// modules/01-auth/src/signup-legal.ts
//
// Z-81: the ONE place that names the versions of the legal texts a self-serve sign-up
// accepts. The sign-up form sends dpaAccepted=true and dpaVersion; the server refuses a
// request unless dpaVersion equals DPA_VERSION. A new text means a new version string here
// and a matching change on the sign-up page, in the same deploy. The stored acceptance rows
// (tenant_legal_acceptances) keep the version the visitor actually ticked.

export const DPA_VERSION = "1.0";
export const TERMS_VERSION = "1.0";
