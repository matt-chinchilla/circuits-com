# Mailbox password sync receiver (P3)

The mail-box half of "one password opens the website and the mailbox"
(`docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md`, phase P3).

```
web box (circuitcenter.ai)                         mail box (mail.circuitcenter.ai)
─────────────────────────                          ────────────────────────────────
user sets a password
  ↓ plaintext, in memory, never stored
app/services/sha512_crypt.sha512_crypt()
  ↓ $6$…
app/services/mail_sync.push_password()
  ── POST /sync-password ────────────────────────►  mail_sync_receiver.py
     Authorization: Bearer <shared secret>            ├ bearer check (constant-time)
     {"email": "...", "hash": "$6$..."}               ├ address allowlist
                                                      ├ hash-format check (no plaintext)
                                                      └ atomic rewrite of
                                                        postfix-accounts.cf
```

**The plaintext never leaves the web box.** Only the derived SHA512-crypt hash
crosses, and the receiver rejects anything that is not one — so "hashes only"
is a property this end verifies rather than a promise the other end makes.
**The mail box holds no database credential** and never queries Postgres.

## Files

| File | Purpose |
|---|---|
| `mail_sync_receiver.py` | The whole service. Python 3.9+, **stdlib only** — no pip on a credential path. |
| `circuits-mail-sync.service` | Hardened systemd unit (root, `ProtectSystem=strict`, one writable path). |
| `mail-sync.env.example` | Placeholder env file. Real values go in `/opt/circuits-com/.env`, never in git. |

## Install (mail box)

```bash
sudo install -D -m 0755 mail_sync_receiver.py \
     /opt/circuits-com/mail-sync/mail_sync_receiver.py
sudo install -D -m 0644 circuits-mail-sync.service \
     /etc/systemd/system/circuits-mail-sync.service

# Where docker-mailserver actually keeps its account list. `dms-config` is the
# volume named in mail/docker-compose.mail.yml (mounted at
# /tmp/docker-mailserver/ inside the container). VERIFY — do not assume:
docker volume inspect -f '{{.Mountpoint}}' dms-config
#   -> /var/lib/docker/volumes/dms-config/_data
# If that differs from the default, set MAIL_SYNC_ACCOUNTS_FILE in
# /opt/circuits-com/.env AND update ReadWritePaths= in the unit file — both, or
# the service starts and then 500s on every push.

# Secret — generate ONCE, paste the same value into /opt/circuits-com/.env on
# BOTH boxes:
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
sudo install -D -m 0600 /dev/null /opt/circuits-com/.env
sudo -e /opt/circuits-com/.env        # MAIL_SYNC_SECRET=...

sudo systemctl daemon-reload
sudo systemctl enable --now circuits-mail-sync
systemctl status circuits-mail-sync
curl -sS http://127.0.0.1:8825/healthz     # {"status": "ok"}
```

## Configure (web box)

In `/opt/circuits-com/.env`:

```
MAIL_SYNC_URL=https://mail.circuitcenter.ai:8825
MAIL_SYNC_SECRET=<the same token>
```

then `docker compose ... up -d --force-recreate api`. The api container has no
volume mount, so both values reach it only through the `environment:` block in
the compose files (already wired; guarded by `api/tests/test_mail_sync.py`).
With either value unset the channel is inert — password changes still work,
they simply do not sync.

## Security group

Only the web box may reach the sync port:

```bash
aws ec2 authorize-security-group-ingress \
  --group-id <mail-box-sg> --protocol tcp --port 8825 \
  --cidr <web-box-private-ip>/32
```

Same VPC and AZ (`us-east-1c`), so this traffic is private and free. Do **not**
open 8825 to `0.0.0.0/0`; the bearer token is the second lock, not the first.

## API

`POST /sync-password` — `Authorization: Bearer <secret>`,
`{"email": "<mailbox>", "hash": "$6$..."}` (the `{SHA512-CRYPT}` prefix is
accepted but not required).

| Response | Meaning |
|---|---|
| `200 {"status":"ok","changed":<bool>,"reloaded":<bool>}` | Stored. `changed:false` = the same hash was already there (a replayed push). |
| `400` | Body was not a `$6$…` hash — **this is the plaintext refusal** — or was malformed/oversized. |
| `401` | Bad or missing bearer token. |
| `404` | Address not in the allowlist, or allowlisted but absent from `postfix-accounts.cf` (provisioning is a P2 operation, not something a password sync invents). |
| `500` | Accounts file unreadable/unwritable. |

`GET /healthz` — unauthenticated liveness. Returns `{"status":"ok"}` and
nothing else: no version, no account data, no configuration.

## Operating notes

- **Drift is visible, never silent.** A failed push does not fail the user's
  password change — the site marks `users.mail_sync_pending` and retries on
  that user's next successful login (the one other moment it legitimately
  holds the plaintext). `GET /api/auth/me` reports the flag.
- **Idempotent.** Re-pushing the same hash is a no-op `200`, which is what
  makes the retry safe to run as often as it likes.
- **Provisioning is separate.** This service never creates an account. Add
  mailboxes with `mail/setup-mailboxes.sh` (or docker-mailserver's own
  `setup email add`), then sync. The bootstrap passwords that script writes are
  replaced the first time each person changes their site password.
- **The atomic rewrite replaces the inode**, which is fine: docker-mailserver's
  change detector compares a checksum of the file's *contents*, and the
  container watches the volume directory.
- **Adding a sixth mailbox** = add the address to `MAIL_SYNC_ALLOWED_ACCOUNTS`
  here *and* `MAIL_SYNC_MAILBOXES` on the web box. Both default to the same
  five; leaving one behind means that account silently never syncs.
- **Logs**: `journalctl -u circuits-mail-sync -f`. The hash and the secret are
  never logged; the address and outcome are.

## Verify end to end

```bash
# On the web box, after configuring both values:
#   change a password in the admin console, then
curl -sS -H "Authorization: Bearer $MAIL_SYNC_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"email":"matthew@circuitcenter.ai","hash":"not-a-hash"}' \
     https://mail.circuitcenter.ai:8825/sync-password
# -> 400 hash must be SHA512-crypt ($6$...)   ← the plaintext refusal, live
```

Then confirm the mailbox itself accepts the new password over IMAP
(`openssl s_client -connect mail.circuitcenter.ai:993 -crlf`) — the file being
right and the running server agreeing are two different claims.
