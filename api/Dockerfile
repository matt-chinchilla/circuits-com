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

# ── GeoIP city database (DB-IP Lite, CC-BY 4.0 — https://db-ip.com) ─────
# BEFORE `COPY . .` on purpose: this layer's cache key is the ARG alone, so a
# code change never re-fetches ~124MB. Bumping the month is the one-line edit.
#
# It downloads straight into the app's data directory rather than a staging
# path because COPY MERGES into an existing directory — the context's
# committed country-lite file lands BESIDE this one without removing it — so
# the image carries exactly one copy of the 124MB instead of two. That is also
# why .dockerignore excludes the local city file from the context: it would
# only overwrite this one, and at the cost of shipping it twice over the wire.
#
# HARD FAILURE is deliberate. A soft fall-through would leave geoip.py quietly
# serving country-only results from the committed fallback, and nobody would
# notice the map had lost its cities for weeks. A broken build is loud and one
# retry away. The reader probe is what makes that guarantee real — a truncated
# stream can still gunzip, and a 124MB blob that is not a database would
# otherwise be found by production rather than by the build.
ARG DBIP_CITY_MONTH=2026-08
RUN python - <<'GEOIP'
import gzip, os, shutil, urllib.request
import maxminddb

month = os.environ["DBIP_CITY_MONTH"]
url = f"https://download.db-ip.com/free/dbip-city-lite-{month}.mmdb.gz"
out = "/app/app/data/dbip-city-lite.mmdb"
os.makedirs(os.path.dirname(out), exist_ok=True)

# db-ip.com answers 403 to urllib's DEFAULT User-Agent. Any explicit one is
# accepted; this is not an auth token, just a name for their logs. Measured,
# not guessed — the build failed on exactly this before the header was added.
request = urllib.request.Request(url, headers={"User-Agent": "circuitcenter-build/1.0"})

with urllib.request.urlopen(request, timeout=120) as response:
    with gzip.GzipFile(fileobj=response) as unzipped, open(out, "wb") as handle:
        shutil.copyfileobj(unzipped, handle)

with maxminddb.open_database(out) as reader:
    record = reader.get("8.8.8.8")
    assert record["country"]["iso_code"] == "US", record
print(f"dbip-city-lite {month}: {os.path.getsize(out) // 1024 // 1024}MB, reader OK")
GEOIP

COPY . .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
CMD ["sh", "entrypoint.sh"]
