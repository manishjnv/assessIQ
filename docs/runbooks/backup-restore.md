# Backup and restore test

**Reader:** the product owner or an operator with `ssh assessiq-vps` access.
**Last checked against:** `docs/06-deployment.md` (sections Backups and Restore), 2026-10-19.
**Script:** `tools/backup-restore-test.sh`

## Purpose

- Prove that a fresh dump of the production database restores into a clean Postgres.
- Measure the dump time, the restore time and the dump size.
- Compare row counts between production and the restored copy.

The test never writes to `assessiq-postgres`. It never copies the dump off the VPS. It prints row counts only, never row data.

## What the backups cover

> [!WARNING]
> Check this list against the live VPS before you rely on it. Items marked "not verified" come from `docs/06-deployment.md` and were not checked on the VPS for this runbook.

| Item | Covered? | Source and note |
| --- | --- | --- |
| Hostinger weekly VPS snapshot | Yes, whole disk | Owner enabled it. Worst case loss is about 7 days if the VPS is lost. |
| Daily `pg_dump` in `/var/backups/assessiq/` | Yes, on the same disk | `docs/06-deployment.md` says the cron `/etc/cron.daily/assessiq-backup` is installed (2026-10-01). Not verified in this runbook. The snapshot carries these files off the disk only once a week. |
| Off-site dump copy (rclone) | Not verified | The deployment doc lists an rclone line. The same doc says the owner has not wired the credentials. |
| `ASSESSIQ_MASTER_KEY` | **No** | Lives in `/srv/assessiq/.env`. The dump does not hold it. Without it you cannot read the encrypted columns after a restore. Keep a copy off the box (password manager). |
| `/srv/assessiq/.env` and `/srv/assessiq/secrets/*.txt` | Snapshot only | Never copied off-site on purpose. Rebuild from the password manager. |
| Uploaded files and logs in `/var/log/assessiq` | Snapshot only | No separate backup. Not verified whether the app stores any other files. |
| Redis (sessions, queues, rate limits) | No, on purpose | You can lose it. Users sign in again. |
| Caddy config | Snapshot only | The shared Caddyfile is outside the AssessIQ scope. The AssessIQ block is copied in `infra/caddyfile/assessiq.snippet`. |
| Application code | Yes | GitHub `manishjnv/assessIQ`. |

## How to run the test

1. Open Git Bash in the repo root on your laptop.
2. Make sure `ssh assessiq-vps` works without a prompt.
3. Run the dry run. It prints the remote commands and makes no ssh call.

   ```bash
   bash tools/backup-restore-test.sh --dry-run
   ```

4. Read the printed commands. Check that every name starts with `assessiq-`.
5. Run the real test. It takes a few minutes.

   ```bash
   bash tools/backup-restore-test.sh
   ```

6. Fill the results table below.

Options:

- `--dry-run`: print commands, no ssh.
- `--keep`: skip cleanup, for debugging. Clean up by hand afterwards (see the section on interruptions).

## What the test checks

1. **Preflight (read only).** `assessiq-postgres` is healthy. Free disk is at least 3 times the database size on `/srv/assessiq` and `/var/lib/docker`. No container or volume named `assessiq-restore-test` exists. If one exists, the script stops and deletes nothing.
2. **Dump.** `pg_dump -Fc` inside the VPS to `/srv/assessiq/tmp-backup-test/<UTC-timestamp>.dump` (directory 0700, file 0600).
3. **Restore.** A temporary container `assessiq-restore-test` with the same image as production, its own volume `assessiq-restore-test-data`, `--network none` (no ports, no production network, no env file) and a random password that is never printed. The script creates the roles `assessiq_app` and `assessiq_system` first. Then it runs `pg_restore --no-owner --no-privileges`.
4. **Counts.** Compares `tenants`, `users`, `assessments`, `attempts`, `audit_log` and `schema_migrations`.
5. **Cleanup.** A trap removes the container, the volume, the dump and the directory. It removes only what the run created.

Count rules (production changes while the test runs):

- `schema_migrations`, `tenants`, `users`, `assessments`: restore must equal production.
- `attempts`, `audit_log`: restore must be less than or equal to production.
- Any other result is a MISMATCH. The script exits with code 1.

## Expected output

- A line `DUMP_SECS=<n> DUMP_BYTES=<n>`.
- A line `RESTORE_SECS=<n> RESTORE_RC=<n> RESTORE_ERRORS=<n>`.
- A table with the columns table, prod, restore, result.
- `verdict: PASS` and exit code 0.

A `pg_restore` error count above 0 prints a warning. The count comparison decides the verdict. Look at the first error lines. With `--no-owner --no-privileges`, a clean run is expected to show 0 errors (the 2026-10-01 drill in `docs/06-deployment.md` had 0 errors).

## Measured results

| Run date (UTC) | Database size (bytes) | Dump size (bytes) | Dump time (s) | Restore time (s) | pg_restore errors | tenants | users | assessments | attempts | audit_log | schema_migrations | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-19 ~09:25 | 22,338,583 | 1,775,816 | 0 (under 1) | 3 | 0 | 6 | 12 | 8 | 6 | 1067 | 184 | PASS (all MATCH) |

## Restore for real in an emergency

> [!WARNING]
> Do not restore into `assessiq-postgres` while it holds data you want. Restore into a new container first, check it, then swap.

1. Pick the newest good dump. Use `/var/backups/assessiq/assessiq-*.dump`. Verified 2026-10-19: files are plain `.dump` (custom format), one a day at 06:25 UTC, root-owned mode 0600, 10 days kept at least, newest 1.77 MB. Same host and disk as production: no protection from loss of the VPS.
2. Get `ASSESSIQ_MASTER_KEY` from the password manager. Put it in `/srv/assessiq/.env` if the file is lost.
3. Start a new container with a new name, for example `assessiq-postgres-new`, the production image tag and a new volume. Use the commands in step 3 of the script as a model.
4. Create the roles `assessiq_app` and `assessiq_system` (the second with `BYPASSRLS`).
5. Run `pg_restore -U assessiq -d assessiq --no-owner --no-privileges` from the dump.
6. Run the row-count query on the new container. Compare with the last known counts.
7. Align the role passwords with the files in `/srv/assessiq/secrets/` using `ALTER ROLE`. See "Backup inventory" in `docs/06-deployment.md`.
8. Stop the application containers (`assessiq-api`, `assessiq-worker`). Do not touch other containers on the shared VPS.
9. Swap: point the compose file at the restored volume, or rename it, and start `assessiq-postgres`. Keep the old volume until the application works.
10. Start `assessiq-api` and `assessiq-worker`. Run `bash tools/post-deploy-sweep.sh`.

Always keep the old volume until you confirm the new database works.

## If the script stops early

The trap cleans up on failure. If your session dies (power loss, closed laptop), clean up by hand. Run each command only after you check the name.

```bash
ssh assessiq-vps 'docker ps -a --filter name=assessiq-restore-test'
ssh assessiq-vps 'docker rm -f assessiq-restore-test'
ssh assessiq-vps 'docker volume rm assessiq-restore-test-data'
ssh assessiq-vps 'rm -f /srv/assessiq/tmp-backup-test/*.dump /srv/assessiq/tmp-backup-test/restore.err; rmdir /srv/assessiq/tmp-backup-test'
```

> [!WARNING]
> Remove only the names above. Do not run `docker system prune` or any bulk cleanup on this shared VPS.

## What is not included

- No automated off-site dump. The owner decided to wait for the first paying customer and accepted the risk.
- No test of Redis, uploaded files, the Caddy config or the `.env` file.
- No point-in-time recovery. The dump is a single snapshot in time.
- The script does not copy the dump to the laptop.

## Reference

| Name | Value |
| --- | --- |
| SSH alias | `assessiq-vps` |
| Production container | `assessiq-postgres` (`postgres:16-alpine`, user `assessiq`, database `assessiq`) |
| Test container | `assessiq-restore-test` |
| Test volume | `assessiq-restore-test-data` |
| Dump directory | `/srv/assessiq/tmp-backup-test/` |
| Exit codes | 0 pass, 1 count mismatch, 2 preflight or usage error |
