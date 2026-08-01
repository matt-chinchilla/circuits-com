# Aliases and the catch-all

The alias configuration lives in [`postfix-virtual.cf`](./postfix-virtual.cf).
`setup-mailboxes.sh` installs it into the container's config volume; DMS copies
it verbatim to `/etc/postfix/virtual` and reloads Postfix within a few seconds.

## What is routed where

| Address | Delivers to | Why it exists |
|---|---|---|
| `anthony@` `daniel@` `matthew@` `ronald@` `no-reply@` | themselves | Real mailboxes. The identity entries are what keeps the catch-all from swallowing them — see below. |
| `hello@` `contact@` `info@` `sales@` `support@` | `no-reply@` | Friendly public addresses for the shared company inbox. |
| `postmaster@` `abuse@` `dmarc@` | `no-reply@` | Role addresses. `postmaster@` is effectively mandatory (RFC 5321); `dmarc@` is the `rua=mailto:` target for aggregate reports. |
| **everything else** `@circuitcenter.ai` | `no-reply@` | Catch-all. Nothing addressed to the domain is ever lost. |

`no-reply@` is the shared role account the admin console ingests over IMAP in
P4a, so all of the above land in one place everybody can see.

Publish `hello@` or `contact@` on the site rather than `no-reply@`. "no-reply"
is conventionally a send-only identity and tells a customer not to reply — the
exact opposite of what this inbox is for. It is the same mailbox either way.

## The trap: a bare `@domain` catch-all hijacks real mailboxes

This is the one thing to understand before editing the file.

Postfix resolves a recipient against `virtual_alias_maps` by trying, in order:

1. `user@domain`
2. `@domain`

A real mailbox is **not** in `virtual_alias_maps` — it is in
`virtual_mailbox_maps`, which is consulted *later*. So with only a catch-all in
place, `anthony@circuitcenter.ai` misses step 1, matches the `@circuitcenter.ai`
wildcard at step 2, and gets rewritten to `no-reply@` before the mailbox lookup
ever happens. Anthony's mailbox stays empty. Nothing errors, nothing bounces,
nothing appears in a log you would think to read.

Upstream documents the fix: give **every** real address an identity entry
(`anthony@… → anthony@…`), declared **above** the wildcard. Those entries win at
step 1, so the wildcard only ever sees addresses that have no mailbox.

Postfix does not loop on an identity mapping — `cleanup(8)` stops expanding an
address that expanded into itself.

### Consequence for every new mailbox

Adding a mailbox is **two** steps, not one:

1. create the account (`setup-mailboxes.sh`, or `setup email add`)
2. add its self-alias line to `postfix-virtual.cf` and reinstall

Miss step 2 and the new person's mail goes to the shared inbox instead of to
them, silently.

`setup email add` refuses to create an account that already exists as an alias,
and `setup alias add` refuses to create an alias that matches an account — so
the CLI cannot create these identity entries at all. They are hand-edited. That
is the upstream-documented workaround, not a shortcut.

`setup-mailboxes.sh` guards this: before installing the file it checks that
every account it manages has a self-alias line, and aborts without touching the
container if one is missing.

## Known trade-offs of running a catch-all

Accepted deliberately; listed so nobody rediscovers them as bugs.

- **It is a spam magnet.** Every random local-part is a valid recipient, so
  dictionary attacks land instead of being rejected at RCPT time. Mitigated by
  postscreen (`POSTSCREEN_ACTION=enforce`), rspamd scoring into Junk, and
  fail2ban. If volume becomes a real problem, the escalation is
  `ENABLE_DNSBL=1` in `mailserver.env` before removing the catch-all.
- **Quota checks do not apply to catch-all recipients at RCPT time.** DMS
  pre-registers alias addresses in Dovecot's userdb so Postfix's `quota-status`
  policy service can reject over-quota mail during the SMTP conversation. That
  workaround only handles aliases naming a single real address; a wildcard
  cannot be enumerated. So mail to an unknown local-part is accepted first and
  quota is enforced at delivery, which can produce a bounce (backscatter) if
  `no-reply@` is full. Keeping `no-reply@` under its 1 GiB quota is what keeps
  this theoretical.
- **Aliases are logins.** DMS writes one Dovecot passwd-file row per alias
  carrying the *target's* password hash, and that file is both the passdb and
  the userdb. So `hello@circuitcenter.ai` + `no-reply@`'s password is a working
  IMAP login into `no-reply@`'s mailbox. No privilege is gained — you already
  need that password — and `SPOOF_PROTECTION=1` relies on this mapping to let
  `no-reply@` send *as* `hello@`. Worth knowing before it surprises you in a log.

## Turning the catch-all off

Delete the last line of `postfix-virtual.cf`:

```
@circuitcenter.ai           no-reply@circuitcenter.ai
```

then reinstall (`./setup-mailboxes.sh` is safe to re-run). Unknown addresses
then get a `550 User unknown` at RCPT time — no spam magnet, and no more
silently-collected typos either. The self-alias block becomes redundant at that
point but is harmless; leave it, so re-enabling the catch-all is a one-line
change rather than a five-line one.

## Editing safely

1. Edit `mail/postfix-virtual.cf` in the repo, commit it.
2. Pull on the box and re-run `./setup-mailboxes.sh` (idempotent — it will not
   touch existing mailboxes or passwords).
3. Confirm what Postfix actually loaded, which is the only thing that counts:

```bash
docker compose -f docker-compose.mail.yml exec -T mailserver \
  cat /etc/postfix/virtual < /dev/null

# Resolve a specific address through the real map:
docker compose -f docker-compose.mail.yml exec -T mailserver \
  postmap -q anthony@circuitcenter.ai texthash:/etc/postfix/virtual < /dev/null
# -> anthony@circuitcenter.ai        (correct)
# -> no-reply@circuitcenter.ai       (WRONG - the self-alias is missing or
#                                     is below the wildcard)

docker compose -f docker-compose.mail.yml exec -T mailserver \
  postmap -q definitely-not-a-user@circuitcenter.ai texthash:/etc/postfix/virtual < /dev/null
# -> no-reply@circuitcenter.ai       (catch-all working)
```

The `< /dev/null` is not decoration: `docker compose exec -T` consumes the
caller's stdin, which eats the rest of the script when these run inside an
`ssh <<HEREDOC`.
