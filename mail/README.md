# `mail/` — self-hosted mail server for circuitcenter.ai

Runtime configuration for the **dedicated mail box**: a t4g.micro (arm64,
Amazon Linux 2023, 1 GB RAM, 10 GB gp3) running
[docker-mailserver](https://docker-mailserver.github.io/docker-mailserver/) v15.1.0.

This is phase **P2** of
[`docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md`](../docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md).
Nothing here runs on the web box, and nothing here touches the site's database.

Inbound mail arrives on port 25. **All outbound mail relays through Amazon SES**
— a fresh single IP has poor deliverability, AWS blocks outbound port 25 by
default, and the SES domain identity is already verified, DKIM-signing and out
of the sandbox.

## Files

| File | What it is |
|---|---|
| `docker-compose.mail.yml` | The stack. One service, four named volumes, a 640 MiB hard memory cap, SES relay wiring. The image is pinned by multi-arch digest. |
| `mailserver.env` | Every non-secret docker-mailserver setting, with a comment per line explaining the choice. Committed; contains no secrets. |
| `setup-mailboxes.sh` | Idempotent provisioning: creates missing mailboxes with strong random passwords generated on the box, applies quotas, installs the alias map. |
| `postfix-virtual.cf` | The alias map: self-aliases, friendly addresses, role addresses, catch-all. Order is load-bearing. |
| `aliases.md` | What routes where, and why a bare catch-all needs the self-alias block. Read this before editing `postfix-virtual.cf`. |

**Secrets live only in `/opt/circuits-com/.env` on the box** and are never
committed. The stack needs exactly two:

```
SES_SMTP_USERNAME=<smtp username>
SES_SMTP_PASSWORD=<smtp password>
```

Both are `${VAR:?}` interpolations in the compose file, so a missing value is a
startup error, not a mail server that quietly cannot deliver.

## Mailboxes

`anthony@` `daniel@` `matthew@` `ronald@` `no-reply@` — all `@circuitcenter.ai`,
1 GiB quota each.

`demo@` is a **site login identity only and has no mailbox** (`demo/demo` is the
public demo account). Do not provision one for it.

## Run order on a fresh box

Each step depends on the one before it. Out of order, the usual failure is a
mail server running without TLS because the certificate did not exist yet — and
that failure is quiet.

### 0. Prerequisites (other streams / the account owner)

- Instance launched, Elastic IP associated.
- Security group: **25, 465, 587, 993** from `0.0.0.0/0`, plus **80** for the
  ACME HTTP-01 challenge in step 4 (and for Roundcube later). SSH via EC2
  Instance Connect only.
- Docker Engine + the Compose plugin installed, `docker` service enabled.
- **AWS port-25 unblock + PTR request** submitted. Only the account owner can do
  this; it takes 24–48 h and is not guaranteed. Everything below works without
  it — outbound goes via SES regardless. A refusal costs only *direct* port-25
  delivery, which matters for a small fraction of receivers.

### 1. Put the files on the box

```bash
sudo mkdir -p /opt/circuits-com/mail
# copy this directory's contents to /opt/circuits-com/mail/
sudo chmod +x /opt/circuits-com/mail/setup-mailboxes.sh
```

### 2. SES SMTP credentials

In the SES console: **SMTP settings → Create SMTP credentials**. This creates an
IAM user scoped to `ses:SendRawEmail` and shows the derived SMTP password once.

> The SMTP password is **derived** from the IAM secret access key — it is not
> the secret access key itself. Pasting the secret access key here produces a
> `535 Authentication Credentials Invalid` at first send.

Then, on the box:

```bash
sudo touch /opt/circuits-com/.env && sudo chmod 600 /opt/circuits-com/.env
sudo -e /opt/circuits-com/.env
```

and add the two lines, using the values the console showed:

```
SES_SMTP_USERNAME=<smtp username from the console>
SES_SMTP_PASSWORD=<smtp password from the console>
```

Type them in rather than pasting a heredoc into the shell — a heredoc puts both
values in your shell history.

### 3. DNS: the host A record

`mail.circuitcenter.ai` → the Elastic IP, in hosted zone `Z02960201943UQ96RRIAR`.

This must resolve **before** step 4 — Let's Encrypt validates by connecting to
the name.

```bash
dig +short mail.circuitcenter.ai        # must return the EIP
```

Do **not** publish the MX record yet. Mail arriving before the mailboxes exist
would be rejected, and senders cache failures.

### 4. Let's Encrypt certificate

Port 80 must be free and reachable. `certbot/certbot:v5.7.0` is multi-arch
(arm64 verified).

```bash
sudo docker run --rm -p 80:80 \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  certbot/certbot:v5.7.0 certonly --standalone \
  -d mail.circuitcenter.ai \
  --agree-tos --no-eff-email -m no-reply@circuitcenter.ai

sudo test -f /etc/letsencrypt/live/mail.circuitcenter.ai/fullchain.pem && echo OK
```

The path must match the container's `hostname:` exactly — that is where
`SSL_TYPE=letsencrypt` looks.

**Renewal** needs port 80 free again, so it must stop nothing (the mail
container does not bind 80). Add a daily timer running the same command with
`renew`. No container restart hook is required: DMS's change detection watches
`/etc/letsencrypt/live/$HOSTNAME/*.pem` and reloads Postfix and Dovecot on its
own.

### 5. Start the stack

```bash
cd /opt/circuits-com/mail
sudo docker compose --env-file /opt/circuits-com/.env \
  -f docker-compose.mail.yml up -d
```

`--env-file` is **required** — without it Compose cannot resolve the two SES
variables and refuses to start. First boot takes a few minutes on a t4g.micro.

```bash
sudo docker compose --env-file /opt/circuits-com/.env \
  -f docker-compose.mail.yml logs -f mailserver                     # watch
sudo docker inspect -f '{{.State.Health.Status}}' mailserver        # want: healthy
```

### 6. Provision mailboxes and aliases

```bash
cd /opt/circuits-com/mail && sudo ./setup-mailboxes.sh
```

The script waits for the container to be ready, creates the five mailboxes with
20-character random passwords from `openssl`'s CSPRNG, applies the 1 GiB quotas,
and installs `postfix-virtual.cf`.

Passwords are written to **`/opt/circuits-com/mail-credentials.txt` (mode 0600)**
and are never printed, never passed as a command-line argument (so they never
appear in `ps` or in shell history), and never sent anywhere.

Re-running is safe and is the supported way to apply an alias change: an
existing mailbox is left completely alone — its password is not rotated and its
credential line is not rewritten.

The credentials file is append-only. If an address ever appears twice, the
mailbox was deleted and re-created — the line with the **latest timestamp** is
the live password.

### 7. DKIM key, then the rest of DNS

The key does not exist until the container has run, so this step cannot move
earlier.

```bash
cd /opt/circuits-com/mail
sudo docker compose --env-file /opt/circuits-com/.env -f docker-compose.mail.yml \
  exec -T mailserver setup config dkim domain circuitcenter.ai < /dev/null

# Print the TXT record to publish (selector `mail`, RSA 2048):
sudo docker compose --env-file /opt/circuits-com/.env -f docker-compose.mail.yml \
  exec -T mailserver \
  cat /tmp/docker-mailserver/rspamd/dkim/rsa-2048-mail-circuitcenter.ai.public.dns.txt < /dev/null
```

Hand that value to the DNS stream and publish, in this order:

1. **DKIM** `mail._domainkey.circuitcenter.ai` TXT — the value printed above.
   Publish this **before** any mail leaves, or receivers see a DKIM signature
   they cannot verify, which is worse than no signature.
2. **SPF** — widen the existing `v=spf1 include:amazonses.com ~all` to also
   authorise the mail host.
3. **DMARC** `p=none` with `rua=mailto:no-reply@circuitcenter.ai` (what
   `dns/records.json` actually publishes; `dmarc@` aliases to the same inbox).
   Tighten only after a week of clean reports.
4. **MX** `circuitcenter.ai` → `mail.circuitcenter.ai`. **Last.** There is no MX
   record today, so this is the moment mail starts arriving and there is nothing
   to cut over from — zero risk, but also no reason to do it early.

### 8. Point the site at SES

Separate change, on the **web box**: `/opt/circuits-com/.env` gets
`SMTP_HOST=email-smtp.us-east-1.amazonaws.com`, `SMTP_PORT=587` and the same SES
credentials, then `up -d --force-recreate api`. Website form notifications keep
sending from `no-reply@circuitcenter.ai`.

## Verifying

Run these on the box after step 6. All of them are read-only.

```bash
cd /opt/circuits-com/mail
C="sudo docker compose --env-file /opt/circuits-com/.env -f docker-compose.mail.yml"
```

**Container and its memory cap**

```bash
sudo docker inspect -f '{{.State.Health.Status}}' mailserver     # healthy
sudo docker inspect -f '{{.HostConfig.Memory}}' mailserver       # 671088640 (640 MiB)
sudo docker stats --no-stream mailserver                         # real usage vs the cap
```

**Mailboxes and quotas**

```bash
$C exec -T mailserver setup email list < /dev/null
# five accounts, each showing ( used / 1G )
```

**Aliases actually loaded by Postfix** — the file in the repo is intent; this is
what is live:

```bash
$C exec -T mailserver postmap -q anthony@circuitcenter.ai  texthash:/etc/postfix/virtual < /dev/null
# -> anthony@circuitcenter.ai      (correct: the self-alias out-ranks the catch-all)
$C exec -T mailserver postmap -q hello@circuitcenter.ai    texthash:/etc/postfix/virtual < /dev/null
# -> no-reply@circuitcenter.ai
$C exec -T mailserver postmap -q nobody-here@circuitcenter.ai texthash:/etc/postfix/virtual < /dev/null
# -> no-reply@circuitcenter.ai     (catch-all)
```

If the first one returns `no-reply@…`, the catch-all is swallowing real
mailboxes — stop and read `aliases.md`.

**SES relay wiring** — this is the part most likely to be subtly wrong:

```bash
$C exec -T mailserver postconf -n relayhost sender_dependent_relayhost_maps \
    smtp_sasl_auth_enable smtp_tls_security_level < /dev/null
# relayhost = [email-smtp.us-east-1.amazonaws.com]:587
# smtp_sasl_auth_enable = yes
# smtp_tls_security_level = encrypt

$C exec -T mailserver postmap -q @circuitcenter.ai texthash:/etc/postfix/relayhost_map < /dev/null
# -> [email-smtp.us-east-1.amazonaws.com]:587

# The credential key must match those strings CHARACTER FOR CHARACTER, or SES
# answers "530 Authentication required". Password redacted:
$C exec -T mailserver sh -c "cut -d' ' -f1 /etc/postfix/sasl_passwd" < /dev/null
# -> [email-smtp.us-east-1.amazonaws.com]:587
```

**End-to-end send** (after the DNS records are live):

```bash
$C exec -T mailserver sh -c \
  'printf "Subject: p2 relay test\n\nhello\n" | sendmail -f no-reply@circuitcenter.ai you@example.com' < /dev/null
$C exec -T mailserver tail -n 40 /var/log/mail/mail.log < /dev/null
# want: "relay=email-smtp.us-east-1.amazonaws.com... status=sent"
```

Then reply to that message from an external mailbox and confirm it lands, and
check headers at <https://www.mail-tester.com> once MX is live.

**Security controls**

```bash
$C exec -T mailserver fail2ban-client status < /dev/null   # jails listed => NET_ADMIN worked
$C exec -T mailserver postconf -n postscreen_dnsbl_action smtpd_sender_login_maps < /dev/null
```

## Email signatures

Self-owned replacement for the WiseStamp subscription.

**People maintain their own.** Settings → Identities in webmail carries a
"Signature details" section — job title, phone, website, five social links, a
headshot — and the card is rebuilt from those fields on every save. That is the
`ccsignature` plugin; see `roundcube-plugins/ccsignature/README.md`.

The roster below is what a person gets *until* they fill that form in, and what
`no-reply@` gets forever. So it is now the **defaults**, not the source, and
editing it is a fallback rather than the routine path.

| File | What it is |
|---|---|
| `signature-roster.php` | **The defaults.** Every person's name, title, phone, links and headshot, used until they set their own in webmail. `name` is only ever read from here, which is what keeps `no-reply@` (name `''`) rendering the company band alone. Empty fields are correct and normal — each one removes its own row, label included, so a person with nothing but a name and an address still renders deliberately. Never guess at a value. |
| `signature-template.php` | Roster row in, email HTML out. Pure functions, no I/O. The header explains why the markup is tables-and-inline-styles and how it survives dark mode; contrast ratios are recorded next to the colour tokens. |
| `seed-signatures.php` | Writes the HTML into Roundcube's `identities` table. |
| `seed-signatures.sh` | Runs the above inside the container, after backing the database up. |
| `preview-signatures.php` | Prints signatures without touching anything. Runs anywhere PHP does. |

```bash
# see what a roster edit produced, before installing it (no box needed)
php preview-signatures.php                          # all five, as HTML
php preview-signatures.php --page > /tmp/sig.html    # a browsable page

# on the MAIL box — edit the MOUNTED roster, the copy the seeder AND the
# running plugin both read: /opt/circuits-mail/signature/signature-roster.php
cd /opt/circuits-mail
sudo ./seed-signatures.sh --dry-run   # report the changes, write nothing
sudo ./seed-signatures.sh             # install
```

Every run prints the three files it resolved (`template:`, `roster:`, `seam:`).
Check them if an edit appears to do nothing: a copy left at the box root by an
older deploy is inert, and editing that one reports "signature already current"
rather than failing.

Idempotent: a signature that already matches is not rewritten, so re-running is
genuinely free. On an identity that already exists the seeder touches
`signature`, `html_signature` and `changed` and nothing else — it never renames
an identity, moves the default, or deletes anything.

**The seeder respects what people set for themselves.** It reads their stored
fields and prefers them, falling back to the roster, through the same
`ccsig_person()` the plugin uses — so running it after somebody corrected their
own phone number no longer quietly puts the old one back. Anyone who unticked
"Circuit Center signature" is skipped entirely.

- **A pre-created user has no identity.** Roundcube builds a user and its first
  identity together, in `rcube_user::create()`, on first login — but only for a
  user it created itself. `seed-contacts.php` pre-creates `users` rows so a new
  hire's address book is ready before they ever log in, and the side effect is
  that those accounts never get an identity at all: daniel, anthony and ronald
  had all logged in and had none. `seed-signatures.php` creates the missing
  identity too, which is the only time it writes a name or an address (there is
  no prior value to preserve). The `(username, mail_host)` pair is load-bearing
  for the same reason it is in `seed-contacts.php`.
- **An empty display name sends mail as a bare address.** `matthew`'s identity
  predates all of this and has one. `./seed-signatures.sh --fill-blank-names`
  fixes it; it is opt-in because it writes outside the signature columns, and it
  only ever fills a name that is currently empty.
- **Images must be hosted and absolute.** Gmail and Outlook both block `data:`
  URIs, and neither renders SVG, so the company mark is the 180x180
  `apple-touch-icon.png` already served from `frontend/public/images/`. A
  headshot named in the *roster* has to be deployed to the site
  (`./deploy.sh --frontend`) before it renders in anyone's mail client — one
  uploaded through webmail does not, because it is published straight from
  `https://mail.circuitcenter.ai/avatars/` by the `webmail-proxy` container.

## Operating notes

- **`docker compose restart` does not re-read `/opt/circuits-com/.env`.** After
  rotating the SES credentials use
  `up -d --force-recreate mailserver` with `--env-file`.
- **`docker compose exec -T` consumes the caller's stdin.** Inside an
  `ssh <<HEREDOC` it will eat the rest of your script. Always append
  `< /dev/null` — every command above does.
- **Adding a mailbox is two steps.** Create the account, *and* add its
  self-alias to `postfix-virtual.cf`. Miss the second and the catch-all silently
  takes that person's mail. `setup-mailboxes.sh` refuses to install an alias
  file that is missing one.
- **Backups.** The `dms-mail-data` volume is the mail; `dms-config` is what makes
  the box rebuildable (password hashes, aliases, quotas, the DKIM private key).
  Both live under `/var/lib/docker/volumes`, so a nightly EBS snapshot of the
  root volume covers them.
- **Expected startup warnings, not bugs.** One per self-alias:
  `Alias '<addr>' will not be added to '/etc/dovecot/userdb' twice` — DMS
  generates an identical row and de-duplicates it.
- **Memory.** With ClamAV, Amavis and SpamAssassin all off, steady state is
  roughly 330 MB against the 640 MiB cap. If `docker stats` shows it creeping,
  raise the cap only after checking the box's own free memory — the point of the
  cap is that the container dies instead of the host.
