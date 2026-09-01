#!/usr/bin/env python3
"""Mint a Stripe invoice for hourly software-engineering work.

This is the reusable invoice template. Stripe's native Invoice Rendering
Templates need the Invoicing Plus plan (verified unavailable on this account
across API versions 2024-11-20 / 2025-03-31 / 2025-08-27), so the repeatable
shape lives here in version control instead.

SAFETY: test mode by default, and DRAFT by default. Nothing reaches a
customer until you pass BOTH --live and --send.

    # rehearse in the sandbox
    python scripts/invoice.py --name "Acme Co" --email "ap@acme.test" \
        --hours 5 --rate 200 --project "Q3 API integration"

    # real draft the customer cannot see yet (review it in the Dashboard)
    python scripts/invoice.py --live --name "Acme Co" --email "ap@acme.com" \
        --hours 5 --rate 200 --project "Q3 API integration"

    # finalize and email it
    python scripts/invoice.py --live --send --name "Acme Co" ... --hours 5 --rate 200
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path
from string import Template

API = "https://api.stripe.com/v1"
# Pinned deliberately. Billing code should not change shape because Stripe
# rolled the account default -- 2026-07-29.dahlia is the version this script
# was verified against, and it is the one that dropped invoiceitem
# `unit_amount` in favour of `unit_amount_decimal`.
API_VERSION = "2026-07-29.dahlia"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# The service being sold. One product, reused across every client and every
# invoice, so revenue reports group cleanly instead of fragmenting per client.
PRODUCT_NAME = "Software Engineering Services"
PRODUCT_DESC = "Custom software design, implementation, and consulting, billed hourly."

# Stripe tax code. txcd_10000000 = "General - Services".
# NOTE: automatic tax stays OFF by default (--tax to enable). NY treats custom
# software services and prewritten software differently, and this account
# already carries NY/NJ registrations for the sponsorship side. Whether a
# consulting hour is taxable is an accountant's call, not a default.
TAX_CODE = "txcd_10000000"

# Pinned explicitly. The account's default payment method configuration also
# has BLIK, PIX, Bancontact, EPS and a dozen other international methods ON;
# without this the invoice would show all of them to a US client.
PAYMENT_METHODS = ["card", "us_bank_account"]

# Separates services revenue from sponsorship revenue in reporting. The
# S-corp books need these two streams distinguishable, and a distinct product
# alone does not survive a CSV export as cleanly as an explicit tag.
REVENUE_TAG = "services"

# TODO(matthew): your Zelle address. Stripe cannot process Zelle, so the most
# it can do is advertise it in the invoice footer; a client who pays that way
# settles outside Stripe and you reconcile with --mark-paid. Leave as "" to
# omit the offer entirely rather than print a blank instruction.
ZELLE_HANDLE = "matthew@circuitcenter.ai"

# Who the email comes from when you deliver it yourself instead of letting
# Stripe mail it. Change FROM_NAME if you bill under a different signature.
FROM_NAME = "Matthew Chirichella"
FROM_EMAIL = "matthew@circuitcenter.ai"
BUSINESS_NAME = "Circuit Center"

# Served by the live site. Email clients strip data: URIs from <img src>, and
# the Stripe-hosted branding file is not publicly reachable, so a real URL on
# your own domain is the only option that renders. Every client blocks remote
# images by default for unknown senders, so the layout must still read with
# images off -- hence the business name appears as text too, not only here.
LOGO_URL = "https://circuitcenter.ai/images/logo-lockup.png"


def line_description(work):
    """The one line the client's bookkeeper reads.

    Deliberately generic. "Software engineering services — company website"
    describes the work accurately without naming the specific site, so the
    charge files as a routine operating cost rather than a line the recipient
    has to research. Truthful about the category; quiet about the subject.
    """
    return f"Software engineering services — {work}" if work else "Software engineering services"


def build_footer(terms):
    lines = [f"Payment due within {terms} days of the invoice date."]
    if ZELLE_HANDLE:
        lines.append(
            f"Prefer a no-fee transfer? Zelle to {ZELLE_HANDLE} and reply to "
            "this email so the invoice can be marked paid."
        )
    lines.append("Questions about this invoice? Reply to this email.")
    return " ".join(lines)


# --------------------------------------------------------------------------
# Stripe transport. Plain urllib so the script has zero dependencies and runs
# anywhere Python does -- no venv, no `pip install stripe`.
# --------------------------------------------------------------------------

def form_encode(data, prefix=""):
    """Flatten a dict into Stripe's bracket notation: a[b][0][c]=v."""
    pairs = []
    if isinstance(data, dict):
        for key, value in data.items():
            child = f"{prefix}[{key}]" if prefix else str(key)
            pairs += form_encode(value, child)
    elif isinstance(data, (list, tuple)):
        for index, value in enumerate(data):
            pairs += form_encode(value, f"{prefix}[{index}]")
    elif isinstance(data, bool):
        pairs.append((prefix, "true" if data else "false"))
    elif data is not None:
        pairs.append((prefix, str(data)))
    return pairs


def api(method, path, key, params=None):
    body = urllib.parse.urlencode(form_encode(params or {})).encode()
    url = f"{API}{path}"
    if method == "GET" and body:
        url, body = f"{url}?{body.decode()}", None
    request = urllib.request.Request(url, data=body, method=method)
    token = base64.b64encode(f"{key}:".encode()).decode()
    request.add_header("Authorization", f"Basic {token}")
    request.add_header("Content-Type", "application/x-www-form-urlencoded")
    request.add_header("Stripe-Version", API_VERSION)
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = json.load(exc).get("error", {})
        sys.exit(f"Stripe {exc.code} on {method} {path}: {detail.get('message')}")


def secret_key(live):
    """Read the key from .env. Shell env wins, matching the compose convention."""
    name = "STRIPE_SECRET_KEY" if live else "STRIPE_SECRET_KEY_TEST"
    if value := os.environ.get(name):
        return value
    if not ENV_FILE.exists():
        sys.exit(f"No {ENV_FILE} and ${name} is unset.")
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"{name} not found in {ENV_FILE}.")


# --------------------------------------------------------------------------
# Idempotent lookups. Re-running for the same client must reuse the same
# customer and product rows rather than forking duplicates.
# --------------------------------------------------------------------------

def get_or_create_customer(key, name, email, address=None):
    """Look up by email, then reconcile name and address.

    Keyed on email because that is the field a client is least likely to
    change quietly between engagements. A match is UPDATED rather than
    returned as-is, so a moved office or a renamed entity corrects itself on
    the next invoice instead of billing the old suite number forever.
    """
    fields = {"name": name, "email": email}
    if address:
        fields["address"] = address
    found = api("GET", "/customers", key, {"email": email, "limit": 1})
    if found["data"]:
        return api("POST", f"/customers/{found['data'][0]['id']}", key, fields)
    return api("POST", "/customers", key, fields)


def get_or_create_product(key):
    found = api("GET", "/products", key, {"active": True, "limit": 100})
    for product in found["data"]:
        if product["name"] == PRODUCT_NAME:
            return product
    return api("POST", "/products", key, {
        "name": PRODUCT_NAME,
        "description": PRODUCT_DESC,
        "tax_code": TAX_CODE,
    })


def mark_paid_offline(key, invoice_id, method, mode):
    """Settle an invoice paid outside Stripe.

    Stripe cannot process Zelle, so a Zelle payment leaves a real invoice open
    and dunning the client who already paid. `paid_out_of_band` records the
    money as received without Stripe touching it -- the books balance and the
    reminder emails stop.
    """
    invoice = api("GET", f"/invoices/{invoice_id}", key)
    if invoice["status"] == "draft":
        sys.exit(f"{invoice_id} is still a draft -- send it before marking it paid.")
    if invoice["status"] == "paid":
        print(f"[{mode}] {invoice_id} is already paid. Nothing to do.")
        return
    paid = api("POST", f"/invoices/{invoice_id}/pay", key, {
        "paid_out_of_band": True,
    })
    api("POST", f"/invoices/{invoice_id}", key, {"metadata": {"paid_via": method}})
    print(f"[{mode}] {invoice_id} marked paid out of band via {method} "
          f"(${paid['amount_paid'] / 100:,.2f}) -- no Stripe fee charged.")


# --------------------------------------------------------------------------
# Composing the mail yourself.
#
# Finalizing an invoice and SENDING it are separate operations in Stripe.
# `/finalize` with auto_advance=false assigns the invoice number and mints the
# hosted payment page and PDF while firing no `invoice.sent` event -- verified
# against the API, not assumed. That is what lets the message leave from your
# own relay, from your own address, instead of Stripe's mailer.
# --------------------------------------------------------------------------

# No literal "$" anywhere in this template: string.Template treats it as a
# placeholder marker, so every currency figure arrives pre-formatted.
EMAIL_HTML = Template("""\
<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef1f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
Invoice $number from $business — $total due $due_human
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:#eef1f5;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0"
       style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;
              border:1px solid #dfe4ec;font-family:-apple-system,BlinkMacSystemFont,
              'Segoe UI',Inter,Helvetica,Arial,sans-serif;">

  <tr><td style="padding:26px 30px 0 30px;">
    <img src="$logo" alt="$business" width="190" height="47"
         style="display:block;border:0;height:auto;max-width:190px;">
  </td></tr>

  <tr><td style="padding:22px 30px 0 30px;">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;
                color:#6b7684;font-weight:600;">Invoice $number</div>
    <div style="font-size:26px;font-weight:700;color:#111827;padding-top:4px;">
      $total <span style="font-size:14px;font-weight:500;color:#6b7684;">due $due_human</span>
    </div>
  </td></tr>

  <tr><td style="padding:20px 30px 0 30px;font-size:15px;line-height:1.6;color:#374151;">
    <p style="margin:0 0 6px 0;">Hi $first_name,</p>
    <p style="margin:0;">$note</p>
  </td></tr>

  <tr><td style="padding:22px 30px 0 30px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:separate;border-spacing:0;font-size:14px;">
      <tr>
        <td style="padding:9px 10px;background:#f6f8fb;color:#6b7684;font-weight:600;
                   font-size:12px;letter-spacing:.04em;text-transform:uppercase;
                   border-radius:6px 0 0 6px;">Description</td>
        <td align="right" style="padding:9px 10px;background:#f6f8fb;color:#6b7684;
                   font-weight:600;font-size:12px;letter-spacing:.04em;
                   text-transform:uppercase;">Qty</td>
        <td align="right" style="padding:9px 10px;background:#f6f8fb;color:#6b7684;
                   font-weight:600;font-size:12px;letter-spacing:.04em;
                   text-transform:uppercase;">Rate</td>
        <td align="right" style="padding:9px 14px 9px 10px;background:#f6f8fb;
                   color:#6b7684;font-weight:600;font-size:12px;letter-spacing:.04em;
                   text-transform:uppercase;border-radius:0 6px 6px 0;">Amount</td>
      </tr>
      <tr>
        <td style="padding:14px 10px;color:#111827;border-bottom:1px solid #eef1f5;">$description</td>
        <td align="right" style="padding:14px 10px;color:#374151;border-bottom:1px solid #eef1f5;">$quantity</td>
        <td align="right" style="padding:14px 10px;color:#374151;
                   font-variant-numeric:tabular-nums;border-bottom:1px solid #eef1f5;">$rate</td>
        <td align="right" style="padding:14px 14px 14px 10px;color:#111827;
                   font-variant-numeric:tabular-nums;border-bottom:1px solid #eef1f5;">$total</td>
      </tr>
      <tr>
        <td colspan="3" align="right" style="padding:14px 10px;font-weight:700;color:#111827;">Total due</td>
        <td align="right" style="padding:14px 14px 14px 10px;font-weight:700;
                   font-size:17px;color:#0a4a2e;font-variant-numeric:tabular-nums;">$total</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:26px 30px 0 30px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="border-radius:7px;background:#0a4a2e;">
        <a href="$pay_url" style="display:inline-block;padding:13px 30px;
           font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">
          Pay this invoice</a>
      </td>
    </tr></table>
    <p style="margin:14px 0 0 0;font-size:13px;line-height:1.6;color:#6b7684;">
      Card or bank transfer (ACH) via the secure link above.$zelle_line
    </p>
  </td></tr>

  <tr><td style="padding:24px 30px 28px 30px;">
    <div style="border-top:1px solid #eef1f5;padding-top:16px;font-size:12px;
                line-height:1.7;color:#8a94a3;">
      $business &middot; Invoice $number &middot; Issued $issued_human<br>
      Questions? Just reply to this email.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>
""")

EMAIL_TEXT = Template("""\
Hi $first_name,

$note

  Invoice $number
  $description
  Quantity: $quantity at $rate
  Total due: $total  (due $due_human)

Pay by card or bank transfer:
$pay_url
$zelle_text
$business - Invoice $number - Issued $issued_human
Questions? Just reply to this email.
""")


def money(cents):
    return "${:,.2f}".format(cents / 100)


def finalize(key, invoice_id, mode):
    """Issue the invoice without letting Stripe mail it.

    A draft has no number, no hosted page and no PDF, so it cannot be sent by
    any other channel either -- finalizing is what makes those exist. The
    auto_advance=false is what keeps Stripe quiet afterwards: it disables the
    automatic collection that would otherwise email and dun the customer.
    """
    invoice = api("GET", f"/invoices/{invoice_id}", key)
    if invoice["status"] == "draft":
        invoice = api("POST", f"/invoices/{invoice_id}/finalize", key,
                      {"auto_advance": False})
        print(f"[{mode}] finalized as {invoice['number']} (Stripe sent no email)")
    else:
        print(f"[{mode}] already {invoice['status']} as {invoice['number']}")
    return invoice


def compose(key, invoice_id, note, out_dir, mode):
    """Build a ready-to-send .eml carrying the invoice and its PDF."""
    invoice = finalize(key, invoice_id, mode)
    line = invoice["lines"]["data"][0]
    to_email = invoice["customer_email"]
    attn = next((f["value"] for f in (invoice.get("custom_fields") or [])
                 if f["name"] == "Attn"), "")
    first_name = (attn or invoice.get("customer_name") or "there").split()[0]

    due = dt.datetime.fromtimestamp(invoice["due_date"], dt.UTC)
    issued = dt.datetime.fromtimestamp(invoice["created"], dt.UTC)
    total = money(invoice["total"])

    if note is None:
        note = (f"Please find invoice {invoice['number']} below and attached as a PDF, "
                "covering software engineering services on the company website.")

    values = {
        "business": BUSINESS_NAME, "logo": LOGO_URL, "number": invoice["number"],
        "first_name": first_name, "note": note, "total": total,
        "description": line["description"], "quantity": line["quantity"],
        "rate": money(round(line["amount"] / line["quantity"])),
        "due_human": due.strftime("%B %-d, %Y"), "issued_human": issued.strftime("%B %-d, %Y"),
        "pay_url": invoice["hosted_invoice_url"],
        "zelle_line": (f" Prefer a no-fee transfer? Zelle to {ZELLE_HANDLE} "
                       "and reply here so it can be marked paid." if ZELLE_HANDLE else ""),
        "zelle_text": (f"\nOr Zelle (no fee) to {ZELLE_HANDLE} and reply here "
                       "so it can be marked paid.\n" if ZELLE_HANDLE else ""),
    }

    message = EmailMessage()
    message["From"] = formataddr((f"{FROM_NAME} ({BUSINESS_NAME})", FROM_EMAIL))
    message["To"] = formataddr((invoice.get("customer_name") or "", to_email))
    message["Reply-To"] = FROM_EMAIL
    message["Subject"] = (f"Invoice {invoice['number']} from {BUSINESS_NAME} "
                          f"— {total} due {due.strftime('%b %-d')}")
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain=FROM_EMAIL.split("@")[1])
    message.set_content(EMAIL_TEXT.substitute(values))
    message.add_alternative(EMAIL_HTML.substitute(values), subtype="html")

    with urllib.request.urlopen(invoice["invoice_pdf"]) as response:
        pdf = response.read()
    message.add_attachment(pdf, maintype="application", subtype="pdf",
                           filename=f"invoice-{invoice['number']}.pdf")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    eml = out / f"invoice-{invoice['number']}.eml"
    html = out / f"invoice-{invoice['number']}.html"
    eml.write_bytes(bytes(message))
    html.write_text(EMAIL_HTML.substitute(values))

    print(f"[{mode}] to      : {to_email}")
    print(f"[{mode}] subject : {message['Subject']}")
    print(f"[{mode}] pdf     : {len(pdf):,} bytes attached")
    print(f"[{mode}] eml     : {eml}   <- open or pipe into your mail server")
    print(f"[{mode}] html    : {html}  <- preview in a browser")
    print(f"[{mode}] pay url : {invoice['hosted_invoice_url']}")
    return invoice


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", help="Customer / company name")
    parser.add_argument("--email", help="Where the invoice is sent")
    parser.add_argument("--hours", type=float, help="Units billed")
    parser.add_argument("--rate", type=float, default=200.0, help="USD per hour")
    parser.add_argument("--work", default="",
                        help="Generic subject of the work, e.g. 'company website'. Kept "
                             "deliberately non-specific so a client can file it as a "
                             "routine operating cost.")
    parser.add_argument("--project", default="", help="Internal ref, shown as a custom field")
    parser.add_argument("--attn", default="", help="Individual receiving it, e.g. 'Guy Nicosia'")
    parser.add_argument("--line1", default="", help="Billing street address")
    parser.add_argument("--line2", default="", help="Suite / unit")
    parser.add_argument("--city", default="")
    parser.add_argument("--state", default="", help="Two-letter code, e.g. NY")
    parser.add_argument("--zip", dest="postal", default="")
    parser.add_argument("--terms", type=int, default=14, help="Days until due")
    parser.add_argument("--tax", action="store_true", help="Enable Stripe automatic tax")
    parser.add_argument("--live", action="store_true", help="Use the LIVE key")
    parser.add_argument("--send", action="store_true", help="Finalize and email it")
    parser.add_argument("--finalize", metavar="in_XXX",
                        help="Issue an invoice WITHOUT emailing it (mints number, "
                             "hosted pay page and PDF; Stripe stays silent)")
    parser.add_argument("--compose", metavar="in_XXX",
                        help="Finalize if needed, then write a ready-to-send .eml "
                             "with the invoice embedded and the PDF attached")
    parser.add_argument("--note", default=None, help="Opening line of the email body")
    parser.add_argument("--out", default="invoices", help="Where to write the .eml/.html")
    parser.add_argument("--mark-paid", metavar="in_XXX",
                        help="Close out an invoice paid outside Stripe (Zelle, check, wire)")
    parser.add_argument("--paid-via", default="zelle", help="Recorded on the offline payment")
    args = parser.parse_args()

    if args.compose:
        return compose(secret_key(args.live), args.compose, args.note, args.out,
                       "LIVE" if args.live else "test")

    if args.finalize:
        invoice = finalize(secret_key(args.live), args.finalize,
                           "LIVE" if args.live else "test")
        print("pay url:", invoice.get("hosted_invoice_url"))
        print("pdf    :", invoice.get("invoice_pdf"))
        return

    if args.mark_paid:
        return mark_paid_offline(secret_key(args.live), args.mark_paid, args.paid_via,
                                 "LIVE" if args.live else "test")

    missing = [f for f in ("name", "email", "hours") if getattr(args, f) is None]
    if missing:
        sys.exit(f"Missing required argument(s): {', '.join('--' + m for m in missing)}")

    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", args.email):
        sys.exit(f"That does not look like an email address: {args.email}")

    key = secret_key(args.live)
    mode = "LIVE" if args.live else "test"
    # Stripe money is integer minor units. Round once, here, so the printed
    # total and the charged total can never disagree by a floating-point cent.
    unit_amount = round(args.rate * 100)
    total = unit_amount * args.hours

    print(f"[{mode}] {args.name} <{args.email}>")
    print(f"[{mode}] {args.hours:g} hr x ${args.rate:,.2f} = ${total / 100:,.2f}")

    address = None
    if args.line1:
        address = {"line1": args.line1, "line2": args.line2 or None, "city": args.city,
                   "state": args.state, "postal_code": args.postal, "country": "US"}
    customer = get_or_create_customer(key, args.name, args.email, address)
    product = get_or_create_product(key)
    print(f"[{mode}] customer={customer['id']} product={product['id']}")

    fields = []
    if args.attn:
        fields.append({"name": "Attn", "value": args.attn[:30]})
    if args.project:
        fields.append({"name": "Project", "value": args.project[:30]})
    invoice = api("POST", "/invoices", key, {
        "customer": customer["id"],
        "collection_method": "send_invoice",
        "days_until_due": args.terms,
        "auto_advance": False,
        "description": line_description(args.work),
        "footer": build_footer(args.terms),
        "custom_fields": fields or None,
        "automatic_tax": {"enabled": args.tax},
        "payment_settings": {"payment_method_types": PAYMENT_METHODS},
        "metadata": {
            "revenue_type": REVENUE_TAG,
            "project": args.project,
            "hours": f"{args.hours:g}",
            "hourly_rate_usd": f"{args.rate:.2f}",
        },
    })

    # An inline unit_amount, not a saved Price object. Stripe Prices are
    # immutable -- a fixed $200 Price would have to be replaced (not edited)
    # the first time a rate changes, and every historical invoice would still
    # point at the retired one.
    api("POST", "/invoiceitems", key, {
        "customer": customer["id"],
        "invoice": invoice["id"],
        "quantity": int(args.hours) if args.hours.is_integer() else args.hours,
        "unit_amount_decimal": unit_amount,
        "currency": "usd",
        "description": line_description(args.work),
    })

    invoice = api("GET", f"/invoices/{invoice['id']}", key)
    print(f"[{mode}] draft {invoice['id']} total ${invoice['total'] / 100:,.2f}")

    if not args.send:
        print(f"[{mode}] DRAFT ONLY — not sent. Re-run with --send to email it.")
        return

    sent = api("POST", f"/invoices/{invoice['id']}/send", key)
    print(f"[{mode}] SENT to {args.email}")
    print(f"[{mode}] {sent.get('hosted_invoice_url')}")
    print(f"[{mode}] pdf: {sent.get('invoice_pdf')}")


if __name__ == "__main__":
    main()
