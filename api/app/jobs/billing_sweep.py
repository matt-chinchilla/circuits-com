"""Operator lever for the billing sweep (spec §10, §13.5).

    python -m app.jobs.billing_sweep --once [--now 2026-10-16T12:00:00]

Runs ONE pass of ``services.billing_sweep.run_sweep`` and prints its counts as
JSON. ``--now`` moves the sweep's clock (a naive time is read as UTC) — the
rehearsal forces a failed renewal, then sweeps "15 days later" to watch dunning
release the slot. The api process runs the same sweep hourly on its own thread;
this lever never replaces it. Run it inside the api container so it talks to
the same database (it cannot clear that process's category cache — the boards'
TTL bounds that).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import UTC, datetime

from app.services.billing_sweep import run_sweep


def _parse_now(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the billing sweep once.")
    parser.add_argument("--once", action="store_true", required=True, help="run one pass and exit")
    parser.add_argument(
        "--now", type=_parse_now, default=None, metavar="ISO", help="the sweep's clock"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    print(json.dumps(run_sweep(args.now)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
