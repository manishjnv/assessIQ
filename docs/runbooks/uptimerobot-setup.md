# Set up UptimeRobot uptime monitors

*Type: how-to*. This guide shows you how to create three uptime checks for AssessIQ. The checks send you an email when the site stops answering.

## Before you start

- Use an email address that you read. Do not use `connect@assessiq.in`.
- Use a web browser on your computer.

## Steps

1. Open `https://uptimerobot.com` in your browser.
2. Create an account with your email address.
3. Open the confirmation email from UptimeRobot. Select the link in the email.
4. Sign in to UptimeRobot.
5. Select the button that adds a new monitor. The label is usually **+ Add New Monitor**.
6. Set **Monitor Type** to `HTTP(s)`.
7. Enter the **Friendly Name** from one row of the table below.
8. Enter the **URL** from the same row.
9. Set **Monitoring Interval** to `5 minutes`.
10. Select your email address as the alert contact. Do not use `connect@assessiq.in`.
11. Select **Create Monitor**.
12. Repeat steps 5 to 11 for the other two rows.

## Monitors to create

| Friendly name | URL | Monitor type | Expected status | Keyword |
| --- | --- | --- | --- | --- |
| AssessIQ marketing home | `https://assessiq.in/` | HTTP(s) | `200` | None |
| AssessIQ health | `https://assessiq.in/api/health` | HTTP(s) | `200` | None |
| AssessIQ readiness | `https://assessiq.in/api/ready` | HTTP(s) | `200` | None |

- The home address serves the marketing site.
- `/api/health` answers `200` when the API runs.
- `/api/ready` answers `200` when the database, cache and AI checks pass. It answers `503` when one check fails.
- No keyword is needed. The status code is enough for these three URLs.
- The URLs match `tools/post-deploy-sweep.sh` and `docs/06-deployment.md`.

## Check that a monitor shows Up

1. Open the **Dashboard** in UptimeRobot.
2. Find the monitor by its friendly name.
3. Check that the status shows **Up**.
4. If the status is still empty, wait up to 5 minutes. The first check can take that long.

## What to do if a monitor shows Down

1. Select the monitor. Read the reason in the error message.
2. Wait for the next check. One failed check can be a short network problem.
3. Look at the other two monitors.
   - If all three show Down, the site is probably offline.
   - If only one shows Down, the problem is in that one path.
4. Tell the technical contact the monitor name, the time and the error message.
5. Follow `docs/11-observability.md`, section 33.1, "First 10 minutes of any incident".

> [!WARNING]
> Do not restart a container or change the server from this guide. Ask the technical contact first.

## Related

- `docs/11-observability.md`, section 33: incident runbook and alerting.
- `docs/runbooks/pre-pilot-checklist.md`, item 2: uptime monitor and alert path.
