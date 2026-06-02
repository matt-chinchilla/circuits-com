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

COPY . .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
CMD ["sh", "entrypoint.sh"]
