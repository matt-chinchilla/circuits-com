"""One-off distributor imports — run inside the api container.

The key rides `exec -e`, never a file or compose env (allowlist gotcha):

    docker compose exec -e MOUSER_API_KEY=... api \
        python -m app.jobs.import_parts --backfill-images --limit 500

    docker compose exec -e MOUSER_API_KEY=... api \
        python -m app.jobs.import_parts --fill-category ceramic-capacitors \
        --query "ceramic capacitor" --count 50
"""

import argparse
import sys

from app.db.session import SessionLocal
from app.services.part_feed import MouserProvider
from app.services.part_feed.importer import (
    backfill_images,
    fill_all_empty,
    fill_category,
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--provider", choices=["mouser"], default="mouser")
    ap.add_argument("--backfill-images", action="store_true")
    ap.add_argument("--limit", type=int, default=200, help="backfill batch size")
    ap.add_argument(
        "--offset",
        type=int,
        default=0,
        help="backfill resume cursor — skip past parts the provider can't fill",
    )
    ap.add_argument("--fill-category", metavar="SLUG")
    ap.add_argument("--query", help="search keyword (default: the category name)")
    ap.add_argument("--count", type=int, default=50, help="parts per category fill")
    ap.add_argument(
        "--fill-all-empty",
        action="store_true",
        help="populate EVERY empty subcategory (the one-command site fill)",
    )
    ap.add_argument("--per-category", type=int, default=25)
    ap.add_argument("--max-categories", type=int, default=None)
    args = ap.parse_args()

    if not args.backfill_images and not args.fill_category and not args.fill_all_empty:
        ap.error("pick --backfill-images, --fill-category SLUG, or --fill-all-empty")

    provider = MouserProvider()
    db = SessionLocal()
    try:
        if args.backfill_images:
            print(backfill_images(db, provider, limit=args.limit, offset=args.offset))
        if args.fill_category:
            print(
                fill_category(
                    db,
                    provider,
                    args.fill_category,
                    keyword=args.query,
                    count=args.count,
                )
            )
        if args.fill_all_empty:
            for row in fill_all_empty(
                db,
                provider,
                per_category=args.per_category,
                max_categories=args.max_categories,
            ):
                print(row)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
