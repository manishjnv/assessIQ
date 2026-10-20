# Open public sign-up

*Type: how-to.* Use this page when the owner says "open sign-up". Sign-up is built and closed. Do not run these steps before the owner says so.

> [!WARNING]
> Do not set `SIGNUP_ENABLED=true` before the pilot tenants are on a paid tier and `PLAN_TIERS_ENFORCED=true` is live. Without the plan limits, a new Free organisation has no cap.

## Before you start

- You have SSH access to the host alias `assessiq-vps`.
- The pilot tenants are on a paid tier. The Free-tier limits are on (`PLAN_TIERS_ENFORCED=true`).
- The marketing site with `/signup`, `/dpa`, `/terms` and `/privacy` is deployed.
- The platform sender (Brevo) works. The daily mail cap is not used up.

## Steps

1. Create a Cloudflare Turnstile widget for the sign-up page.
   - Use the hostname of the public site.
   - Copy the site key and the secret key. Do not paste them in a chat or a ticket.
2. Add the keys to `/srv/assessiq/.env` on the server. Add lines only. Do not change other lines.
   - `TURNSTILE_SITE_KEY=<site key>`
   - `TURNSTILE_SECRET=<secret key>` (the contact form may already use this name; keep its value if it is the same widget)
3. Check that the config answers closed and that the keys are seen.
   - Run `curl -s https://assessiq.in/api/public/signup/config`.
   - Expect `"open":false` and a `turnstileSiteKey` that is not null.
4. Set `SIGNUP_ENABLED=true` in `/srv/assessiq/.env`.
5. Recreate the API container only: `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api`.
6. Run one real mail test.
   - Open `https://assessiq.in/signup` in a private window.
   - Sign up with a mailbox you own. Tick both boxes.
   - Make sure the code mail arrives and you can finish. You must land in the admin screen.
   - Make sure the new organisation shows in the platform tenant list as a Free organisation with a credit grant.
7. Run the sweep: `bash tools/post-deploy-sweep.sh`. Expect 0 failures.
8. Write the date and the result in `docs/SESSION_STATE.md`.

## Close sign-up again

1. Set `SIGNUP_ENABLED=false` in `/srv/assessiq/.env`.
2. Recreate `assessiq-api` as in step 5.
3. Run the `curl` from step 3. Expect `"open":false`.

## Daily limits (for the owner)

- 5 requests a day for each source address.
- 3 requests a day for each email address.
- 50 completed sign-ups a day in total.

## Related

- `docs/04-auth-flows.md`, section "Self-serve sign-up".
- `docs/06-deployment.md`, environment variables.
- `modules/19-billing/SKILL.md`.
