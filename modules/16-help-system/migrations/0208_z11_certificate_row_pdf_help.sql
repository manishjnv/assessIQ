-- 0208_z11_certificate_row_pdf_help.sql
--
-- Z-11 item (b) (2026-10-19): help row for the PDF link in each row of
-- /admin/certificates.
--   NEW admin.certificates.row_pdf
-- Mirrors content/en/admin.yml. Idempotent: INSERT ... ON CONFLICT DO NOTHING. New key only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.certificates.row_pdf',
  'admin',
  'en',
  'Open the certificate as a PDF in a new tab, without opening the details.',
  $$## PDF from the list

The **PDF** link in a row opens the certificate PDF in a new tab. The details panel does not open.

- **Same file.** It is the same PDF as **Download PDF** in the details panel.
- **Revoked certificates have no link.** The server does not render a PDF for them.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
