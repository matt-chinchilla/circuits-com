"""POST /api/stripe/webhook — Stripe's only door into this app.

Thin by design: the route owns transport concerns (secret configured? body
sane? signature valid?) and ``services.stripe_webhook`` owns everything else.
No auth dependency — the HMAC signature IS the authentication, and it proves
more than a bearer token would (that Stripe signed THIS exact body, recently).

The raw body bytes are verified BEFORE any JSON parsing: the signature covers
the bytes on the wire, and parse-then-reserialize would both break
verification and hand unauthenticated input to a parser.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.services.stripe_webhook import apply_stripe_event, verify_stripe_signature

router = APIRouter(prefix="/api/stripe", tags=["stripe"])

# Real Stripe events run a few KB. The cap only bounds what an unauthenticated
# caller can make us HMAC and parse; anything legitimate clears it by 100×.
MAX_BODY_BYTES = 256 * 1024


@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)) -> dict:
    secret = (settings.STRIPE_WEBHOOK_SECRET or "").strip()
    if not secret:
        # An unconfigured door does not
        # exist. A 503 would advertise that billing plumbing is present.
        raise HTTPException(status_code=404, detail="Not found")

    payload = await request.body()
    if len(payload) > MAX_BODY_BYTES:
        raise HTTPException(status_code=400, detail="payload_too_large")

    if not verify_stripe_signature(
        payload, request.headers.get("stripe-signature"), secret
    ):
        raise HTTPException(status_code=400, detail="invalid_signature")

    try:
        event = json.loads(payload)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid_json") from None
    if not isinstance(event, dict):
        raise HTTPException(status_code=400, detail="invalid_json")

    return {"received": True, "outcome": apply_stripe_event(db, event)}
