"""SHA512-crypt (`$6$…`) — the hash format Dovecot/docker-mailserver stores.

THE one place the site derives a mailbox credential. P3 push-sync (see
``docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md``) keeps the
plaintext on the web box and ships only this derived hash to the mail box, so
this module is the boundary between "we know the password" and "the mail box
knows a verifier".

Why hand-rolled rather than ``crypt.crypt`` or passlib:

* ``crypt`` is deprecated in 3.11 and **removed in Python 3.13**. The api image
  is python:3.12-slim today, so importing it would work — and would turn into a
  hard ImportError the day the base image is bumped, at the exact moment
  everyone's mailbox password silently stops syncing. It also only exists on
  Unix, so it breaks any non-Linux dev box.
* passlib is an extra runtime dependency for ~90 lines of well-specified
  arithmetic, is itself unmaintained since 2020, and its own ``os_crypt``
  backend has the same 3.13 problem.

The algorithm is Ulrich Drepper's SHA-crypt specification (the same one glibc,
Dovecot and ``doveadm pw -s SHA512-CRYPT`` implement). It is fully pinned by
published test vectors — see ``tests/test_mail_sync.py``, which checks those
vectors AND cross-checks every hash this module produces against the stdlib
``crypt`` module wherever that module still exists. A wrong implementation here
would lock five people out of their mail, so it is tested against an
independent oracle rather than against itself.
"""

import hashlib
import re
import secrets

# The crypt(3) base64 alphabet — NOT RFC 4648. Order matters: '.' and '/' come
# first, and digits precede letters.
B64_ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

# glibc's default and what `doveadm pw -s SHA512-CRYPT` emits. Written into the
# hash string only when it differs (a `$6$rounds=5000$…` and a `$6$…` with the
# same salt are the same hash, but only the bare form is byte-identical to what
# docker-mailserver writes itself).
DEFAULT_ROUNDS = 5000
MIN_ROUNDS = 1000
MAX_ROUNDS = 999_999_999
SALT_LENGTH = 16

# The spec's byte permutation for the final base64 pass: each triple is
# (b2, b1, b0) and yields 4 characters, then byte 63 alone yields 2 — 86 chars
# total. This scrambling is part of the format; emitting the digest in natural
# order produces a hash no other implementation will verify.
_PERMUTATION = (
    (0, 21, 42),
    (22, 43, 1),
    (44, 2, 23),
    (3, 24, 45),
    (25, 46, 4),
    (47, 5, 26),
    (6, 27, 48),
    (28, 49, 7),
    (50, 8, 29),
    (9, 30, 51),
    (31, 52, 10),
    (53, 11, 32),
    (12, 33, 54),
    (34, 55, 13),
    (56, 14, 35),
    (15, 36, 57),
    (37, 58, 16),
    (59, 17, 38),
    (18, 39, 60),
    (40, 61, 19),
    (62, 20, 41),
)

# What a well-formed result looks like, with or without the optional
# `rounds=` field. The receiver on the mail box enforces the same shape — that
# shared contract is what makes "hashes only, never plaintext" checkable at the
# far end rather than merely promised at this one.
SHA512_CRYPT_RE = re.compile(r"^\$6\$(?:rounds=\d{4,9}\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$")


def _repeat_to(block: bytes, length: int) -> bytes:
    """`block` repeated/truncated to exactly `length` bytes."""
    if length <= 0:
        return b""
    full, rest = divmod(length, len(block))
    return block * full + block[:rest]


def _b64_encode(digest: bytes) -> str:
    out: list[str] = []
    for b2, b1, b0 in _PERMUTATION:
        w = (digest[b2] << 16) | (digest[b1] << 8) | digest[b0]
        for _ in range(4):
            out.append(B64_ALPHABET[w & 0x3F])
            w >>= 6
    w = digest[63]
    for _ in range(2):
        out.append(B64_ALPHABET[w & 0x3F])
        w >>= 6
    return "".join(out)


def generate_salt(length: int = SALT_LENGTH) -> str:
    """A fresh cryptographically-random salt from the crypt(3) alphabet."""
    return "".join(secrets.choice(B64_ALPHABET) for _ in range(length))


def sha512_crypt(password: str, salt: str | None = None, rounds: int = DEFAULT_ROUNDS) -> str:
    """Return the ``$6$<salt>$<86 chars>`` hash of ``password``.

    ``salt`` defaults to 16 fresh random characters — pass one only to
    reproduce a known vector (i.e. from tests). ``rounds`` outside the spec's
    1000…999999999 range is clamped, matching glibc.
    """
    rounds = max(MIN_ROUNDS, min(MAX_ROUNDS, int(rounds)))
    if salt is None:
        salt = generate_salt()
    # The format terminates the salt at '$' and caps it at 16 characters; doing
    # that here (rather than trusting the caller) keeps the returned string and
    # the bytes actually hashed in agreement.
    salt = salt.split("$")[0][:SALT_LENGTH]

    key = password.encode()
    salt_bytes = salt.encode()

    # Digest B — the "alternate" sum.
    digest_b = hashlib.sha512(key + salt_bytes + key).digest()

    # Digest A.
    ctx = hashlib.sha512()
    ctx.update(key)
    ctx.update(salt_bytes)
    ctx.update(_repeat_to(digest_b, len(key)))
    # For each bit of len(key), low bit first: set -> B, clear -> the key.
    count = len(key)
    while count:
        ctx.update(digest_b if count & 1 else key)
        count >>= 1
    digest_a = ctx.digest()

    # Sequence P — the key, hashed len(key) times, stretched to len(key) bytes.
    dp = hashlib.sha512()
    for _ in range(len(key)):
        dp.update(key)
    seq_p = _repeat_to(dp.digest(), len(key))

    # Sequence S — the salt, hashed 16 + A[0] times, stretched to len(salt).
    ds = hashlib.sha512()
    for _ in range(16 + digest_a[0]):
        ds.update(salt_bytes)
    seq_s = _repeat_to(ds.digest(), len(salt_bytes))

    # The stretching loop. This is the whole cost of the hash; every branch is
    # on the ROUND NUMBER, never on secret data, so there is nothing here for a
    # timing side channel to read.
    digest_c = digest_a
    for i in range(rounds):
        ctx = hashlib.sha512()
        ctx.update(seq_p if i & 1 else digest_c)
        if i % 3:
            ctx.update(seq_s)
        if i % 7:
            ctx.update(seq_p)
        ctx.update(digest_c if i & 1 else seq_p)
        digest_c = ctx.digest()

    prefix = "$6$" if rounds == DEFAULT_ROUNDS else f"$6$rounds={rounds}$"
    return f"{prefix}{salt}${_b64_encode(digest_c)}"


def is_sha512_crypt(value: str) -> bool:
    """True for a well-formed ``$6$…`` hash — used as the "this is NOT a
    plaintext password" gate on both ends of the sync."""
    return bool(SHA512_CRYPT_RE.match(value or ""))
