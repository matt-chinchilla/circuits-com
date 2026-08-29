"""The nightly must not spend the whole Mouser day (found 2026-08-28).

Mouser sells ~1,000 calls/day and three consumers share them: the nightly
sweep, the BOM resolver (100/day), and the owner's interactive Sync/Import
clicks. With the nightly at the 850 scalar, the key was quota-walled by
evening EVERY day — measured live: `sync` on prod died in 0.64s with
HTTP 403 while DigiKey answered normally, which is exactly the "Mouser is
unbearably slow/broken" report. The per-provider default leaves ~300 calls
of daytime headroom.

Also pins the httpx log redaction: Mouser's key rides in the request URL
(`?apiKey=`), and httpx logs URLs at INFO — importing the provider module
must cap that logger so no process that can make the call prints the secret.
"""

import logging

from app.services.part_feed import registry


class TestNightlyBudgets:
    def test_mouser_keeps_daytime_headroom(self):
        assert registry.call_budget("mouser") <= 600

    def test_other_providers_keep_the_scalar(self):
        from app.config import settings

        assert registry.call_budget("digikey") == settings.FEED_IMPORT_CALL_BUDGET


class TestTheKeyStaysOutOfTheLogs:
    def test_importing_the_provider_caps_httpx_logging(self):
        import app.services.part_feed.mouser  # noqa: F401  (the import IS the act)

        assert logging.getLogger("httpx").level >= logging.WARNING
