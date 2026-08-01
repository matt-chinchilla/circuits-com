# P2 mail — runbook: bare instance → working mail

Ordered, resumable. Each step says who runs it and how you know it worked.

- **Zone:** `Z02960201943UQ96RRIAR` (`circuitcenter.ai`)
- **Mail host:** `mail.circuitcenter.ai`
- **Mailboxes:** `anthony@`, `daniel@`, `matthew@`, `ronald@`, `no-reply@`
  (`demo@` is a login identity only — **no mailbox**)
- **Tooling in this directory:** `records.json`, `dkim-record.json.template`,
  `apply-dns.sh`, `verify-mail.sh`

> Every DNS mutation goes through `apply-dns.sh`, which is a **dry run unless you
> pass `--confirm`**. Run it once without the flag, read the before/after, then
> re-run with it.

---

## Two facts that drive the whole ordering

**1. The AWS port-25 restriction is on *outbound* traffic from EC2, not inbound.**
By default AWS throttles connections *from* your instance *to* port 25 anywhere.
It does **not** block the internet from reaching port 25 *on* your instance.
So inbound mail works from day one; only direct-to-MX outbound delivery is
affected — and this design relays outbound through SES anyway. See
[If AWS refuses](#if-aws-refuses-the-port-25-unblock).

**2. A PTR request needs the forward record to already exist.** AWS validates
that `mail.circuitcenter.ai` resolves to the Elastic IP you are requesting rDNS
for. That is why the A record (step 3) comes *before* the request form (step 4),
and why MX/SPF/DMARC wait until step 9.

---

## Step 0 — preconditions

| | |
|---|---|
| P1 auth overhaul deployed | mailbox passwords are the site passwords; provisioning first means throwaway credentials |
| SES domain verified, out of sandbox | already true — 50k/day, 14/s |
| AWS CLI creds with Route53 + EC2 | `aws route53 get-hosted-zone --id Z02960201943UQ96RRIAR` should return `circuitcenter.ai.` |
| `dig`, `jq`, `openssl`, `python3` locally | `verify-mail.sh` needs them |

---

## Step 1 — instance + Elastic IP

t4g.micro, **arm64**, Amazon Linux 2023, 10 GB gp3, in `vpc-0ab275458be2c8214` /
`subnet-0c4b13c8ff61b8025` (us-east-1c, same AZ as the web box so push-sync
traffic is free). Tag `Name=circuitcenter.ai Mail Server`.

Allocate an Elastic IP and associate it. **Record the EIP — it is the `MAIL_EIP`
every later step substitutes.**

> Re-resolve the AMI at launch rather than trusting a recorded id:
> `aws ec2 describe-images --owners amazon --filters 'Name=name,Values=al2023-ami-2023*arm64' --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text`

**Done when:** the instance is `running` with the EIP associated.

---

## Step 2 — security group

| Port | Source | Why |
|---|---|---|
| 25 | `0.0.0.0/0` | inbound SMTP from other mail servers |
| 465 | `0.0.0.0/0` | implicit-TLS submission |
| 587 | `0.0.0.0/0` | STARTTLS submission |
| 993 | `0.0.0.0/0` | IMAPS |
| **80** | `0.0.0.0/0` | **Let's Encrypt HTTP-01 (step 7)** |
| **443** | `0.0.0.0/0` | **Roundcube webmail** |
| push-sync port | web box private IP **only** | P3 credential sync |
| SSH | EC2 Instance Connect only | no open 22 |

> **80 and 443 are missing from the launch checklist's SG list.** Without 443
> Roundcube is unreachable; without 80 the HTTP-01 challenge in step 7 fails.
> If you would rather not expose 80, use the DNS-01 alternative in step 7.

**Done when:** `./verify-mail.sh` shows the ports as reachable (it will still
fail on everything else — that is expected this early).

---

## Step 3 — publish the A record (early, on purpose)

```bash
./apply-dns.sh <MAIL_EIP> --only A            # dry run: read the diff
./apply-dns.sh <MAIL_EIP> --only A --confirm  # apply
```

Only the A record. MX, SPF and DMARC deliberately wait until step 9 — pointing MX
at a host that is not yet accepting mail makes every sender queue and retry for
days before bouncing.

**Done when:** `dig +short A mail.circuitcenter.ai` returns the EIP.

---

## Step 4 — port-25 unblock + rDNS request ⟵ **the long pole, submit now**

**Only the AWS account owner (Matthew) can do this.** Submit it the moment step 3
resolves, then carry on with steps 5–9 while it sits in the queue — nothing below
is blocked on it.

Form: **"Request to remove email sending limitations"** — one form covers both the
port-25 unblock and the rDNS record.

- <https://aws-portal.amazon.com/gp/aws/html-forms-controller/contactus/ec2-email-limit-rdns-request>
- background: <https://repost.aws/knowledge-center/ec2-port-25-throttle>

Provide:
- Elastic IP: `<MAIL_EIP>`
- Reverse DNS record: `mail.circuitcenter.ai`
- Use case: transactional and staff mail for the circuitcenter.ai domain; outbound
  relays through Amazon SES; the domain is SES-verified with DKIM enabled.

**The restriction is per-Region** — this request covers `us-east-1` only, which is
all we need.

Turnaround is typically 24–48 h and **is not guaranteed**.

**Done when:** `dig +short -x <MAIL_EIP>` returns `mail.circuitcenter.ai.`
instead of `ec2-<...>.compute-1.amazonaws.com.` Until then `verify-mail.sh`
reports PTR as a **WARN**, not a failure — that is correct.

---

## Step 5 — Docker + docker-mailserver

Owned by the container stream; DNS-relevant points only:

- `mailserver/docker-mailserver` publishes a **linux/arm64** variant (verified —
  the manifest list is amd64 + arm64, and every tag through 10.5.0 lists
  `amd64,arm,arm64`). Pin an explicit tag; do not float on `latest`.
- Slim profile: rspamd + Fail2ban, **no ClamAV** (RAM), container memory-capped.
- `hostname` must be `mail.circuitcenter.ai` — Postfix derives its HELO name and
  SMTP banner from it, and a banner that disagrees with the PTR costs reputation.
  `verify-mail.sh` checks this explicitly.
- Maildir on its own volume; nightly EBS snapshot (DLM policy).

**Done when:** `verify-mail.sh` shows ports 25/465/587/993 open and a `220`
banner naming `mail.circuitcenter.ai`.

---

## Step 6 — mailboxes

```bash
docker exec -it mailserver setup email add anthony@circuitcenter.ai
docker exec -it mailserver setup email add daniel@circuitcenter.ai
docker exec -it mailserver setup email add matthew@circuitcenter.ai
docker exec -it mailserver setup email add ronald@circuitcenter.ai
docker exec -it mailserver setup email add no-reply@circuitcenter.ai
docker exec -it mailserver setup email list
```

Do **not** create `demo@` — it is a site login identity with no mailbox.

Passwords set here are placeholders; P3's push-sync overwrites them with the
hash derived from each person's site password.

---

## Step 7 — TLS certificate

**HTTP-01 (needs port 80 from step 2):**
```bash
sudo certbot certonly --standalone -d mail.circuitcenter.ai
```

**DNS-01 alternative (no port 80; we already control Route53):**
```bash
sudo certbot certonly --dns-route53 -d mail.circuitcenter.ai
```

Mount `/etc/letsencrypt` into the container and set `SSL_TYPE=letsencrypt`.
Add the renewal hook that restarts the container, or renewals will silently stop
being served.

**Done when:** `verify-mail.sh` section 3 shows `Verify return code: 0 (ok)` for
587, 465 and 993. Before this step it correctly FAILs with
*"still the container's self-signed cert"*.

---

## Step 8 — generate and publish DKIM

The key does not exist until the container makes it. This is why `records.json`
contains **no DKIM record**: publishing a placeholder would be *worse* than
publishing nothing, because receivers would find selector `mail`, fail to verify,
and treat every signed message as a DKIM permerror.

```bash
docker exec -it mailserver setup config dkim domain circuitcenter.ai selector mail

# locate the generated public key (path differs between rspamd and OpenDKIM builds)
sudo find ./docker-data/dms/config -name '*mail*' -path '*dkim*' -o -name 'mail.txt'
```

Copy that file locally, then:

```bash
./apply-dns.sh --dkim-file ./mail.txt --selector mail            # dry run
./apply-dns.sh --dkim-file ./mail.txt --selector mail --confirm  # apply
```

`apply-dns.sh` accepts either the multi-line BIND-style `mail.txt` or a bare
base64 key, reassembles it, validates it is a real key, and **re-splits it into
255-character DNS character-strings**. A 2048-bit key is ~392 base64 characters —
emitting it as one string is the classic "DKIM record published but never
verifies" bug.

The three existing **SES DKIM CNAMEs** use token selectors
(`oxnfmck…`, `v337t2c…`, `zkfvj4j…._domainkey`) and do **not** collide with
selector `mail`. Both signing paths coexist: SES signs what the site relays,
this key signs what the mail host sends directly. `verify-mail.sh` asserts all
three SES CNAMEs still resolve.

**Done when:** `dig +short TXT mail._domainkey.circuitcenter.ai` returns a
`v=DKIM1` record.

---

## Step 9 — cutover: MX, SPF, DMARC

Only now, with the container answering on 25 and holding a valid certificate.

```bash
./apply-dns.sh <MAIL_EIP>            # dry run — read the before/after carefully
./apply-dns.sh <MAIL_EIP> --confirm  # apply
```

What changes:

| Record | Before | After |
|---|---|---|
| `mail.circuitcenter.ai` A | (already set in step 3) | unchanged — idempotent UPSERT |
| `circuitcenter.ai` MX | **none** | `10 mail.circuitcenter.ai.` |
| `circuitcenter.ai` TXT | `v=spf1 include:amazonses.com ~all` | `v=spf1 include:amazonses.com ip4:<MAIL_EIP> ~all` |
| `_dmarc.circuitcenter.ai` TXT | `v=DMARC1;p=none;` | `v=DMARC1; p=none; rua=mailto:no-reply@circuitcenter.ai; fo=1; adkim=r; aspf=r; pct=100` |

Two things worth knowing:

- **A `_dmarc` record already exists** (`v=DMARC1;p=none;`) — this is a
  **replace, not a create**, and the launch checklist does not mention it. The
  existing one has no `rua`, so nobody has ever received a report. Adding `rua`
  is what makes step 12 possible.
- **SPF uses `ip4:` rather than `a:`** so it costs zero DNS lookups against the
  RFC 7208 limit of 10. The trade-off is that it must be re-applied if the EIP
  ever changes; an Elastic IP does not change on its own, and the PTR is bound to
  it anyway. Switch to `a:mail.circuitcenter.ai` if you prefer self-healing.

**Done when:** `./verify-mail.sh --ip <MAIL_EIP>` reports **0 failed**.
Resolvers cache the old SPF/DMARC for up to their previous TTL of 600s.

---

## Step 10 — verify

```bash
./verify-mail.sh --ip <MAIL_EIP>
./verify-mail.sh --ip <MAIL_EIP> --resolver 8.8.8.8   # public resolver view
```

Checks DNS (A, MX, MX-not-a-CNAME, SPF, DMARC, DKIM, SES CNAMEs, PTR),
reachability (25/465/587/993/443), TLS validity and hostname match on every
port, the SMTP banner, STARTTLS advertisement, and that the server **refuses to
relay**. Exit code is non-zero if anything FAILs; WARNs never fail the run.

If port 25 alone is unreachable while 587 is open, the script deliberately WARNs
rather than FAILs and tells you how to disambiguate — **most ISPs block outbound
port 25 from client networks**, so a failure measured from a laptop is usually
about your network, not the server. Re-test from the web box.

Then send the real test messages the script prints at the end: inbound from
Gmail, outbound via swaks, and a mail-tester.com run for SPF/DKIM/DMARC scoring.
**No check above proves a message actually flows.**

---

## Step 11 — point the site's outbound at SES

Create an IAM user with `ses:SendRawEmail` only, generate **SES SMTP
credentials** from it, and put them in `/opt/circuits-com/.env` on both boxes.

> SES SMTP credentials are **not** IAM access keys — AWS states plainly that
> "your SMTP password is different from your AWS secret access key". The SMTP
> password is an HMAC derivation of the secret key and is **region-specific**.
> Generate them from the SES console (SMTP Settings → *Create SMTP credentials*).
> Pasting a raw secret access key as an SMTP password will not work.

- Site (`docker-compose.prod.yml` env): `SMTP_HOST=email-smtp.us-east-1.amazonaws.com`, port 587, STARTTLS.
- Mail host Postfix: same endpoint as its relay host.
- **Purge the dead Hover credentials** from prod `.env`, `CLAUDE.md` and `README.md`.

Secrets live only in `/opt/circuits-com/.env`. Never in git.

**Done when:** a website contact-form submission arrives from
`no-reply@circuitcenter.ai`.

---

## Step 12 — after a week, tighten DMARC

Aggregate reports arrive as XML at `no-reply@circuitcenter.ai`. Read them until
every legitimate source (SES, the mail host) shows passing SPF **and** DKIM with
correct alignment, then step the policy up — never jump straight to reject:

`p=none` → `p=quarantine; pct=25` → `p=quarantine` → `p=reject`

Each step is a `_dmarc` TXT edit; re-run `verify-mail.sh` after each.

---

## If AWS refuses the port-25 unblock

Survivable by design — it costs one capability, not the service.

| | Works? |
|---|---|
| **Inbound mail** to all five mailboxes | ✅ unaffected — the AWS restriction is outbound-only |
| **Outbound via SES relay** (the configured path) | ✅ unaffected — port 587 to SES, not port 25 |
| Website form notifications | ✅ unaffected — SES |
| Roundcube webmail, IMAP clients | ✅ unaffected |
| **Direct MTA-to-MTA delivery on port 25** | ❌ blocked |
| PTR matching `mail.circuitcenter.ai` | ❌ stays the AWS default |

The reason this holds: AWS documents that **ports 465 and 587 to the SES endpoint
are not throttled** — only port 25 is. Relaying on 587 sidesteps the restriction
entirely, by design rather than by luck.

Because outbound was always going to relay through SES, a refusal changes
nothing about day-to-day operation. It only removes the fallback of bypassing
SES. `verify-mail.sh` reflects this: PTR mismatch is a **WARN**, never a FAIL.

Deliverability actually *improves* by relaying through SES — a fresh single IP
with no sending history is treated far more harshly than SES's pools.

---

## Rollback

Removing the MX is enough to stop inbound mail routing to the box; senders will
bounce rather than queue at a dead host.

```bash
aws route53 change-resource-record-sets --hosted-zone-id Z02960201943UQ96RRIAR \
  --change-batch '{"Changes":[{"Action":"DELETE","ResourceRecordSet":{
    "Name":"circuitcenter.ai.","Type":"MX","TTL":300,
    "ResourceRecords":[{"Value":"10 mail.circuitcenter.ai."}]}}]}'
```

`DELETE` must match the existing record set **exactly** (name, type, TTL and all
values) or Route53 rejects it. To restore the pre-P2 SPF and DMARC:

- SPF → `"v=spf1 include:amazonses.com ~all"` (TTL 600)
- DMARC → `"v=DMARC1;p=none;"` (TTL 600)

There was never an MX record before P2, so there is nothing to restore for it —
which is exactly why this cutover carries zero risk to existing mail flow.
