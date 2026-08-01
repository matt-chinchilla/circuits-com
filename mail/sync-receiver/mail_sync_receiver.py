#!/usr/bin/env python3
"""circuitcenter.ai mailbox password receiver — the mail-box half of P3.

One password opens the website and the mailbox
(``docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md``, P3). The
SITE holds the plaintext, derives the SHA512-crypt hash there, and POSTs
``{email, hash}`` here. This service rewrites that one account's line in
docker-mailserver's ``postfix-accounts.cf`` and lets the mail stack pick it up.

Non-negotiables, in the order they are enforced:

1. **Hashes only, never plaintext.** The body's ``hash`` must match the
   ``$6$…`` crypt format or the request is rejected. That is not a formality —
   it is what makes "the plaintext never leaves the web box" a property this
   end can *verify* rather than merely trust. There is deliberately no
   ``password`` field and no hashing done here.
2. **Shared-secret bearer auth**, compared with ``hmac.compare_digest`` so the
   check cannot be walked byte by byte. The secret lives only in
   ``/opt/circuits-com/.env`` on this host and on the web box.
3. **A closed allowlist of addresses.** Only the five provisioned mailboxes are
   writable, so a stolen token cannot create an account, rewrite an alias, or
   touch a line this service was never meant to own.
4. **Existing accounts only.** An address that is allowlisted but absent from
   the accounts file is a 404 — provisioning is a deliberate P2 operation, not
   something a password sync invents.

Stdlib only, on purpose: this box runs Amazon Linux 2023 with no application
Python environment, and a credential path is the last place to want a pip tree.
Written to run on Python 3.9+ (AL2023's ``python3``).

Run it under the shipped systemd unit (``circuits-mail-sync.service``). Every
setting comes from the environment — nothing here is configured by editing this
file, and no secret is ever written into it:

    MAIL_SYNC_SECRET          (required) shared bearer token, >= 32 chars
    MAIL_SYNC_BIND            default 0.0.0.0   — the security group is what
                                                  actually restricts callers to
                                                  the web box
    MAIL_SYNC_PORT            default 8825
    MAIL_SYNC_ACCOUNTS_FILE   default /var/lib/docker/volumes/dms-config/_data/postfix-accounts.cf
    MAIL_SYNC_ALLOWED_ACCOUNTS  CSV, default the five provisioned mailboxes
    MAIL_SYNC_TLS_CERT / MAIL_SYNC_TLS_KEY   optional; serve HTTPS when both set
    MAIL_SYNC_RELOAD_CMD      optional explicit reload (see RELOAD below)

RELOAD — docker-mailserver's own change detector watches ``postfix-accounts.cf``
and regenerates the Dovecot/Postfix maps within a few seconds of it changing, so
the default is to write the file and let it do its job. ``MAIL_SYNC_RELOAD_CMD``
is there for an installation that has that detector disabled; a failing reload
is reported in the response (``"reloaded": false``) rather than hidden, because
"the file says the new password but the running server doesn't" is exactly the
drift this whole channel exists to make visible.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import shlex
import ssl
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = logging.getLogger("mail-sync")

# The one write route, and an unauthenticated liveness probe that reveals
# nothing (no version, no account data, no configuration).
SYNC_PATH = "/sync-password"
HEALTH_PATH = "/healthz"

# A password hash is ~130 bytes; 4 KiB is generous. Bounded so an unauthenticated
# caller cannot make this process buffer a large body before the token check.
MAX_BODY_BYTES = 4096

# Dovecot's name for the format, and what docker-mailserver writes itself
# (`doveadm pw -s SHA512-CRYPT`). Always emitted explicitly so the stored line
# is self-describing regardless of any default_pass_scheme setting.
SCHEME = "{SHA512-CRYPT}"

# Same contract as app/services/sha512_crypt.SHA512_CRYPT_RE on the site side.
# THIS is the "no plaintext" gate: no human-typed password can match it.
SHA512_CRYPT_RE = re.compile(r"^\$6\$(?:rounds=\d{4,9}\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$")

# Mirrors app/config.py Settings.MAIL_SYNC_MAILBOXES. `demo@` is a website
# login identity with no mailbox and is deliberately absent.
DEFAULT_ACCOUNTS = (
    "anthony@circuitcenter.ai",
    "daniel@circuitcenter.ai",
    "matthew@circuitcenter.ai",
    "ronald@circuitcenter.ai",
    "no-reply@circuitcenter.ai",
)

# docker-mailserver keeps its account list in the `dms-config` Docker volume
# (`mail/docker-compose.mail.yml` names it explicitly, mounted at
# /tmp/docker-mailserver/ inside the container), so the host-side path is the
# volume's mountpoint. Confirm it on the box rather than trusting this default:
#     docker volume inspect -f '{{.Mountpoint}}' dms-config
# and override with MAIL_SYNC_ACCOUNTS_FILE if it differs.
#
# The atomic rewrite replaces the inode. That is safe here: docker-mailserver's
# change detector compares a CHECKSUM of the file's contents, not its inode, and
# the container sees the volume directory itself — so the new file is picked up
# exactly like one written from inside.
DEFAULT_ACCOUNTS_FILE = "/var/lib/docker/volumes/dms-config/_data/postfix-accounts.cf"

# A secret short enough to be guessable is worse than none, because it looks
# like protection. Refuse to start rather than serve with one.
MIN_SECRET_LENGTH = 32

# One writer at a time. Requests are rare (a handful per year per account), but
# two overlapping rewrites of the same file would race a whole account list into
# the void — cheap insurance against an expensive, silent loss.
_write_lock = threading.Lock()


class Config:
    """Everything this service needs, resolved once at startup.

    A plain object rather than module globals so the test suite can build one
    pointing at a temp file and drive the REAL handler
    (api/tests/test_mail_sync.py) instead of a re-implementation of it.
    """

    def __init__(
        self,
        secret,
        accounts_file=DEFAULT_ACCOUNTS_FILE,
        allowed_accounts=DEFAULT_ACCOUNTS,
        reload_cmd="",
        bind="0.0.0.0",
        port=8825,
        tls_cert="",
        tls_key="",
    ):
        self.secret = secret
        self.accounts_file = accounts_file
        self.allowed_accounts = frozenset(a.strip().lower() for a in allowed_accounts if a.strip())
        self.reload_cmd = reload_cmd
        self.bind = bind
        self.port = port
        self.tls_cert = tls_cert
        self.tls_key = tls_key


def _csv_env(name, default):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def config_from_env():
    """Build the runtime config, or exit non-zero with a reason.

    Fail-CLOSED on a missing/short secret: a credential endpoint that starts
    without authentication would be a silent hole, and systemd restart-looping
    with a clear journal line is the loud failure we want instead.
    """
    secret = os.environ.get("MAIL_SYNC_SECRET", "").strip()
    if len(secret) < MIN_SECRET_LENGTH:
        sys.exit(
            "MAIL_SYNC_SECRET is missing or shorter than %d characters — refusing to start. "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_urlsafe(48))\" "
            "and put it in /opt/circuits-com/.env on BOTH this host and the web box."
            % MIN_SECRET_LENGTH
        )
    return Config(
        secret=secret,
        accounts_file=os.environ.get("MAIL_SYNC_ACCOUNTS_FILE", DEFAULT_ACCOUNTS_FILE),
        allowed_accounts=_csv_env("MAIL_SYNC_ALLOWED_ACCOUNTS", DEFAULT_ACCOUNTS),
        reload_cmd=os.environ.get("MAIL_SYNC_RELOAD_CMD", "").strip(),
        bind=os.environ.get("MAIL_SYNC_BIND", "0.0.0.0"),
        port=int(os.environ.get("MAIL_SYNC_PORT", "8825")),
        tls_cert=os.environ.get("MAIL_SYNC_TLS_CERT", "").strip(),
        tls_key=os.environ.get("MAIL_SYNC_TLS_KEY", "").strip(),
    )


# ── Pure helpers (unit-tested directly) ─────────────────────────────────────


def token_matches(auth_header, secret):
    """Constant-time bearer check.

    ``compare_digest`` on the token so a wrong secret cannot be recovered one
    byte at a time from response timing. The scheme prefix is compared normally
    — it is not secret.
    """
    header = (auth_header or "").strip()
    prefix = "Bearer "
    if not header.startswith(prefix):
        return False
    # Compared as BYTES: compare_digest raises TypeError on a non-ASCII str, and
    # a secret someone typed by hand with one accented character would then blow
    # up mid-request — a connection reset that reads like a network fault
    # instead of "your token is wrong".
    return hmac.compare_digest(header[len(prefix) :].strip().encode(), (secret or "").encode())


def normalize_hash(value):
    """Return the bare ``$6$…`` hash, or None if this isn't one.

    Accepts the hash with or without a leading ``{SHA512-CRYPT}`` so the site
    may send either form; anything else — a plaintext password, an MD5 crypt, a
    bcrypt string, an empty field — is None and the request dies.
    """
    # str(): the body is attacker-shaped JSON, so `hash` can arrive as a number,
    # a list or an object. Coercing keeps the regex below the ONE gate instead
    # of letting a type error decide the outcome.
    candidate = str(value or "").strip()
    if candidate.upper().startswith(SCHEME):
        candidate = candidate[len(SCHEME) :]
    if not SHA512_CRYPT_RE.match(candidate):
        return None
    return candidate


def rewrite_accounts(text, email, hashed):
    """Return ``(new_text, found)`` with ``email``'s line repointed at ``hashed``.

    docker-mailserver's format is one ``address|{SCHEME}hash`` per line. Only
    the matching line is touched — every other byte of the file, comments and
    blank lines included, is preserved verbatim, because this file is the
    authoritative account list for the whole mail server and a password sync has
    no business reformatting it.

    ``found`` is False when the address has no line: the caller answers 404
    rather than appending. Creating an account is provisioning, not syncing —
    and an account created here would have no maildir, no quota and no alias.
    """
    target = (email or "").strip().lower()
    lines = text.split("\n")
    found = False
    for index, line in enumerate(lines):
        if "|" not in line:
            continue
        address = line.split("|", 1)[0].strip().lower()
        if address == target:
            lines[index] = "%s|%s%s" % (line.split("|", 1)[0].strip(), SCHEME, hashed)
            found = True
    return "\n".join(lines), found


def write_accounts_file(path, text):
    """Replace the accounts file atomically, preserving mode and ownership.

    Written to a temp file in the SAME directory then ``os.replace``d, so a
    crash mid-write can never leave a truncated account list — which would lock
    every mailbox out at once. Mode/owner are copied from the original because
    docker-mailserver reads this file from inside its container.
    """
    directory = os.path.dirname(os.path.abspath(path)) or "."
    stat_before = os.stat(path)
    fd, temp_path = tempfile.mkstemp(dir=directory, prefix=".mail-sync-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, stat_before.st_mode & 0o7777)
        try:
            os.chown(temp_path, stat_before.st_uid, stat_before.st_gid)
        except PermissionError:
            # Only reachable when not running as root (i.e. in tests); the
            # rename still produces a correct file owned by the caller.
            pass
        os.replace(temp_path, path)
    except BaseException:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise
    # fsync the DIRECTORY too: os.replace is atomic, but the rename itself is
    # only durable once the directory entry is flushed.
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def run_reload(reload_cmd):
    """Run the optional reload command. True when it isn't needed or succeeded."""
    if not reload_cmd:
        return True
    try:
        # shlex.split + no shell: the command comes from our own unit file, but
        # a shell here would be one config typo away from an injection surface.
        completed = subprocess.run(
            shlex.split(reload_cmd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001
        LOG.warning("reload command failed to run (%r)", exc)
        return False
    if completed.returncode != 0:
        LOG.warning("reload command exited %s", completed.returncode)
        return False
    return True


def apply_password(config, email, hashed):
    """Do the write. Returns (status_code, payload)."""
    try:
        # encoding pinned: systemd starts services with no LANG, so the default
        # locale encoding can be ASCII — one non-ASCII byte anywhere in the file
        # would then raise mid-request instead of syncing.
        with open(config.accounts_file, encoding="utf-8") as handle:
            text = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        LOG.error("cannot read accounts file %s (%r)", config.accounts_file, exc)
        return 500, {"status": "error", "detail": "accounts file unavailable"}

    new_text, found = rewrite_accounts(text, email, hashed)
    if not found:
        return 404, {"status": "error", "detail": "mailbox not provisioned"}
    if new_text == text:
        # Same hash already stored — a retry of a push whose response was lost.
        # Report success without touching the file: idempotency is what makes
        # the site's retry-on-next-login safe to run as often as it likes.
        return 200, {"status": "ok", "changed": False, "reloaded": True}
    try:
        write_accounts_file(config.accounts_file, new_text)
    except OSError as exc:
        LOG.error("cannot write accounts file %s (%r)", config.accounts_file, exc)
        return 500, {"status": "error", "detail": "accounts file not writable"}
    reloaded = run_reload(config.reload_cmd)
    LOG.info("updated mailbox password for %s (reloaded=%s)", email, reloaded)
    return 200, {"status": "ok", "changed": True, "reloaded": reloaded}


# ── HTTP ────────────────────────────────────────────────────────────────────


class SyncHandler(BaseHTTPRequestHandler):
    # Neutral banner — the default advertises the exact Python and
    # BaseHTTPServer versions to anyone who port-scans this host.
    server_version = "circuitcenter-mail-sync"
    sys_version = ""
    # HTTP/1.0: every response closes the connection, so there is no keep-alive
    # state for an unauthenticated caller to hold open.
    protocol_version = "HTTP/1.0"
    timeout = 15

    @property
    def config(self):
        return self.server.config

    def log_message(self, fmt, *args):
        # Through logging (journal), and only the request line — never a body.
        LOG.info("%s %s", self.address_string(), fmt % args)

    # Set by _respond so the crash guard in do_POST can tell "died before
    # answering" (send a 500) from "died after" (say nothing, or the client
    # gets a second set of headers glued onto the first response).
    responded = False

    def _respond(self, code, payload):
        self.responded = True
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # This endpoint is machine-to-machine; no browser should ever be
        # induced to call it cross-origin or cache its answer.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        if self.path.split("?")[0] == HEALTH_PATH:
            self._respond(200, {"status": "ok"})
            return
        self._respond(404, {"status": "error", "detail": "not found"})

    def do_POST(self):  # noqa: N802
        """Crash guard around the real work.

        Without it an unexpected exception propagates into socketserver, which
        closes the socket with no response — the caller sees a connection reset,
        i.e. something indistinguishable from a network fault. A 500 says "the
        mail box heard you and failed", which is what the site's log and the
        operator both need.
        """
        try:
            self._sync_password()
        except Exception:  # noqa: BLE001
            LOG.exception("unhandled error while syncing")
            if not self.responded:
                self._respond(500, {"status": "error", "detail": "internal error"})

    def _sync_password(self):
        if self.path.split("?")[0] != SYNC_PATH:
            self._respond(404, {"status": "error", "detail": "not found"})
            return

        # AUTH FIRST — before parsing anything, so an unauthenticated caller
        # never reaches the JSON parser or the account list.
        if not token_matches(self.headers.get("Authorization"), self.config.secret):
            LOG.warning("rejected unauthenticated sync from %s", self.address_string())
            self._respond(401, {"status": "error", "detail": "unauthorized"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._respond(400, {"status": "error", "detail": "bad content-length"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(400, {"status": "error", "detail": "bad body size"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode())
            if not isinstance(payload, dict):
                raise ValueError("not an object")
        except Exception:  # noqa: BLE001
            self._respond(400, {"status": "error", "detail": "invalid json"})
            return

        email = str(payload.get("email") or "").strip().lower()
        if not email or email not in self.config.allowed_accounts:
            # Not an oracle worth worrying about: reaching this line already
            # required the shared secret, and the mailbox list is public-facing
            # anyway (it is who you email to reach the company).
            LOG.warning("rejected sync for non-mailbox address %r", email)
            self._respond(404, {"status": "error", "detail": "unknown mailbox"})
            return

        hashed = normalize_hash(payload.get("hash"))
        if hashed is None:
            # Covers the one thing this service must never accept: a plaintext
            # password. Logged without the value.
            LOG.warning("rejected sync for %s: body was not a SHA512-crypt hash", email)
            self._respond(400, {"status": "error", "detail": "hash must be SHA512-crypt ($6$...)"})
            return

        with _write_lock:
            code, response = apply_password(self.config, email, hashed)
        self._respond(code, response)


class SyncServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, config, handler=SyncHandler):
        ThreadingHTTPServer.__init__(self, (config.bind, config.port), handler)
        self.config = config


def build_server(config):
    server = SyncServer(config)
    if config.tls_cert and config.tls_key:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(config.tls_cert, config.tls_key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    else:
        # Not fatal — the security group is the primary control and the payload
        # is a hash, not a password — but it IS a downgrade from the design, so
        # say so once, loudly, in the journal.
        LOG.warning(
            "serving PLAIN HTTP (MAIL_SYNC_TLS_CERT/KEY unset). The design calls "
            "for HTTPS; only run this way while the certificate is pending."
        )
    return server


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    config = config_from_env()
    server = build_server(config)
    LOG.info(
        "listening on %s:%s, accounts file %s, %d allowed mailboxes",
        config.bind,
        config.port,
        config.accounts_file,
        len(config.allowed_accounts),
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
