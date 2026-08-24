"""Wiring DigiKey into the provider registry — and the one-key assumption it breaks.

Every existing seam assumes a provider authenticates with a single opaque
string: `provider_credentials` stores one `api_key` per provider, `env_feed_key`
returns one string, and both construction sites call `provider_cls(api_key=…)`.
DigiKey uses two-legged OAuth and needs an id AND a secret, so it is the first
provider that cannot be built that way.

`from_credential` is the seam. It keeps the gate ("is this feed configured?")
answering with one value while letting each provider decide what constructing
it actually requires.
"""

import pytest

from app.models import Supplier
from app.services.part_feed.digikey import DigiKeyProvider
from app.services.part_feed.mouser import MouserProvider
from app.services.part_feed.registry import FEED_PROVIDERS, env_feed_key, match_provider


class TestRegistryMatching:
    def test_the_digikey_supplier_matches_the_digikey_provider(self):
        supplier = Supplier(name="Digi-Key", website="https://digikey.com")
        match = match_provider(supplier)
        assert match is not None
        slug, cls = match
        assert (slug, cls) == ("digikey", DigiKeyProvider)

    def test_mouser_still_matches_mouser(self):
        slug, cls = match_provider(Supplier(name="Mouser Electronics", website="mouser.com"))
        assert (slug, cls) == ("mouser", MouserProvider)

    def test_an_unrelated_supplier_matches_nothing(self):
        assert match_provider(Supplier(name="Acme", website="acme.test")) is None

    def test_digikey_appears_in_the_admin_settings_list(self):
        """FEED_PROVIDERS is the ONE list the credentials card renders and the
        route validates against, so a provider absent here is unconfigurable."""
        assert "digikey" in dict(FEED_PROVIDERS)


class TestBothHalvesOrNothing:
    """A half-configured credential must read as OFF, not as ready.

    `get_feed_key` is what gates the 404 and what lets the nightly toggle be
    enabled. Returning something truthy while the pair is incomplete would let
    an operator switch on a run that can never authenticate.
    """

    def test_both_halves_present_is_configured(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_ID", "id-value")
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_SECRET", "secret-value")
        assert env_feed_key("digikey") == "id-value"

    def test_a_missing_secret_reads_as_unconfigured(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_ID", "id-value")
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_SECRET", None)
        assert env_feed_key("digikey") is None

    def test_a_missing_id_reads_as_unconfigured(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_ID", None)
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_SECRET", "secret-value")
        assert env_feed_key("digikey") is None

    def test_whitespace_is_not_a_credential(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_ID", "   ")
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_SECRET", "secret-value")
        assert env_feed_key("digikey") is None


class TestFromCredential:
    def test_mouser_builds_from_the_single_key(self):
        provider = MouserProvider.from_credential("mouser-key-not-real")
        assert provider.api_key == "mouser-key-not-real"

    def test_digikey_builds_from_the_id_plus_the_stored_secret(self, monkeypatch):
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_SECRET", "secret-value")
        provider = DigiKeyProvider.from_credential("id-value")
        assert provider.client_id == "id-value"
        assert provider.client_secret == "secret-value"

    def test_digikey_refuses_to_build_with_only_half_a_credential(self, monkeypatch):
        """Better a loud RuntimeError at construction than a 401 per part."""
        monkeypatch.setattr("app.config.settings.DIGIKEY_CLIENT_SECRET", None)
        with pytest.raises(RuntimeError, match="DIGIKEY_CLIENT_SECRET"):
            DigiKeyProvider.from_credential("id-value")
