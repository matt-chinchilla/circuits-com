# syntax=docker/dockerfile:1.6
# ─────────────────────────────────────────────────────────────────────────────
# API Dockerfile.
#
# Perf optimizations (2026-06-02):
#   1. .dockerignore drops __pycache__ + .pytest_cache + .ruff_cache + the
#      local test.db from the build context, keeping the image clean.
#   2. BuildKit cache mounts on /root/.cache/uv + /root/.cache/pip persist
#      wheels across builds — even when pyproject.toml changes, only the
#      diff downloads. Requires DOCKER_BUILDKIT=1 (Docker 23+ default) and
#      the syntax pin at the top of this file.
#   3. `uv pip install --system -e .` installs only `[project] dependencies`
#      (prod set). Dev deps live under `[project.optional-dependencies].dev`
#      and never reach the image.
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.12-slim
WORKDIR /app

# uv as the installer — far faster than pip's solver and parallelizes fetches.
# Cached so the next build re-uses the same uv binary.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install uv

COPY pyproject.toml .
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=cache,target=/root/.cache/pip \
    uv pip install --system -e .

# ── GeoIP databases (DB-IP Lite, CC-BY 4.0 — https://db-ip.com) ─────────
# City (~124MB) and ASN (~9MB), fetched in ONE cached layer BEFORE `COPY . .`
# so a code change never re-fetches either file.
#
# THE MONTH IS RESOLVED AT BUILD TIME, NOT PINNED. DB-IP's CDN keeps only the
# current and previous month (probed 2026-08-30: 2026-08→206, 2026-07→206,
# 2026-06→404, 2026-09→404), so a hardcoded month is a landmine that detonates
# on the first cache-busted build after it expires — and `docker builder
# prune -af` is this repo's documented disk-reclaim step. The script walks
# today's month back two; `--build-arg DBIP_MONTH=YYYY-MM` overrides for a
# reproducible build. The RUN string never changes, so the layer still caches.
#
# They download straight into the app's data directory rather than a staging
# path because COPY MERGES into an existing directory — the context's
# committed country-lite file lands BESIDE them without removing them — so the
# image carries exactly one copy of each instead of two. That is also why
# .dockerignore excludes the local city and ASN files from the context: they
# would only overwrite these, and at the cost of shipping them twice.
#
# HARD FAILURE (after the walk-back) is deliberate. A soft fall-through would
# leave geoip.py quietly serving country-only results from the committed
# fallback, and nobody would notice the map had lost its cities for weeks. A
# broken build is loud. The per-file reader probe is what makes that guarantee
# real — a truncated stream can still gunzip, and a blob that is not a
# database would otherwise be found by production rather than by the build.
ARG DBIP_MONTH=""
RUN python - <<'GEOIP'
import datetime, gzip, os, shutil, urllib.error, urllib.request
import maxminddb

data_dir = "/app/app/data"
os.makedirs(data_dir, exist_ok=True)

# db-ip.com answers 403 to urllib's DEFAULT User-Agent. Any explicit one is
# accepted; this is not an auth token, just a name for their logs. Measured,
# not guessed — the build failed on exactly this before the header was added.
UA = {"User-Agent": "circuitcenter-build/1.0"}


def url_for(edition, month):
    return f"https://download.db-ip.com/free/dbip-{edition}-lite-{month}.mmdb.gz"


def candidate_months():
    pinned = os.environ.get("DBIP_MONTH", "").strip()
    if pinned:
        return [pinned]
    day = datetime.date.today().replace(day=1)
    months = []
    for _ in range(3):
        months.append(day.strftime("%Y-%m"))
        day = (day - datetime.timedelta(days=1)).replace(day=1)
    return months


def resolve_month():
    tried = candidate_months()
    for month in tried:
        probe = urllib.request.Request(url_for("city", month), headers=UA, method="HEAD")
        try:
            with urllib.request.urlopen(probe, timeout=60):
                return month
        except urllib.error.HTTPError as err:
            if err.code == 404:
                continue
            raise
    raise SystemExit(
        f"No DB-IP release found for any of {tried}. DB-IP keeps only the newest "
        "months; pass --build-arg DBIP_MONTH=YYYY-MM (the ARG above this RUN) "
        "with a month that exists at download.db-ip.com/free/."
    )


def fetch(edition, month, probe):
    out = os.path.join(data_dir, f"dbip-{edition}-lite.mmdb")
    request = urllib.request.Request(url_for(edition, month), headers=UA)
    with urllib.request.urlopen(request, timeout=180) as response:
        with gzip.GzipFile(fileobj=response) as unzipped, open(out, "wb") as handle:
            shutil.copyfileobj(unzipped, handle)
    with maxminddb.open_database(out) as reader:
        probe(reader.get("8.8.8.8"))
    print(f"dbip-{edition}-lite {month}: {os.path.getsize(out) // 1024 // 1024}MB, reader OK")


def city_probe(record):
    assert record["country"]["iso_code"] == "US", record


def asn_probe(record):
    assert record["autonomous_system_organization"], record


month = resolve_month()
fetch("city", month, city_probe)
fetch("asn", month, asn_probe)
GEOIP

COPY . .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
CMD ["sh", "entrypoint.sh"]
