-- 0182_s13_audit_embed_webhooks_framework_help.sql
--
-- S13 (2026-10-16): help rows for the P0-Z batch 2 UI tails.
--   FR1/FU-B2  audit page: 9 new keys (admin.audit.*), bumps admin.audit v2,
--              admin.audit.archives v2, admin.audit.export.format v3 (the old text said
--              "available soon"; the page exists since RW-25 and now has JSONL export and archive).
--   RV44/FU-B14 embed page: 6 new keys (admin.embed.*).
--   FU-B7      webhooks page: 6 new keys (admin.webhooks.*), bump admin.webhooks.events v2
--              (three business events). RW-25 bell: admin.notifications.bell.
--   RW-61      framework tree picker: 4 keys under the four page prefixes.
--   Z-3        candidate.shell.new_results_notice.
-- The pages used hyphenated ids (admin.audit-log.*, admin.embed-config.*) that isValidHelpKey
-- rejects (RCA 2026-10-03 class); they are renamed in the same commit, so no old rows exist.
-- Mirrors content/en/*.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit',
  'admin',
  'en',
  'Every change made in your organisation, with who made it and when. Filter, export and archive the log here.',
  $$## Audit log

AssessIQ records every significant administrative action in an append-only log: user changes, grading overrides, certificate operations and setting updates.

- **Filter.** Set a From date, a To date and an entity type.
- **Export.** Download the filtered view as CSV or JSONL. One export holds up to 100,000 rows.
- **Archive.** Mark a date range as archived and download it. The system never deletes audit rows.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.archives',
  'admin',
  'en',
  'Archive marks a date range in the audit trail and downloads it as JSONL. Rows stay in the log.',
  $$## Archive a date range

1. Set a From date and a To date.
2. Select **Archive range** and confirm.

The system adds one `audit.archived` entry to the trail and starts a JSONL download of the range. It never deletes or changes audit rows. Long-term storage outside AssessIQ is not built in this release.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.export.format',
  'admin',
  'en',
  'CSV opens in a spreadsheet. JSONL has one JSON object per line for SIEM tools. Both use your filters.',
  $$## Export formats

- **CSV.** One row per event. Open it in a spreadsheet.
- **JSONL.** One JSON object per line, with the full before and after payloads. Use it for SIEM tools.

Both exports use the filters that you set. One export holds up to 100,000 rows, newest first. The system records each export in the audit trail as `audit.exported`.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.events',
  'admin',
  'en',
  'Choose the events that this endpoint receives.',
  $$## Webhook events

Check each event that you want to receive.

| Event | Fires when |
|---|---|
| `attempt.submitted` | A candidate submits an attempt. |
| `attempt.graded` | A grade is ready for an attempt. |
| `result.released` | You release a result to the candidate. |

Your server receives one signed POST request for each event.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.page',
  'admin',
  'en',
  'The audit log page. Filter the log, export it, or archive a date range.',
  $$## Audit log page

This page lists every recorded administrative action in your organisation. Use the filters to narrow the list. Use **Export CSV** or **Export JSONL** to download the filtered view. Use **Archive range** to mark a date range and download it.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.filters',
  'admin',
  'en',
  'Narrow the list by date range and entity type. Exports use the same filters.',
  $$## Filters

Set a From date, a To date and an entity type. The table and both exports use the same filters.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.date_from',
  'admin',
  'en',
  'Show events on or after this date.',
  $$## From date

The list and the exports show events on or after this date. Leave it empty to start from the oldest event.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.date_to',
  'admin',
  'en',
  'Show events on or before this date.',
  $$## To date

The list and the exports show events on or before this date. Leave it empty to end at the newest event.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.entity_type',
  'admin',
  'en',
  'Show events for one kind of record, for example users or attempts.',
  $$## Entity type

Pick one kind of record to see only its events, for example users, attempts or settings. Pick **All entities** to clear the filter.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.table',
  'admin',
  'en',
  'One row per recorded action: when, who, what action and which record.',
  $$## Audit table

Each row is one recorded action. The columns show the time, the actor, the action name, the record type and the record id. The newest rows come first.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.export_jsonl',
  'admin',
  'en',
  'Download the audit log as a JSONL file.',
  $$## Export JSONL

Use this to get the audit log as JSON Lines. Each line is one event. The file uses the same date and entity filters that you set. It holds up to 100,000 rows.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.archive',
  'admin',
  'en',
  'Mark a date range as archived and download it.',
  $$## Archive range

Choose a From date and a To date. Select **Archive range** and confirm. The system adds one entry to the audit trail and starts a JSONL download of the range. The system never deletes audit rows.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.truncated_note',
  'admin',
  'en',
  'The export stops at 100,000 rows.',
  $$## Export limit

One export holds at most 100,000 rows. If your range has more rows, the file holds the newest 100,000. Narrow the date range and export again to get the rest.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.embed.page',
  'admin',
  'en',
  'Embed settings: signing secrets, allowed host origins and the integration snippet.',
  $$## Embed settings

Use this page to let your own website or portal show an assessment inside a frame.

- **Embed signing secrets** sign the tokens that your server creates.
- **Allowed origins** list the websites that may show the frame.
- **Integration snippet** gives you the code to add to your page.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.embed.secrets_list',
  'admin',
  'en',
  'These secrets sign the embed tokens your server creates. Create, rotate or delete them here.',
  $$## Embed signing secrets

Your server signs each embed token with an active secret. **Rotate** makes a new secret. The old one still works for 24 hours. **Delete** stops a secret at once. You need a recent two-factor check to change secrets.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.embed.secret_once',
  'admin',
  'en',
  'Store the new secret now. It is not shown again.',
  $$## New secret

AssessIQ shows a new secret only one time. Copy it to the secret store of your server. If you lose it, rotate to make a new one.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.embed.snippet',
  'admin',
  'en',
  'Copy this code to add the assessment to your site.',
  $$## Integration snippet

Add the script tag and the mount call to your page. Your server must create the token. See the integration guide for the token format.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.embed.webhook_secret',
  'admin',
  'en',
  'The key that signs webhook requests to your endpoints. Regenerate shows the new key once.',
  $$## Webhook secret

AssessIQ signs each webhook request with this key. Select **Regenerate** to make a new key. The new key is shown one time. Update your server before the old key stops.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.embed.origins',
  'admin',
  'en',
  'Websites that may show the assessment in a frame, as scheme and host, for example https://portal.example.com.',
  $$## Allowed origins

Add each website that may show the assessment in a frame. Enter the scheme and the host only, for example `https://portal.example.com`. A website that is not in this list cannot show the frame. Select **Save** to apply your changes.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.notifications.bell',
  'admin',
  'en',
  'Notices for you: results ready to publish and failed webhook deliveries. Select one to open it.',
  $$## Notifications

The bell shows the count of unread notices. Select the bell to read them. A notice tells you when a result is ready to publish or when a webhook delivery fails. Select a notice to open the related page and mark it read.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.page',
  'admin',
  'en',
  'Register endpoints that receive signed POST requests for assessment events, and review deliveries.',
  $$## Webhooks page

Register an HTTPS endpoint, choose its events and copy its signing secret. The delivery log shows every request with its status and attempt count. You can send a test event and replay a failed delivery.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.endpoints',
  'admin',
  'en',
  'Your registered endpoints with their events. Test sends a sample event. Delete removes the endpoint.',
  $$## Endpoints

Each row is one registered endpoint with its events. **Test** sends a sample event to it. **Delete** removes the endpoint and stops all deliveries to it.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.name',
  'admin',
  'en',
  'A short name for this endpoint, for example HR system.',
  $$## Endpoint name

Give the endpoint a short name that tells your team which system receives the events, for example HR system. The name appears in the delivery log.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.url',
  'admin',
  'en',
  'The HTTPS address that receives the POST requests. Private network addresses are refused.',
  $$## Endpoint URL

Enter a public HTTPS address. AssessIQ refuses private or internal network addresses. The request carries a signature header that your server checks with the signing secret.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.delivery_filter',
  'admin',
  'en',
  'Show only the deliveries with one status.',
  $$## Delivery filter

Select a status to filter the delivery log. Select **All** to see every delivery. The filter applies to the loaded list only. The export file contains all deliveries.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.secret_once',
  'admin',
  'en',
  'The signing secret shows once. Copy it now.',
  $$## Signing secret

The system shows the signing secret one time, after you create the endpoint. Select **Copy secret** and store it in a safe place. You use it to check the signature on each event. If you lose it, delete the endpoint and create a new one.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.framework_nodes',
  'admin',
  'en',
  'Link this question to curriculum framework nodes.',
  $$## Framework nodes

Pick the framework nodes that this question covers. Use the search box to find a node by name or code. Open a node to see its children. Your choice saves when you tick or clear a box. Only the platform team can change nodes; organisation admins can view them.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.framework_filter',
  'admin',
  'en',
  'Show only questions that match a framework node.',
  $$## Framework filter

Pick a node to filter the questions in this question set. The list shows questions linked to that node or to any node below it. Clear the box to show all questions again. This filter does not change any question.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.generate_wizard.framework_pick',
  'admin',
  'en',
  'Fill the topic focus from a framework node.',
  $$## Pick from a framework

Pick a node to copy its name into **Topic focus**. For a unit or an outcome, the text starts with the parent name. You can edit the text after you pick. This step is optional and adds no new generation setting.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.blueprint.framework_pick',
  'admin',
  'en',
  'Choose a subject through a framework node.',
  $$## Subject from a framework

Pick a subject node to select its matching subject above. The blueprint still uses the subject for its question draw. If no question set uses the node, a note tells you. You can always choose the subject from the list instead.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.shell.new_results_notice',
  'candidate',
  'en',
  'You have new published results. Open Results to see them.',
  $$## New results

This banner shows when your organisation publishes a new result for you. It shows the count of results that you have not seen yet. Select **View results** to open the list. The banner goes away after you open the Results page.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
