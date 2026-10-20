# Test the camera for three kinds of organisation

This runbook shows how to repeat the camera test for a school, a school with the camera on, and a normal organisation.

- Use it after each release that touches the camera.
- Run it on a test server or a test organisation only. Never use a real customer.
- The camera rule works only when the server setting `CAMERA_ENFORCED` is `true`. The owner sets it on the server.

## Prerequisites

- A super admin account with a working authenticator app (MFA).
- Two test organisations, both made in **Organisations**:
  - `<school tenant>`: this is the school test organisation.
  - `<normal tenant>`: this is a normal test organisation.
- One admin sign-in for each test organisation: `<your admin email>` (or a second admin email).
- A candidate email address you can open: `<candidate email>`.
- A laptop with a working camera and Chrome or Edge.
- The owner confirms that `CAMERA_ENFORCED` is `true` on the server.

> [!WARNING]
> Do not use a real candidate or a real customer for this test. Camera files are personal data.

## Set up the test organisations once

1. Sign in as the super admin. Open **Platform**.
2. Click **Create organisation**. Create `<school tenant>`. Invite its first admin.
3. In the row for `<school tenant>`, turn on the **School** switch. Confirm with your MFA code.
4. Click **Create organisation** again. Create `<normal tenant>`. Leave its **School** switch off.
5. Sign in as the admin of each organisation once. Check that each sign-in works.

## Procedure A: school with the camera off

Goal: check that a school test with the camera off has no camera step.

1. Sign in as the admin of `<school tenant>`.
2. Open **Settings**. Open the **Data privacy** tab.
3. Find the **Camera.** card.
4. Tick **I have the consent and notice my candidates need for camera use.** The chip shows "Confirmed, version".
5. Leave **Camera for real tests** off. The text reads "Off. The camera is off until you turn it on."
6. Create a real test and invite one candidate. For the full steps, see `docs/testing/uat/org-admin/`.
7. On the candidate laptop, open the invitation link.
8. Check the readiness list. It has no **Camera** row.
9. Check that no consent screen appears. Start the test.

## Procedure B: school with the camera on

Goal: check consent, the camera check, a lost camera, and the reviewer path.

1. Sign in as the admin of `<school tenant>`. Open **Settings**, then **Data privacy**.
2. Make sure the notice is confirmed (see Procedure A, step 4).
3. Turn on **Camera for real tests**. Turn **Photos** on or off. Both choices are valid for this test.
4. Create a real test and invite one candidate. Use a new candidate email if the old one already has an attempt.
5. On the candidate laptop, open the invitation link.
6. Check the readiness list. It has a **Camera** row. A live picture shows after **Check camera**.
7. Click **Check camera** and allow the camera in the browser prompt. The **Camera** row shows **Pass**.
8. Click **Begin** only after the consent screen shows. The screen shows **This test uses your camera** and five points.
9. Click **I do not agree, do not start**. Check the message: "You did not start the test."
10. As the admin, open the test, then the invitation row. Check the chip **Did not consent**.
11. Open the invitation link again as the candidate. Repeat steps 6 to 8. Click **Allow camera and start**.
12. Check that the **Camera on** mark shows during the test.
13. Cover the camera, or block it in the browser site settings. Check the message **Your camera stopped** (or **Camera access is blocked**) with a **Retry** button.
14. Allow the camera again. Click **Retry**. Submit the test.
15. As the admin of `<school tenant>`, open **Settings**, then **Data privacy**.
16. In **Camera reviewers.**, choose your admin in the list. Click **Add reviewer**.
17. Open **Camera review** in the left menu. Open the flagged attempt.
18. Click **View** on one file. The file opens. Every view is logged.
19. Click **Mark reviewed**. Then click **Open appeal**, then **Close appeal**.

## Procedure C: normal organisation

Goal: check that the camera is required for a real test, with no school switches.

1. Sign in as the admin of `<normal tenant>`. Open **Settings**, then **Data privacy**.
2. Confirm the notice first. Without it, the candidate cannot start a real test with the camera.
3. Check the text under **Camera.**: "The camera is on for every real test."
4. Create a real test and invite one candidate. Then repeat Procedure B, steps 5 to 14 as the candidate.
5. Do not use the school switches. This organisation has none.
6. Create a mock test, invite a candidate, and open the link. Check that there is no camera row and no consent screen.

## Expected results

| Scenario | What the candidate sees | What the admin sees | What is stored |
| --- | --- | --- | --- |
| A. School, camera off | No camera row. No consent screen. The test starts. | Camera switch off. Invitation has no consent chip. | No camera files. |
| B1. School, camera on, candidate declines | Consent screen. Message "You did not start the test." The test does not start. | Chip **Did not consent** on the invitation row. | One consent record (declined). No files. |
| B2. School, camera on, candidate agrees | **Camera on** mark during the test. | No change in **Camera review**. Only flagged attempts appear there. | Consent record (agreed). Photos every 60 seconds if photos are on. |
| B3. Camera stops | **Your camera stopped** with **Retry**. | Attempt appears in **Camera review** with a flag. | A flagged video. The flagged files stay until the appeal closes. |
| B4. Reviewer views a file | Nothing. | **View** opens the file. The view is logged. | Audit row. The file is not changed. |
| C. Normal organisation, real test | Camera check and consent screen, as in B. | Same review path as B. No school switches. | Same as B. |
| Mock test (any organisation) | No camera step. | No camera files. | Nothing. |

Keep times:

- Photos: 90 days.
- Short video: 7 days.
- School files: 7 days.
- Flagged files: stay until the appeal closes. Maximum 90 days for a school. Maximum 1 year for other organisations.

## Rollback

1. Sign in as the admin of `<school tenant>`. Open **Settings**, then **Data privacy**.
2. Turn off **Camera for real tests**.
3. In **Camera reviewers.**, click **Remove** for each reviewer.
4. As the super admin, turn off the **School** switch for `<school tenant>` in **Platform**.
5. Ask the owner to set `CAMERA_ENFORCED` to `false` on the server. This turns the camera rule off for all organisations.
6. Keep the test organisations until the test ends. Their camera files follow the keep times above.

> [!WARNING]
> The daily delete job runs at 03:00 UTC. It removes expired files only. Files of a flagged attempt stay until its appeal closes.
