-- EXP-14 phase 1 (design D3). A tenant session must not grant itself a licence.
-- WHAT  Remove INSERT on tenant_entitlements from the app role. Every real grant runs under the system
--       role (grantEntitlement, and provisionFreePlan on the caller system client), which keeps its right.
-- WHY   once licensed read exists (phase 2), a self-granted row would open the master question store.
-- Forward-only. Rollback: GRANT INSERT ON tenant_entitlements TO assessiq_app;
REVOKE INSERT ON tenant_entitlements FROM assessiq_app;
