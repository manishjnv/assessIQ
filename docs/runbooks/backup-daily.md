# Daily off-site backup (ready, not switched on)

**Reader:** the product owner or an operator with `ssh assessiq-vps` access.
**Script:** `tools/backup-daily.sh`. **Local proof:** `tools/test-backup-daily.sh`.
**Status:** built and proven locally with a local folder as target. Not tested against a real R2 bucket. The owner switches it on at the first paying customer. Until then the Hostinger weekly snapshot is the accepted off-site copy.

## What it does

1. Checks that `assessiq-postgres` is healthy, that disk is free and that the tools exist.
2. Runs `pg_dump -Fc` inside `assessiq-postgres` and checks the dump with `pg_restore -l`.
3. Encrypts the dump with `age` and a **public** key. The private key is never on the VPS.
4. Uploads to Cloudflare R2 with `rclone`, with a `.sha256` sidecar object.
5. Verifies the upload by size and by sha256 (it downloads the object again and hashes it).
6. Keeps 7 daily and 4 weekly copies (Sunday). It deletes only names that match `assessiq-YYYYMMDDTHHMMSSZ.dump.age` under its own prefix. It refuses to delete when the listing is empty.
7. Writes one line to `/var/log/assessiq/backup-daily.status`. On any failure it emails `connect@assessiq.in` and exits non-zero.

`--files` does the same for the uploaded-files folder (`FILES_PATH`) as `assessiq-files-<ts>.tar.age`. It prints a SKIP if the folder does not exist.

## What it does not cover

- It does not replace `/etc/cron.daily/assessiq-backup` (the on-box dump at 06:25 UTC). It runs in addition.
- It never reads or uploads `ASSESSIQ_MASTER_KEY`, `.env` or `secrets/`.
- No Redis, Caddy config or point-in-time recovery.
- This change installs no timer or cron.

## Choices

| Choice | Decision | Why |
| --- | --- | --- |
| S3 client | `rclone` | One static binary. No Python runtime. Keys go in environment variables, so no config file holds them. `rclone cat` and `lsf --format s` give the size and hash checks directly. |
| Rejected | `aws` CLI v2 | Larger install. Needs `--endpoint-url` on every call. Multipart ETag is not an MD5, so a hash check needs a download anyway. |
| Encryption | `age` with a public recipient | Small, no key ring, the VPS can only encrypt. |
| Rejected | `gpg` | Key ring state on the VPS, harder to script and to restore. |
| Verify | Size + re-download sha256 | R2 egress is free. ETag is not sound for multipart uploads. |
| Compression | None | `pg_dump -Fc` is already compressed. |

## Where the R2 keys live (owner decision)

| Option | Pros | Cons |
| --- | --- | --- |
| A. Root-only file `/etc/assessiq/backup.env` (mode 600) | Simple. Works with cron and systemd. The script checks mode and owner. | Anyone with root on the VPS can read the keys. |
| B. systemd credential (`LoadCredential=`) | Not in a shared path. Not in the environment of other units. | systemd only, no cron. More setup. |
| C. Laptop pull (the laptop fetches the dump over `ssh`, encrypts and uploads) | No cloud keys on the VPS at all. | Needs the laptop on every day. Misses days. Not unattended. |
| D. Scoped R2 token, write-only, no delete, plus bucket lifecycle rules for retention | A stolen key cannot erase backups. | The script's own retention fails on delete (403). Set `KEEP_DAILY` high, expect the delete errors, and let the lifecycle rule expire objects. |

**Recommendation:** A, with a token scoped to this one bucket. Add D when you want protection against a root compromise. The decision is yours.

> [!WARNING]
> Do not give the token account-wide rights. Scope it to the one bucket.

## Switch it on

Do the enumerate-first checks of project rule 8 before any step on the VPS.

1. On your **laptop**, install `age` and create the key pair. Keep the private key off the VPS.

   ```bash
   age-keygen -o assessiq-backup-key.txt
   ```

   Copy the line `# public key: age1...`. Store `assessiq-backup-key.txt` in the password manager and in a second offline place.
2. In the Cloudflare dashboard, create an R2 bucket (for example `assessiq-backups`). Create an R2 API token scoped to that bucket (Object Read and Write). Note the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
3. On the VPS, install `age` and `rclone` from the distribution packages or the official release. Check with `age --version` and `rclone version`.
4. Write the env file. Use your own values.

   ```bash
   ssh assessiq-vps 'install -d -m 755 /etc/assessiq; umask 077; cat > /etc/assessiq/backup.env' <<'ENV'
   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   R2_BUCKET=assessiq-backups
   R2_PREFIX=assessiq
   R2_ACCESS_KEY_ID=<key id>
   R2_SECRET_ACCESS_KEY=<secret>
   AGE_RECIPIENT=age1<public key only>
   KEEP_DAILY=7
   KEEP_WEEKLY=4
   ENV
   ssh assessiq-vps 'chown root:root /etc/assessiq/backup.env; chmod 600 /etc/assessiq/backup.env'
   ```

   Optional: add `FILES_PATH=<uploads folder>` for `--files`.
5. Copy the script and dry-run it. The dry run prints each step and makes no docker, network or file call.

   ```bash
   scp tools/backup-daily.sh assessiq-vps:/usr/local/sbin/assessiq-backup-daily.sh
   ssh assessiq-vps 'chmod 750 /usr/local/sbin/assessiq-backup-daily.sh; /usr/local/sbin/assessiq-backup-daily.sh --dry-run'
   ```
6. Run once for real, then read the status line.

   ```bash
   ssh assessiq-vps '/usr/local/sbin/assessiq-backup-daily.sh; cat /var/log/assessiq/backup-daily.status'
   ```

   Expect `OK`, a size and a sha256 prefix. Check the bucket in the Cloudflare dashboard.
7. Prove one restore (see Restore below) before you trust it.
8. Add the schedule. Pick one. Install it by hand, with `assessiq-*` names only.

   Cron (`/etc/cron.d/assessiq-backup-daily`, runs after the on-box dump at 06:25):

   ```cron
   40 6 * * * root /usr/local/sbin/assessiq-backup-daily.sh >> /var/log/assessiq/backup-daily.log 2>&1
   ```

   systemd, file `/etc/systemd/system/assessiq-backup-daily.service`:

   ```ini
   [Unit]
   Description=AssessIQ off-site backup
   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/assessiq-backup-daily.sh
   ```

   systemd, file `/etc/systemd/system/assessiq-backup-daily.timer`:

   ```ini
   [Unit]
   Description=AssessIQ off-site backup, daily
   [Timer]
   OnCalendar=*-*-* 06:40:00 UTC
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```

   Then run `systemctl daemon-reload` and `systemctl enable --now assessiq-backup-daily.timer`.

For uploaded files, add a second schedule line with `--files` after you set `FILES_PATH`.

> [!WARNING]
> Never put the private key (`AGE-SECRET-KEY-...`) on the VPS. The script refuses a private key in `AGE_RECIPIENT` or `AGE_RECIPIENT_FILE`.

## Restore

1. Download the object and its `.sha256` sidecar from the bucket (dashboard, or `rclone copyto` on your laptop).
2. Check the hash: `sha256sum -c assessiq-<ts>.dump.age.sha256`.
3. Decrypt on the laptop: `age -d -i assessiq-backup-key.txt < assessiq-<ts>.dump.age > restore.dump`.
4. Restore into a new throwaway container. Follow "Restore for real in an emergency" in `docs/runbooks/backup-restore.md` (roles `assessiq_app` and `assessiq_system`, then `pg_restore --no-owner --no-privileges`).
5. Compare row counts, then follow the swap steps in that runbook.

## MASTER_KEY escrow

`ASSESSIQ_MASTER_KEY` lives in `/srv/assessiq/.env`. The dump does not hold it. Without it you cannot read encrypted columns after a restore.

1. Copy the value from `/srv/assessiq/.env` to the password manager.
2. Copy it to a second offline place (a printed sheet in a safe, or an encrypted USB drive).
3. Never store it in the R2 bucket, next to the age private key, or next to a dump.

The script never reads or uploads this key. Check the escrow by hand each quarter.

## Monitoring

- Read `/var/log/assessiq/backup-daily.status`. Format: `<ISO time> OK|FAIL mode= name= size= sha256= secs= [reason=]`.
- A failure emails `connect@assessiq.in` through `SMTP_URL` in `/srv/assessiq/.env`. This is the same path as the on-box job.
- A dead cron or timer sends nothing. Add a staleness check: alert if the status file is older than 30 hours or does not say OK. The pattern of `tools/ops/assessiq-backup-check.sh` (RV73, heartbeat) fits here.

## Rollback

- Stop the schedule: `systemctl disable --now assessiq-backup-daily.timer`, or delete the cron line.
- You do not need to delete anything in the bucket. Old objects stay encrypted.
- Remove the R2 token in Cloudflare if you stop for good.

## What is not included

- No real R2 run. Only the local-folder target was proven.
- No alert if the schedule itself stops.
- No Redis, Caddy or `.env` backup.
- No timer or cron installed, no keys created.
