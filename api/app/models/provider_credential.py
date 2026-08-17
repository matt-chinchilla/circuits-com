"""Distributor feed API keys, stored so the admin can manage them from the site.

One row per provider slug (``mouser`` today). The DB row WINS over the
environment variable — ``registry.get_feed_key`` reads here first and falls back
to ``settings.MOUSER_API_KEY`` — so a key can be rotated from Admin → Settings
without a host `.env` edit and a container recreate, while an environment that
already carries one keeps working untouched.

Scope is deliberately narrow: **feed keys only**. Stripe secrets and
``ADMIN_SECRET_KEY`` stay in the environment, where a compromised admin session
cannot reach them.

``api_key`` is Text, not String(N): key formats belong to other companies and a
length cap here would reject a valid credential for no benefit (the route bounds
what it will accept). It is stored as given — the value is a bearer credential
this server must present verbatim, so there is nothing a hash could be checked
against. Nothing reads it back out to a client: the route answers with
configured/source/last4/updated_at and never the value.

``provider`` IS the primary key. A provider has exactly one key, so a surrogate
id would only create room for two rows to disagree about which one that is.
"""

from sqlalchemy import Column, DateTime, String, Text, func

from app.db.session import Base


class ProviderCredential(Base):
    __tablename__ = "provider_credentials"

    # The registry's slug (`part_feed.registry.FEED_PROVIDERS`), not a display
    # name — the route rejects anything that is not a known slug, so a typo can
    # never land a row that nothing will ever read.
    provider = Column(String(40), primary_key=True)
    api_key = Column(Text, nullable=False)
    # Stamped by the DATABASE on insert AND on update: "when was this key last
    # changed" is the one thing the card can say about a value it may not show,
    # and a writer that forgets to set it must still land the truth.
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
