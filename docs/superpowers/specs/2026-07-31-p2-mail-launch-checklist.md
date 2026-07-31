# P2 — mail server launch checklist

Verified prerequisites for `docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md`
phase P2. Everything below was read from live AWS on 2026-07-31 — no guesses.

## Confirmed ready

| Item | Value | Note |
|---|---|---|
| Route53 hosted zone | `Z02960201943UQ96RRIAR` | MX/SPF/DKIM/DMARC go here — no zone migration |
| VPC | `vpc-0ab275458be2c8214` | reuse the web box's VPC |
| Subnet / AZ | `subnet-0c4b13c8ff61b8025` / `us-east-1c` | same AZ as the web box → free traffic between them, which the push-sync channel uses |
| AL2023 arm64 AMI | `ami-04fc404d256fd34a2` | current as of launch day; re-resolve at launch |
| Elastic IPs | 2 of 5 used | headroom for the mail EIP |
| SES domain | verified, **out of sandbox** (50k/day, 14/s) | no production-access request needed |
| SES DKIM | enabled + `Success` | already signing |
| SPF | `v=spf1 include:amazonses.com ~all` | must be widened to include the mail host at cutover |
| MX | **none** | zero cutover risk; nothing to preserve |

## Still to create (P2 execution)

1. **SES SMTP credentials** — no IAM user for SMTP exists yet (checked). Create a
   dedicated user with `ses:SendRawEmail` only, derive its SMTP password, store
   in `/opt/circuits-com/.env` on both boxes. Never in git.
2. **t4g.micro instance** — arm64 AL2023, 10 GB gp3, in the VPC/subnet above,
   tagged `circuitcenter.ai Mail Server`.
3. **Security group** — 25/465/587/993 from `0.0.0.0/0`; the push-sync endpoint
   restricted to the web box's private IP; SSH via Instance Connect only.
4. **Elastic IP** — allocate + associate, then request PTR.
5. **DNS at cutover** — `mail.circuitcenter.ai` A record, MX → it, widen SPF,
   publish container DKIM, DMARC `p=none` first.
6. **docker-mailserver** — slim profile (rspamd + Fail2ban, no ClamAV), per-user
   ~1 GB quota, memory cap, maildir volume + nightly snapshot.
7. **Mailboxes** — `anthony@`, `daniel@`, `matthew@`, `ronald@`, `no-reply@`.
   (`demo@` is a login identity only.)
8. **Purge Hover** from prod `.env`, `CLAUDE.md`, `README.md` (task 7 of P1
   covers the docs half).

## Needs Matthew (cannot be done for you)

- **Port 25 unblock + PTR request** — the AWS form, submitted from the account
  owner. 24–48 h, not guaranteed. Outbound relays through SES regardless, so a
  refusal costs only direct port-25 delivery.

## Blocked on

P1 (auth overhaul) landing first — mailbox passwords are the site passwords, so
provisioning before the new auth exists would mean creating throwaway
credentials and immediately rotating them.
