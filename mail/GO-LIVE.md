# GO-LIVE — circuitcenter.ai mail, instance → mail flows

One merged, ordered runbook for the P2/P3 pieces in this directory. It supersedes
the *ordering* of `dns/RUNBOOK.md` where the two disagree (see "Order fixes" at
the bottom); every command below is the exact one to run. Steps only a human /
the AWS account owner can do are marked **HUMAN**.

Conventions:
- `MAIL_EIP` = the mail box's Elastic IP (recorded in step 0).
- "mail box" = the dedicated t4g.micro; "web box" = the existing site EC2
  (EIP `100.55.235.167`).
- On the mail box, `cd /opt/circuits-com/mail` first; `C` is shorthand:
  `C="sudo docker compose --env-file /opt/circuits-com/.env -f docker-compose.mail.yml"`.

---

## 0. Preconditions (assumed done)

t4g.micro (**arm64**, Amazon Linux 2023, 10 GB gp3) running in
`vpc-0ab275458be2c8214` / `subnet-0c4b13c8ff61b8025` (us-east-1c, same AZ as the
web box), Elastic IP associated. **Record the EIP — it is `MAIL_EIP` everywhere
below.** Docker Engine + Compose plugin installed and enabled. AWS CLI with
Route53 + EC2 + SES permissions on your workstation.

Both runtime images are arm64-verified: `ghcr.io/docker-mailserver/docker-mailserver:15.1.0`
(pinned by multi-arch index digest in the compose file) and `certbot/certbot:v5.7.0`.

## 1. Security group (mail box)

| Port | Source | Why |
|---|---|---|
| 25, 465, 587, 993 | `0.0.0.0/0` | SMTP inbound, submission ×2, IMAPS |
| 80 | `0.0.0.0/0` | Let's Encrypt HTTP-01 (step 5) |
| 443 | `0.0.0.0/0` | Roundcube later — open now, nothing listens yet |
| 8825 | `100.55.235.167/32` (web box **EIP**) | P3 password sync (step 12) |
| SSH | EC2 Instance Connect only | no open 22 |

> **8825 must allow the web box's PUBLIC EIP, not its private IP.** The site
> calls `https://mail.circuitcenter.ai:8825` (the public name — required for the
> TLS cert to verify), so the connection hairpins through the IGW and arrives
> with the web box's public IP as source. A private-IP /32 rule silently blocks
> every sync. (`sync-receiver/README.md` says private IP — that only works if
> you point `MAIL_SYNC_URL` at the private address, which breaks TLS hostname
> verification. Use the EIP.)

## 2. Publish the A record — early, on purpose

From `mail/dns/` on your workstation:

```bash
./apply-dns.sh <MAIL_EIP> --only A            # dry run — read the diff
./apply-dns.sh <MAIL_EIP> --only A --confirm  # apply
dig +short A mail.circuitcenter.ai            # must return MAIL_EIP
```

Only the A record. MX/SPF/DMARC wait until step 10 — an MX pointing at a host
that is not accepting mail makes senders queue and retry for days.

## 3. **HUMAN — Matthew only**: port-25 unblock + rDNS request

Submit the moment step 2 resolves; it is the long pole (24–48 h, not
guaranteed) and **nothing below waits on it** — outbound relays via SES
regardless, and the AWS restriction is *outbound-only* so inbound mail works
from day one.

Form: <https://aws-portal.amazon.com/gp/aws/html-forms-controller/contactus/ec2-email-limit-rdns-request>
- Elastic IP: `<MAIL_EIP>` · Reverse DNS: `mail.circuitcenter.ai`
- Use case: transactional and staff mail for the SES-verified circuitcenter.ai
  domain; outbound relays through Amazon SES.

Done when `dig +short -x <MAIL_EIP>` returns `mail.circuitcenter.ai.`
(until then `verify-mail.sh` reports PTR as WARN — correct, not a failure).

## 4. **HUMAN**: SES SMTP credentials, then files onto the box

**This must precede step 6 — the compose file refuses to start without the two
SES variables (`${VAR:?}` fail-fast).**

SES console → **SMTP settings → Create SMTP credentials** (creates an IAM user
scoped to `ses:SendRawEmail`; the password shown once is *derived* from the
secret key — pasting a raw secret access key yields `535` at first send).

On the mail box:

```bash
sudo mkdir -p /opt/circuits-com/mail
# copy the repo's mail/ directory contents to /opt/circuits-com/mail/
sudo chmod +x /opt/circuits-com/mail/setup-mailboxes.sh

sudo install -m 600 /dev/null /opt/circuits-com/.env
sudo -e /opt/circuits-com/.env      # type the two lines in (no heredoc — history):
# SES_SMTP_USERNAME=<from the console>
# SES_SMTP_PASSWORD=<from the console>
```

## 5. Let's Encrypt certificate — BEFORE first `up`

`SSL_TYPE=letsencrypt` silently falls back to **no TLS** if the cert is missing
at boot, so issue it first. Port 80 must be free (nothing else runs here).

```bash
sudo docker run --rm -p 80:80 \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  certbot/certbot:v5.7.0 certonly --standalone \
  -d mail.circuitcenter.ai \
  --agree-tos --no-eff-email -m no-reply@circuitcenter.ai

sudo test -f /etc/letsencrypt/live/mail.circuitcenter.ai/fullchain.pem && echo OK
```

Renewal: a daily cron/timer running the same image with `renew`. **No container
restart hook** — DMS's change detection watches the live pem files and reloads
Postfix/Dovecot itself (source-verified; `dns/RUNBOOK.md` step 7 says otherwise
and is wrong).

## 6. Start the mail stack

```bash
cd /opt/circuits-com/mail
sudo docker compose --env-file /opt/circuits-com/.env -f docker-compose.mail.yml up -d

$C logs -f mailserver                                          # watch first boot (minutes)
sudo docker inspect -f '{{.State.Health.Status}}' mailserver   # want: healthy
sudo docker inspect -f '{{.HostConfig.Memory}}' mailserver     # 671088640 (640 MiB cap)
```

## 7. Provision mailboxes + aliases

```bash
cd /opt/circuits-com/mail && sudo ./setup-mailboxes.sh
```

Creates `anthony@ daniel@ matthew@ ronald@ no-reply@` (never `demo@` — site
login only, no mailbox) with CSPRNG passwords written **only** to
`/opt/circuits-com/mail-credentials.txt` (0600), applies 1 GiB quotas, installs
the alias map. Idempotent — re-run freely; existing mailboxes are untouched.

Verify:

```bash
$C exec -T mailserver setup email list < /dev/null    # five accounts, ( used / 1G )
$C exec -T mailserver postmap -q anthony@circuitcenter.ai texthash:/etc/postfix/virtual < /dev/null
# -> anthony@circuitcenter.ai   (self-alias out-ranks the catch-all; if this says
#    no-reply@, STOP and read aliases.md)
$C exec -T mailserver postmap -q @circuitcenter.ai texthash:/etc/postfix/relayhost_map < /dev/null
# -> [email-smtp.us-east-1.amazonaws.com]:587
$C exec -T mailserver sh -c "cut -d' ' -f1 /etc/postfix/sasl_passwd" < /dev/null
# -> [email-smtp.us-east-1.amazonaws.com]:587   (must match character-for-character)
```

## 8. Generate + publish DKIM

The key does not exist until the container makes it — this step cannot move
earlier, and it must land **before any mail leaves** (step 10).

```bash
$C exec -T mailserver setup config dkim domain circuitcenter.ai selector mail < /dev/null
$C exec -T mailserver cat /tmp/docker-mailserver/rspamd/dkim/rsa-2048-mail-circuitcenter.ai.public.dns.txt < /dev/null
# copy that output to your workstation as mail.txt
```

From `mail/dns/`:

```bash
./apply-dns.sh --dkim-file ./mail.txt --selector mail            # dry run
./apply-dns.sh --dkim-file ./mail.txt --selector mail --confirm  # apply
dig +short TXT mail._domainkey.circuitcenter.ai                  # v=DKIM1 ...
```

(The script re-splits the key into 255-char DNS strings and leaves the three
SES token-selector CNAMEs untouched — both signing paths coexist.)

## 9. (Nothing — hold until 7 + 8 are verified. MX goes live next.)

## 10. Cutover: MX + SPF + DMARC

Only with the container healthy, TLS valid, mailboxes provisioned and DKIM
published:

```bash
cd mail/dns
./apply-dns.sh <MAIL_EIP>            # dry run — read BEFORE/AFTER carefully
./apply-dns.sh <MAIL_EIP> --confirm  # apply (A is an idempotent re-UPSERT)
```

Sets `MX 10 mail.circuitcenter.ai.`, widens SPF to
`v=spf1 include:amazonses.com ip4:<MAIL_EIP> ~all`, and **replaces** the
pre-existing bare `_dmarc` record with `p=none; rua=mailto:no-reply@…`. This is
the moment mail starts arriving; there was no MX before, so there is nothing to
cut over *from*.

## 11. Verify end to end

```bash
cd mail/dns
./verify-mail.sh --ip <MAIL_EIP>                      # want: 0 failed
./verify-mail.sh --ip <MAIL_EIP> --resolver 8.8.8.8   # public-resolver view
```

(A port-25 FAIL measured from a laptop is usually your ISP — re-test from the
web box: `nc -vz mail.circuitcenter.ai 25`.)

Then the three manual proofs the script prints — no automated check proves a
message flows:
1. **Inbound**: send from Gmail to `matthew@circuitcenter.ai`, confirm delivery
   (`$C exec -T mailserver tail -n 40 /var/log/mail/mail.log < /dev/null`).
2. **Outbound via relay**: `swaks --server mail.circuitcenter.ai:587 --tls
   --auth LOGIN --auth-user matthew@circuitcenter.ai --from matthew@circuitcenter.ai
   --to <personal address>` (password prompted, never on argv). Log must show
   `relay=email-smtp.us-east-1.amazonaws.com... status=sent`.
3. **Scoring**: send to the address at <https://www.mail-tester.com> — SPF,
   DKIM and DMARC must all pass.

## 12. Point the SITE's outbound at SES (web box)

```bash
sudo -e /opt/circuits-com/.env     # on the WEB box, add/replace:
# SMTP_HOST=email-smtp.us-east-1.amazonaws.com
# SMTP_PORT=587
# SMTP_USERNAME=<same SES SMTP username>
# SMTP_PASSWORD=<same SES SMTP password>
cd /opt/circuits-com && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate api
```

Purge the dead Hover credentials from that `.env` at the same time.
Done when a website contact-form submission arrives from `no-reply@circuitcenter.ai`.

## 13. P3 password push-sync

**Mail box** — install the receiver:

```bash
cd /opt/circuits-com/mail/sync-receiver
sudo install -D -m 0755 mail_sync_receiver.py /opt/circuits-com/mail-sync/mail_sync_receiver.py
sudo install -D -m 0644 circuits-mail-sync.service /etc/systemd/system/circuits-mail-sync.service

docker volume inspect -f '{{.Mountpoint}}' dms-config
# MUST print /var/lib/docker/volumes/dms-config/_data — if not, set
# MAIL_SYNC_ACCOUNTS_FILE in .env AND ReadWritePaths= in the unit (both).

python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # generate ONCE
sudo -e /opt/circuits-com/.env      # append (same file as the SES pair):
# MAIL_SYNC_SECRET=<the token>
# MAIL_SYNC_TLS_CERT=/etc/letsencrypt/live/mail.circuitcenter.ai/fullchain.pem
# MAIL_SYNC_TLS_KEY=/etc/letsencrypt/live/mail.circuitcenter.ai/privkey.pem

sudo systemctl daemon-reload && sudo systemctl enable --now circuits-mail-sync
curl -sSk https://127.0.0.1:8825/healthz    # {"status": "ok"}
```

**Web box** — same secret, then recreate the api:

```bash
sudo -e /opt/circuits-com/.env
# MAIL_SYNC_URL=https://mail.circuitcenter.ai:8825
# MAIL_SYNC_SECRET=<the SAME token>
cd /opt/circuits-com && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate api
```

Verify the plaintext refusal live (from the web box):

```bash
curl -sS -H "Authorization: Bearer $MAIL_SYNC_SECRET" -H 'Content-Type: application/json' \
     -d '{"email":"matthew@circuitcenter.ai","hash":"not-a-hash"}' \
     https://mail.circuitcenter.ai:8825/sync-password
# -> 400 "hash must be SHA512-crypt ($6$...)"
```

Then change a site password and confirm IMAP accepts it
(`openssl s_client -connect mail.circuitcenter.ai:993 -crlf`). Until each person
changes their site password, their mailbox keeps its bootstrap password from
step 7 — two credentials, by design, temporarily.

## 14. After a clean week

- `ENABLE_DNSBL=1` in `mailserver.env` + `$C up -d` — the biggest load cut
  available, deferred at launch so an EIP of unknown history can't bounce
  enquiries on day one.
- Tighten DMARC from the aggregate XML reports landing in `no-reply@`:
  `p=none` → `p=quarantine; pct=25` → `p=quarantine` → `p=reject`, re-running
  `verify-mail.sh` after each edit. Never jump straight to reject.
- Check `docker stats mailserver` against the 640 MiB cap; nightly EBS snapshot
  (DLM) of the root volume covers the `dms-*` volumes.

---

## Order fixes vs `dns/RUNBOOK.md` (why this file exists)

- **SES SMTP credentials moved from RUNBOOK step 11 to step 4 here** — the
  compose stack fail-fasts without them, so RUNBOOK's literal order dies at its
  step 5.
- **Certificate before first `up`** (RUNBOOK issued it after) — DMS silently
  boots without TLS when the cert is absent.
- **`setup-mailboxes.sh` replaces RUNBOOK step 6's interactive `setup email add`**
  — the script also installs the alias map with the catch-all self-alias guard,
  which the interactive path skips entirely.
- **No certbot renewal restart hook** (RUNBOOK says add one) — DMS change
  detection reloads on cert renewal, verified from DMS v15.1.0 source.
- **DKIM key path** is `/tmp/docker-mailserver/rspamd/dkim/` inside the
  container (named volume), not RUNBOOK's `./docker-data/dms/config` bind-mount
  guess.
- **Port 8825 SG source is the web box EIP**, not its private IP (hairpin NAT —
  see step 1).
