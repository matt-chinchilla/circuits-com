"""Synthetic inbox served to the public demo account (task 8).

`/api/admin/messages/` returns REAL inbound form submissions — the name, email,
phone number and free-text message of members of the public who filled in the
contact / join / keyword forms on circuitcenter.ai. The one-click "See Demo"
button puts an anonymous internet visitor one click from that table, so the demo
session must never be handed the real rows.

Substituting at the ROUTE (rather than filtering fields) is what makes it
provable: a demo session's query never touches the `messages` table at all, so
no future column can leak by being forgotten in a redaction list.

The roster below mirrors the four message types the admin UI discriminates on
(`frontend/src/admin/types/messages.ts`) so every branch of the Messages page
still has something to render. Addresses use RFC 6761 reserved TLDs
(`.example`) so nothing here can reach a real mailbox.
"""

from datetime import UTC, datetime, timedelta

# Fixed ids: the Messages page deep-links to /admin/messages/{id}, so the detail
# lookup has to resolve the same row the list handed out. Hand-written UUIDs
# keep them stable across restarts (and across workers) without a table.
_IDS = (
    "00000000-0000-4000-8000-00000000d001",
    "00000000-0000-4000-8000-00000000d002",
    "00000000-0000-4000-8000-00000000d003",
    "00000000-0000-4000-8000-00000000d004",
    "00000000-0000-4000-8000-00000000d005",
)


def _payloads() -> list[dict]:
    return [
        {
            "type": "contact",
            "status": "new",
            "payload": {
                "name": "Priya Raman",
                "email": "priya.raman@northbridge-robotics.example",
                "subject": "Bulk pricing on timing ICs",
                "message": (
                    "We are spec'ing a 4,000-unit run and need firm pricing on "
                    "clock buffers. Who handles volume quotes?"
                ),
                "reason": "general",
            },
        },
        {
            "type": "join",
            "status": "new",
            "payload": {
                "company_name": "Halden Components",
                "contact_person": "Marcus Halden",
                "email": "marcus@halden-components.example",
                "phone": "(415) 555-0143",
                "website": "halden-components.example",
                "categories_of_interest": ["Power Management", "Connectors"],
                "tier": "gold",
                "message": "Interested in a category sponsorship for Q4.",
            },
        },
        {
            "type": "keyword",
            "status": "read",
            "payload": {
                "company_name": "Verta Semiconductor",
                "email": "partnerships@verta-semi.example",
                "keyword": "voltage regulator",
                "message": "What does the top slot for this term cost monthly?",
            },
        },
        {
            "type": "contact",
            "status": "responded",
            "payload": {
                "name": "Dana Whitfield",
                "email": "dana.whitfield@arclight-systems.example",
                "subject": "Datasheet link is stale",
                "message": "The datasheet on one of the MCU pages 404s.",
                "reason": "data",
            },
        },
        {
            "type": "reply",
            "status": "responded",
            "payload": {
                "to": "dana.whitfield@arclight-systems.example",
                "subject": "Re: Datasheet link is stale",
                "body": "Thanks for the flag — the link is fixed and live.",
                "sent_by": "Daniel",
            },
        },
    ]


def demo_messages() -> list[dict]:
    """The synthetic inbox, newest first (the real route's sort order).

    Timestamps are computed relative to NOW so the demo never looks abandoned;
    they are the only thing here that changes between calls.
    """
    now = datetime.now(UTC)
    rows: list[dict] = []
    for index, base in enumerate(_payloads()):
        created = now - timedelta(hours=3 * (index + 1))
        responded = base["status"] == "responded"
        rows.append(
            {
                "id": _IDS[index],
                # Descending seq so the MSG-#### designators read like a real
                # inbox where the newest submission has the highest number.
                "seq": len(_IDS) - index,
                "read_at": created + timedelta(minutes=20) if base["status"] != "new" else None,
                "responded_at": created + timedelta(hours=1) if responded else None,
                "assigned_to": "Daniel" if responded else None,
                "spam_score": None,
                "last_reply_body": None,
                "created_at": created,
                **base,
            }
        )
    return rows


def find_demo_message(message_id: str) -> dict | None:
    """One synthetic row by id, or None — the route turns None into its 404."""
    return next((m for m in demo_messages() if m["id"] == message_id), None)
