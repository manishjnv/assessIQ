# Org Logo Upload Feature — Design & Implementation Roadmap

**Date:** 2026-10-09  
**Owner Decisions:** D1 ✅ D2 ✅ D4 ✅ (D3 deferred)  
**Status:** superseded 2026-10-16 — open items are tracked in docs/ROADMAP.md § P0-Z (rows kept here for history). Was: Planning (ready for implementation in S1 hardening phase)  
**Cost:** $0 (zero dependencies, no paid services)  
**Effort:** 4–5 days (parallelizable into 2 sessions)

---

## Owner Decisions (Locked)

| Decision | Question | Answer | Impact |
|----------|----------|--------|--------|
| **D1** | Where should org logos appear? | Logo next to company name, always co-branded with "via AssessIQ" | 8 surfaces: admin, candidate pages, emails, certs, verify, social OG |
| **D2** | Logo for all tenants or only paid plans? | All tenants (no paywall) | Available to every org, no feature gating |
| **D3** | Show logo on candidate login selection? | NO (deferred) | Avoids customer list exposure; can add later |
| **D4** | Current logo or logo at cert issue time? | Current logo (simplest) | No logo history needed; HMAC unaffected |

---

## Architecture

### Storage: PostgreSQL BYTEA (zero cost, zero CDN)

```sql
tenant_logos {
  tenant_id: UUID (PK, FK tenants),
  mime: 'image/png' | 'image/jpeg',
  bytes: BYTEA (max 512 KB),
  sha256: TEXT (cache buster),
  width: INT (1–2048 px),
  height: INT (1–2048 px),
  updated_by: UUID (admin user),
  updated_at: TIMESTAMPTZ
}
```

### Serving
- **Public:** `/api/public/tenant-logo/<tenantId>?v=<sha256[0..12]>` (immutable cache)
- **Internal:** `getTenantLogoBytes(tenantId)` → data URI for emails/PDFs
- **Metadata:** `getTenantLogoMeta(tenantId)` → sha + mime (for URL generation)

### Validation
- **Format:** PNG and JPEG only (no SVG, no GIF, no WebP in MVP)
- **Size:** 512 KB max (decoded)
- **Dimensions:** 32–2048 px (prevents decompression bombs)
- **Check:** Magic bytes (not extension or MIME header)

### Security
- Tenant from session only (never from request body)
- RLS policies: `tenant_isolation` + `tenant_isolation_insert`
- Response headers: `X-Content-Type-Options: nosniff`, `CSP: default-src 'none'; sandbox`
- No stored URLs (computed from `tenant_logos` row)

---

## Implementation Roadmap

### Phase L1: Backend Storage (2 days, load-bearing)

**Blocked by:** Owner decisions D1–D4 ✅

**Create:**
- `modules/02-tenancy/migrations/0166_tenant_logos.sql` — BYTEA table + RLS
- `modules/02-tenancy/src/logo.ts` — validation (sniff + header parse)
- `apps/api/src/routes/public-tenant-logo.ts` — public GET with cache headers

**Modify:**
- `modules/02-tenancy/src/service.ts` — setTenantLogo(), removeTenantLogo(), getTenantLogoBytes(), getTenantLogoMeta()
- `modules/14-audit-log/src/types.ts` — 'tenant.logo.updated', 'tenant.logo.removed'
- `apps/api/src/routes/admin-tenant-settings.ts` — PUT/DELETE /logo endpoints
- `apps/api/src/routes/auth/whoami.ts` — add logo_url field

**Gate:** `codex:rescue` (02-tenancy is load-bearing + auth-adjacent)

**Tests:**
- Unit: sniff validation (PNG/JPEG pass, SVG/corrupt fail)
- Integration: set/replace/remove audit rows, RLS isolation
- Route: auth (403 candidate, 401 stale MFA), cache headers

---

### Phase L2: Admin Panel (1 day)

**Blocked by:** L1 complete

**Create:**
- `modules/17-ui-system/src/components/TenantLogo.tsx` — reusable component (28px high, fallback to text)

**Modify:**
- `modules/10-admin-dashboard/src/pages/tenant-settings.tsx` — file input + preview + error messages
- `modules/10-admin-dashboard/src/components/AdminShell.tsx` — show TenantLogo in header
- `modules/16-help-system/` — help ID `admin.tenant_settings.logo`

**Tests:**
- UI: reject wrong type before API call, preview updates, remove works
- AdminShell renders logo when set, name only when absent

---

### Phase L3a: Candidate Assessment Pages (1.5 days)

**Blocked by:** L1 complete

**Modify:**
- `apps/web/src/pages/take/TokenLanding.tsx` — header: `[LOGO 100×40px] Company Name`
- `apps/web/src/pages/take/Attempt.tsx` — top-left: `[LOGO 32×28px] Company Name`
- `apps/web/src/pages/take/Submitted.tsx` — above results: `[LOGO 60×40px]`
- `apps/api/src/routes/auth/candidate.ts` — add `company_logo_url` to token
- `modules/06-attempt-engine/src/service.ts` — add `company_logo_url` to view

**Tests:** Logo appears on all 3 pages, fallback works, no null errors

---

### Phase L3b: Email Branding (1 day)

**Blocked by:** L1 complete

**Modify:**
- `modules/03-users/src/invitations.ts` — candidate invitation email
- `modules/05-assessment-lifecycle/src/email.ts` — test started, result released
- `apps/api/src/worker.ts` — pass logoUrl to email context
- `modules/13-notifications/src/templates/*.html` — add logo in header (120×48px)
- `modules/13-notifications/src/send.ts` — inject logoUrl via data URI

**Email types:**
1. Candidate invitation
2. Test started
3. Result released
4. Attempt expiry warning
5. Admin alerts

**Tests:** Email HTML contains data URI, logo size reasonable, fallback works

---

### Phase L3c: Verify Page & Social (1 day)

**Blocked by:** L1 complete

**Modify:**
- `modules/18-certification/src/routes-public.ts` — renderVerifyPage + renderOgSvg
- `modules/18-certification/src/pdf/render.ts` — pass logoBytes to template

**Surfaces:**
1. **Verify page** (`/verify/<id>`): `Issued by [LOGO 80×32px] Company Name`
2. **OG social image** (LinkedIn): logo top-right in 1200×630 image
3. **Certificate PDF**: logo top-left, 18mm high

**Tests:** Verify page cache headers, OG image renders, PDF has data URI

---

### Phase L4: Admin PDF (0.5 days)

**Blocked by:** L1 complete

**Modify:**
- `modules/18-certification/src/pdf/template.ts` — embed logo as data URI

---

## Logo Display Map (8 Surfaces)

| Surface | Logo Size | Source | Cache | Notes |
|---------|-----------|--------|-------|-------|
| **1. TokenLanding** | 100×40px | Token logoUrl | 1h | First impression |
| **2. Attempt top bar** | 32×28px | Token logoUrl | 1h | Co-brand with AssessIQ |
| **3. Submitted page** | 60×40px | Token logoUrl | 1h | Test completion |
| **4. Admin dashboard** | 28×28px | Whoami logoUrl | 1h | Top bar header |
| **5. Admin settings** | 120×120px | Whoami logoUrl | 1h | Upload preview |
| **6. Email headers** | 120×48px | Data URI | 1h | All notifications |
| **7. Verify page** | 80×32px | Public GET `/api/public/tenant-logo/:id` | immutable | Public cert view |
| **8. Cert PDF** | 18mm height | Data URI | on-demand | Printed/downloadable |
| **9. OG social image** | 240×96px | Data URI in SVG | 1h | LinkedIn, WhatsApp |

---

## File Checklist (25 files)

**L1 Backend (7 files):**
- [ ] `modules/02-tenancy/migrations/0166_tenant_logos.sql`
- [ ] `modules/02-tenancy/src/logo.ts`
- [ ] `modules/02-tenancy/src/service.ts`
- [ ] `modules/14-audit-log/src/types.ts`
- [ ] `apps/api/src/routes/admin-tenant-settings.ts`
- [ ] `apps/api/src/routes/public-tenant-logo.ts`
- [ ] `apps/api/src/routes/auth/whoami.ts`

**L2 Admin (6 files):**
- [ ] `modules/17-ui-system/src/components/TenantLogo.tsx`
- [ ] `modules/10-admin-dashboard/src/pages/tenant-settings.tsx`
- [ ] `modules/10-admin-dashboard/src/session.ts`
- [ ] `modules/10-admin-dashboard/src/components/AdminShell.tsx`
- [ ] `modules/16-help-system/content/en/admin.yml`
- [ ] `modules/16-help-system/migrations/0167_help_tenant_logo.sql`

**L3a Candidate (5 files):**
- [ ] `apps/web/src/pages/take/TokenLanding.tsx`
- [ ] `apps/web/src/pages/take/Attempt.tsx`
- [ ] `apps/web/src/pages/take/Submitted.tsx`
- [ ] `apps/api/src/routes/auth/candidate.ts`
- [ ] `modules/06-attempt-engine/src/service.ts`

**L3b Email (5 files):**
- [ ] `modules/03-users/src/invitations.ts`
- [ ] `modules/05-assessment-lifecycle/src/email.ts`
- [ ] `apps/api/src/worker.ts`
- [ ] `modules/13-notifications/src/templates/*.html`
- [ ] `modules/13-notifications/src/send.ts`

**L3c Verify + L4 PDF (2 files):**
- [ ] `modules/18-certification/src/routes-public.ts`
- [ ] `modules/18-certification/src/pdf/template.ts`

**Docs (6 files):**
- [ ] `docs/02-data-model.md` (tenant_logos table)
- [ ] `docs/03-api-contract.md` (endpoints)
- [ ] `docs/08-ui-system.md` (TenantLogo component)
- [ ] `docs/10-branding-guideline.md` (amend section 2.11)
- [ ] `modules/18-certification/SKILL.md`
- [ ] `docs/SESSION_STATE.md` (handoff notes)

---

## Timeline & Parallelization

**Session 1 (2–3 days):**
- L1 (backend, 2 days) → Sonnet + Opus review + codex:rescue gate → push

**Session 2 (1–2 days):**
- L2, L3a, L3b, L3c, L4 in parallel (4 Sonnet agents, 1 day each)

**Total:** 4–5 days wall-clock, $0 cost

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| XSS via polyglot file | High | Sniff magic bytes. Serve with `CSP: default-src 'none'; sandbox` |
| Image bomb crashes PDF render | High | Cap 512 KB + 2048 px, read from header before store |
| Cross-tenant write | High | Tenant from session only. RLS. Route tests. |
| Fake logo on certs | Medium | `adminFreshMfa` (15 min) + audit trail + super-admin removal (later) |
| Logo injection via JSONB | Medium | Never render stored URL. Always compute from table. |
| Old certs show new logo | Low | Expected behavior (D4 decision). HMAC unaffected. |

---

## Dependencies

1. **No new npm packages** (use existing `pdfkit` for cert rendering if not already there)
2. **No infra changes** (Caddy already proxies `/api/*`)
3. **No Docker volume** (database handles storage)
4. **Database backups cover this** (tenant_logos in regular pg_dump)

---

## Next Steps

1. Owner approves D1–D4 (locked ✅)
2. L1 goes to Sonnet with this roadmap
3. Opus does line-by-line review of L1 diff
4. codex:rescue gates L1 before push
5. L2–L4 launch in parallel after L1 is live
