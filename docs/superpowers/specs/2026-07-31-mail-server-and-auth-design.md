# Mail server + unified authentication — design

**Date:** 2026-07-31
**Status:** awaiting review

Self-hosted mail for `circuitcenter.ai` on a dedicated AWS instance, with the
site's admin login and each person's mailbox sharing **one** password.

---

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Mail provider | Self-hosted `docker-mailserver` | WorkMail closed to new customers 2026-04-30, EOL 2027-03-31 |
| Placement | **Dedicated t4g.micro** (~$10.58/mo all-in) | Blast-radius isolation from the web box; measured cheaper than upgrading the web box to 4 GB |
| Web-box upgrade | **Deferred** (t3a.medium +$12.27/mo stays on the table) | Swapfile currently covers the build OOM |
| Outbound | Relay through **SES** | Deliverability from a fresh single IP is otherwise poor |
| Credential sync | **Push-sync: site → mail box** | The internet-exposed mail box gets NO database path |
| Addresses | Long form everywhere: `anthony@`, `daniel@`, `matthew@`, `ronald@`, `no-reply@` | Matches existing DB rows — one consistent identity per person |

---

## P1 — Auth overhaul (independent; ships first)

Email becomes the login key. No mail-server dependency, so this is valuable and
deployable on its own.

**Schema (migration 022)**
- `users.email` → `NOT NULL` + unique index on `lower(email)` (case-insensitive
  login). All five rows already hold `@circuitcenter.ai` addresses, so the
  backfill is a no-op.
- `users.must_change_password BOOLEAN NOT NULL DEFAULT false`; set `true` for
  anthony, daniel, matthew, ronald.
- `demo` is **exempt** (stays `false`) — `demo/demo` is the public demo login
  and a forced reset would break it.
- **New `owner` tier** on the existing `user_role` enum (Postgres `ALTER TYPE`,
  which is additive and irreversible — noted in the migration). `matthew`
  becomes `owner`; the rest stay `admin`. P4b's cross-mailbox access and P4c's
  broadcast are gated on it, so it must land in this migration even though it is
  only exercised later.

**Password policy** — 8–24 characters, ≥1 uppercase, ≥1 digit, ≥1 symbol.
Enforced server-side (422 with a specific message per unmet rule) and mirrored
client-side as live checklist feedback. One shared validator module so the two
can't drift.

**Login flow**
- `POST /api/auth/login` takes `email` + `password` (the existing
  anti-enumeration timing equalization is preserved).
- If `must_change_password`, the response says so and the SPA routes to a
  "Choose your new password" screen.
- **Enforcement is server-side, not just UI**: a FastAPI dependency rejects
  every admin route except the password-change endpoint while the flag is set.
  A flagged user cannot reach data by skipping the screen.
- Clearing the flag requires the new password to differ from the old one.

**Recovery UI** — with email as the key, "Can't remember your username?" is
meaningless (the username *is* the email). That link becomes password recovery;
the `forgot-username` endpoint is retired.

---

## P2 — Mail infrastructure

**Instance** — t4g.micro (arm64, Amazon Linux 2023), 10 GB gp3, its own Elastic
IP, tagged `circuitcenter.ai Mail Server`. Security group: 25/465/587/993 from
anywhere, SSH via EC2 Instance Connect only.

**Stack** — `docker-mailserver` (arm64), slim profile: rspamd + Fail2ban,
**no ClamAV** (RAM). Container memory-capped. Maildir on a volume with nightly
EBS snapshots. Roundcube webmail at `mail.circuitcenter.ai`, its own Let's
Encrypt certificate.

**Mailboxes** — `anthony@`, `daniel@`, `matthew@`, `ronald@`, `no-reply@`.
(`demo@` is a login identity only — no mailbox.)

**DNS** — `MX` → `mail.circuitcenter.ai`, `A` record for the mail host, SPF
(SES + mail host), DKIM (published from the container's generated key), DMARC
starting at `p=none` and tightened after a week of clean reports, plus a **PTR
request** on the new EIP.

**Outbound** — Postfix relays to SES. The site's `docker-compose.prod.yml`
SMTP env switches from Hover to SES credentials (secrets live only in
`/opt/circuits-com/.env`), so form notifications keep flowing from
`no-reply@circuitcenter.ai`.

**Two AWS forms only the account owner can submit** (flagged when reached):
port-25 unblock + PTR request, and SES production access. Both can take
24–48 h and neither is guaranteed — until SES production access lands, sending
is limited to verified addresses.

---

## P3 — Credential unification (push-sync)

One password opens the site and the mailbox.

**Mechanism** — at every password-set moment (forced reset, self-service
change, admin-initiated reset) the site holds the plaintext in memory. It
computes the **SHA512-crypt** hash there and POSTs `{email, hash}` to a small
authenticated endpoint on the mail box, which rewrites that account's line in
`postfix-accounts.cf` and reloads.

- **Plaintext never leaves the web box** — only the derived hash crosses.
- The mail box holds **no database credentials** and has no route to Postgres.
- The endpoint accepts a shared bearer secret (`/opt/circuits-com/.env` on both
  hosts) over HTTPS, and its security group only admits the web box's IP.

**Drift handling** — the site password change succeeds even if the mail box is
unreachable; the row is marked `mail_sync_pending` and retried with backoff. If
it stays unsynced, the admin console shows a banner naming the affected account.
Silent drift (site and mail disagreeing without anyone knowing) is the failure
mode this explicitly prevents.

---

## P4 — Messages as the company inbox

`/admin/messages` becomes the single place company mail lands, keeping its four
website-form types (contact, join, keyword, archived) and gaining three things.

### P4a — Shared company inbox (everyone)

Inbound mail to the domain is funnelled into **`no-reply@`**, which the backend
reads over IMAP with its own role-account credential and renders as a fifth
message type alongside the form submissions. Every admin sees it — these are
sales and partnership opportunities, so shared visibility is the point.

- A **catch-all alias** routes anything not addressed to a person (`info@`,
  `sales@`, typos) into the same store, so nothing is silently lost.
- Friendly public aliases (`hello@`, `contact@`) deliver here too. Worth noting:
  `no-reply@` is conventionally a *send-only* identity, so publishing a friendlier
  address for humans while `no-reply@` remains the sending name reads better on
  the site — same mailbox either way.
- No privacy consideration: this is a role account, not a person's mailbox.

### P4b — Owner access to employee mailboxes (owner only)

The owner can open any employee mailbox from the admin console. This requires a
**Dovecot master credential** held by the backend, and — importantly — a
permission tier that does not exist today: **all five accounts are currently
`role='admin'`**, so without a new tier "the owner can read everyone" would mean
"everyone can read everyone."

- Add an **`owner`** tier (`matthew`); anthony, daniel and ronald stay `admin`.
- Cross-mailbox reads are gated on `owner` server-side, and every access is
  written to an audit log (who opened whose mailbox, when).
- Practical note: standard practice — and in some jurisdictions a requirement —
  is that staff are *told* company mail is employer-accessible. A line in their
  onboarding note costs nothing and avoids an unpleasant surprise later.

### P4c — Broadcast to staff (owner only)

A composer that sends one message to all active staff addresses, via SES from
`matthew@` (reply-to preserved so replies come back to a human, not the void).
Owner-gated, with each broadcast logged (recipients, subject, timestamp).

### Personal mailbox access (everyone)

Each person still gets a **"Your mailbox"** hand-off to
`https://mail.circuitcenter.ai` for day-to-day mail — full webmail beats a
half-built inbox view, and it costs no extra engineering.

---

## Sequencing

1. **P1** — auth overhaul (independent; deploy and confirm everyone can log in)
2. **P2** — mail box, DNS, SES (AWS forms are the long pole)
3. **P3** — push-sync (needs P1's password endpoints + P2's mail box)
4. **P4a** — shared company inbox + catch-all (needs P2)
5. **P4b/P4c** — owner mailbox access + broadcast (needs P1's `owner` tier)

## Risks

- **AWS port-25 unblock may be refused.** Then inbound still works, and all
  outbound goes via SES — the design already relays outbound, so this is
  survivable rather than fatal.
- **SES production access delay** limits sending to verified addresses meanwhile.
- **DNS/DKIM propagation** means early mail may land in spam until DMARC reports
  come back clean.
- **P1 locks people out if the policy screen has a bug** — mitigated by testing
  the forced-reset path against a scratch account before flagging real ones.

- **The Dovecot master credential (P4b) is a high-value secret** — it opens
  every mailbox. It lives only in `/opt/circuits-com/.env` on the web box, is
  never sent to the browser, and every use is audit-logged. A web-box compromise
  reaching it would expose all company mail; that is the accepted cost of
  owner-side access, and the audit log is what makes misuse visible.

## Out of scope

Calendar/contacts (CalDAV), mailing lists, mobile device provisioning profiles,
and migrating any existing mail history.
