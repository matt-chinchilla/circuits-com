"""CLI entry: `python -m revenium_seed {probe|seed|verify|reset}`."""
from __future__ import annotations

import argparse
import asyncio
import sys

from . import probe, reset, seed, verify


def cli() -> int:
    parser = argparse.ArgumentParser(prog="revenium-seed")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("probe", help="canary: test max backdated timestamp accepted")
    s = sub.add_parser("seed", help="create orgs/products + backdated completions")
    s.add_argument("--days", type=int, default=None, help="override SEED_HISTORY_DAYS")
    s.add_argument("--concurrency", type=int, default=None, help="override SEED_CONCURRENCY")
    sub.add_parser("verify", help="readback: analytics summary")
    r = sub.add_parser("reset", help="DELETE seeded orgs/products (destructive)")
    r.add_argument("--yes", action="store_true", help="required — confirms destructive intent")

    args = parser.parse_args()

    if args.command == "probe":
        asyncio.run(probe.main())
    elif args.command == "seed":
        asyncio.run(seed.run_seed(history_days=args.days, concurrency=args.concurrency))
    elif args.command == "verify":
        return asyncio.run(verify.main())
    elif args.command == "reset":
        if not args.yes:
            print("reset is destructive — pass --yes to confirm")
            return 2
        asyncio.run(reset.run_reset())
    return 0


if __name__ == "__main__":
    sys.exit(cli())
