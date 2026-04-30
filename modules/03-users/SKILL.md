# 03-users — User records, roles, invitations

## Purpose
Manage the `users` table: who exists in a tenant, what role they hold, lifecycle (invite → active → disabled → soft-delete). Pure record management — does NOT handle authentication (01-auth) or auth methods (01-auth).

## Scope
- **In:** user CRUD, role assignment, invitation issuance + tracking, bulk import (CSV), soft delete + restore.
- **Out:** authentication, password/TOTP credentials (01), tenant settings (02), permission checks beyond role (handled by `req.requireAuth(roles)`).

## Roles
- `admin` — full tenant control
- `reviewer` — can review and override AI grades, cannot change tenant settings or invite admins
- `candidate` — can take assigned assessments only

Future: `analyst` (read-only reports), `pack_author` (question-bank only). Add via DB enum extension + role check helper.

## Dependencies
- `00-core`
- `02-tenancy` — every user belongs to one tenant
- `13-notifications` — invitation emails

## Public surface
```ts
listUsers({ tenantId, role?, status?, search?, page, pageSize }): Promise<PaginatedUsers>
getUser(id): Promise<User>
createUser({ email, name, role, metadata }): Promise<User>
updateUser(id, patch): Promise<User>
softDelete(id): Promise<void>
restore(id): Promise<User>

inviteUser({ email, role, assessmentIds? }): Promise<{ user, invitation }>
acceptInvitation(token): Promise<{ user, sessionToken }>
bulkImport(csv: Buffer): Promise<ImportReport>
```

## Data model touchpoints
Owns: `users`, `user_invitations` (record-only fields; auth-bound fields like `token_hash` lifecycle in 01-auth).

## Help/tooltip surface
- `admin.users.role` — what each role can do
- `admin.users.status.disabled` — what happens to active sessions when disabled
- `admin.users.invite.bulk` — CSV format expected
- `admin.users.metadata.external_id` — how external_id flows through to webhooks

## Open questions
- SCIM 2.0 provisioning — Phase 3, when first enterprise client requires it (the IntelWatch pattern applies here)
- Role granularity — keep coarse for v1; add capability-based permissions in v2 only if needed
