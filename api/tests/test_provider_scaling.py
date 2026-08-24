"""Adding the Nth distributor must not mean editing a branch.

The whole multi-distributor premise is that a third, fourth and fiftieth
distributor arrive. Two places in the feed layer still assume there are exactly
two, and both fail quietly rather than loudly when a third shows up:

* `registry.env_feed_key` is an `if provider == "mouser" / if provider ==
  "digikey"` ladder that returns None for anything else. A new provider added
  to `_PROVIDERS` gets a registry entry, an admin Settings card row (which is
  derived), and a silent "not configured" forever — the operator sees the card,
  fills in the key, and nothing happens.
* `FEED_IMPORT_CALL_BUDGET` is ONE number shared by every provider. Quotas are
  not shared in reality: Mouser and Digi-Key each allow ~1,000 calls/day, so a
  pooled budget lets whichever provider the nightly sweep reaches first spend
  the other's headroom. With two providers that is merely wasteful; it is also
  what makes a reach estimate unstateable, because "how much of the catalog can
  we price tonight" only has an answer per distributor.

The fix for both is the same shape as `from_credential`, which this codebase
already chose when Digi-Key needed two credentials where Mouser needed one:
the PROVIDER declares what it needs and the registry reads the declaration,
instead of the registry knowing every provider by name.

Written before the implementation. If these pass on the ladder, they are wrong.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.services.part_feed import registry
from app.services.part_feed.registry import _PROVIDERS


class TestEveryProviderDeclaresItsOwnCredential:
    """No `provider == "<slug>"` comparison anywhere in the resolution path."""

    def test_every_registered_provider_declares_its_env_settings(self):
        missing = [slug for slug, cls in _PROVIDERS if not getattr(cls, "credential_env", None)]
        assert missing == [], (
            f"{missing} do not declare `credential_env`, so `env_feed_key` has to "
            "know them by name; a provider the ladder has never heard of reads as "
            "permanently unconfigured while its admin Settings card looks fillable"
        )

    def test_the_declared_names_are_real_settings_fields(self):
        """A typo'd setting name would silently mean "never configured"."""
        fields = set(Settings.model_fields)
        for slug, cls in _PROVIDERS:
            for name in cls.credential_env:
                assert name in fields, (
                    f"{slug} declares credential_env {name!r}, which is not a field "
                    f"on Settings — it can never resolve"
                )

    def test_env_feed_key_names_no_provider(self):
        """The resolution must be data-driven, not a ladder with a new rung per
        distributor. Checked on the SOURCE because a ladder that happens to
        cover today's two providers passes every behavioural test."""
        import ast
        import inspect
        import textwrap

        # The DOCSTRING is stripped before scanning. Prose that explains why the
        # ladder was removed legitimately names the providers it used to hold;
        # the invariant is that no provider is named in the LOGIC. Scanning the
        # raw source made this test fail on its own explanation, which would
        # have taught the next person to water down the assertion.
        tree = ast.parse(textwrap.dedent(inspect.getsource(registry.env_feed_key)))
        fn = tree.body[0]
        body = [
            n
            for n in fn.body
            if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))
        ]
        source = "\n".join(ast.unparse(n) for n in body)
        for slug, _cls in _PROVIDERS:
            assert f'"{slug}"' not in source and f"'{slug}'" not in source, (
                f"env_feed_key still names {slug!r} literally; adding a distributor "
                "means editing this function, which is the thing being removed"
            )

    def test_a_provider_needing_several_values_requires_all_of_them(self, monkeypatch):
        """Digi-Key's "both halves or nothing" rule must generalise, not be special.

        Returning the id while the secret is missing lets an operator enable a
        nightly run that can only ever 401.
        """
        multi = [(s, c) for s, c in _PROVIDERS if len(getattr(c, "credential_env", ())) > 1]
        if not multi:  # pragma: no cover - true only if Digi-Key is unregistered
            pytest.skip("no multi-credential provider registered")
        slug, cls = multi[0]
        first, *rest = cls.credential_env

        monkeypatch.setattr(registry.settings, first, "present", raising=False)
        for name in rest:
            monkeypatch.setattr(registry.settings, name, None, raising=False)
        assert registry.env_feed_key(slug) is None, (
            f"{slug} resolved a key with {rest} missing — every declared value is "
            "required, or the operator enables a feed that cannot authenticate"
        )

        for name in rest:
            monkeypatch.setattr(registry.settings, name, "present", raising=False)
        assert registry.env_feed_key(slug) == "present"

    def test_an_unregistered_slug_resolves_to_nothing(self):
        assert registry.env_feed_key("not-a-distributor") is None

    def test_whitespace_only_is_absent_not_a_key(self, monkeypatch):
        slug, cls = _PROVIDERS[0]
        for name in cls.credential_env:
            monkeypatch.setattr(registry.settings, name, "   ", raising=False)
        assert registry.env_feed_key(slug) is None, (
            "a blanked-out setting resolved as a credential; every call would fail "
            "with an empty key instead of the feature reading as off"
        )


class TestCallBudgetsArePerProvider:
    """One quota per distributor, because that is how the distributors sell it."""

    def test_a_budget_can_be_resolved_for_every_registered_provider(self):
        for slug, _cls in _PROVIDERS:
            budget = registry.call_budget(slug)
            assert isinstance(budget, int) and budget > 0, (
                f"{slug} has no usable daily call budget ({budget!r})"
            )

    def test_the_scalar_setting_is_the_fallback_for_a_provider_with_no_override(self, monkeypatch):
        """Adding a distributor must not require an ops change before it can run."""
        monkeypatch.setattr(registry.settings, "FEED_IMPORT_CALL_BUDGETS", {}, raising=False)
        monkeypatch.setattr(registry.settings, "FEED_IMPORT_CALL_BUDGET", 777, raising=False)
        assert registry.call_budget("not-a-distributor") == 777

    def test_a_per_provider_override_wins(self, monkeypatch):
        """Quota is an OPERATOR fact — a tier changes without the code changing —
        so it lives in settings, not as a class attribute on the provider."""
        monkeypatch.setattr(
            registry.settings, "FEED_IMPORT_CALL_BUDGETS", {"digikey": 120}, raising=False
        )
        monkeypatch.setattr(registry.settings, "FEED_IMPORT_CALL_BUDGET", 850, raising=False)
        assert registry.call_budget("digikey") == 120
        assert registry.call_budget("mouser") == 850

    def test_budgets_are_not_pooled_across_providers(self, monkeypatch):
        """The bug this exists to prevent: one distributor eating another's day.

        With a single shared counter, whichever provider the nightly sweep
        reaches first can spend the whole allowance, and the second gets a
        quota wall that looks like a provider outage.
        """
        monkeypatch.setattr(
            registry.settings,
            "FEED_IMPORT_CALL_BUDGETS",
            {"mouser": 300, "digikey": 900},
            raising=False,
        )
        assert registry.call_budget("mouser") != registry.call_budget("digikey"), (
            "both providers resolved the same budget from distinct overrides — the "
            "budget is still pooled"
        )


class TestResolutionIsOneQueryRegardlessOfProviderCount:
    """The whole point of `FeedSource`: resolution cost must not grow with P.

    Today every consumer repeats the same dance — `match_provider` to find the
    slug, `get_feed_key` to fetch the credential (one SELECT), then construct.
    `live_feed_slugs` does that once PER PROVIDER, so a BOM request issues one
    primary-key SELECT per registered distributor. At two providers that is
    0.794 ms and invisible. At fifty it is fifty round trips per request for
    data that changes about once a month.

    Counting queries at P=2 proves nothing, because 2 and O(P) look identical.
    These tests register a THIRD, fake provider and assert the count does not
    move. That is the only way to pin an asymptotic claim in a unit test.
    """

    @staticmethod
    def _selects(counted) -> list[str]:
        return [
            s
            for s in counted.statements
            if "provider_credentials" in s.lower() and s.strip().lower().startswith("select")
        ]

    def test_resolve_reads_every_credential_in_one_query(self, db):
        from .feed_helpers import StatementCounter

        with StatementCounter(db) as counted:
            registry.resolve(db)

        selects = self._selects(counted)
        assert len(selects) == 1, (
            f"resolution issued {len(selects)} credential queries for "
            f"{len(_PROVIDERS)} providers; it must be one IN (...) read"
        )

    def test_the_query_count_does_not_grow_with_the_number_of_providers(self, db, monkeypatch):
        """Register a fake third distributor and assert nothing changes.

        This is the test that actually says O(1). Without the extra provider it
        would pass just as happily against a per-provider loop.
        """
        from .feed_helpers import StatementCounter

        class FakeDistributor:
            supplier_name = "Fake Distributor"
            supplier_website = "fake-distributor.test"
            credential_env = ("MOUSER_API_KEY",)

            @classmethod
            def from_credential(cls, key):
                return cls()

        with StatementCounter(db) as counted:
            registry.resolve(db)
        baseline = len(self._selects(counted))

        monkeypatch.setattr(
            registry,
            "_PROVIDERS",
            (*_PROVIDERS, ("fake-distributor", FakeDistributor)),
            raising=True,
        )
        with StatementCounter(db) as counted:
            registry.resolve(db)
        grown = len(self._selects(counted))

        assert grown == baseline, (
            f"adding one provider took credential reads from {baseline} to {grown} "
            "— resolution is still O(providers) queries, which is the cost this "
            "object exists to remove"
        )


class TestFeedSourceAgreesWithTheFunctionsItReplaces:
    """A faster answer that disagrees with the old one is not an optimisation.

    The free functions stay as wrappers so the 13 existing call sites keep
    working, so the two paths MUST return the same thing. A divergence here is
    the worst possible outcome: the BOM tool would label a listing live-sourced
    while the feed layer refuses to call that provider, or the reverse.
    """

    def test_is_live_agrees_with_feed_configured(self, db):
        sources = registry.resolve(db)
        for slug, _cls in _PROVIDERS:
            assert sources[slug].is_live == registry.feed_configured(db, slug), (
                f"FeedSource and feed_configured disagree about {slug}"
            )

    def test_live_slugs_agrees_with_the_standalone_function(self, db):
        assert registry.resolve(db).live_slugs == registry.live_feed_slugs(db)

    def test_for_supplier_agrees_with_match_provider(self, db):
        """Matching semantics are deliberately UNCHANGED by this refactor.

        A domain index would make matching O(1) instead of O(P), but it also
        changes behaviour: `mydigikeyreseller.com` matches today by substring
        containment and would not under a registrable-domain lookup. At two
        providers the speedup is two string comparisons and the risk is a
        supplier silently changing distributor, so containment stays and this
        test is what holds it in place.
        """
        from app.models import Supplier

        sources = registry.resolve(db)
        probes = [
            Supplier(name="Digi-Key Electronics", website="https://www.digikey.com"),
            Supplier(name="DigiKey Marketplace", website="https://www.digikey.com/marketplace"),
            Supplier(name="Mouser Electronics", website="https://www.mouser.com"),
            Supplier(name="Arrow Electronics", website="https://www.arrow.com"),
            Supplier(name="No Website", website=None),
        ]
        for supplier in probes:
            matched = registry.match_provider(supplier)
            source = sources.for_supplier(supplier)
            expected = matched[0] if matched else None
            actual = source.slug if source else None
            assert actual == expected, (
                f"{supplier.name!r} resolves to {actual!r} via FeedSource but "
                f"{expected!r} via match_provider — matching semantics moved"
            )

    def test_building_a_provider_from_an_unkeyed_source_is_refused(self, db, monkeypatch):
        """The guard must fire BEFORE the provider is constructed.

        An earlier version of this test asserted only `pytest.raises(Exception)`
        and a mutation check proved it worthless: with the guard deleted,
        `from_credential(None)` reaches MouserProvider, whose own __init__
        raises without a key, so the test passed while testing nothing. The
        distinction matters — a guard that fires here names the slug and the
        settings to check, whereas the provider's own failure surfaces as a
        constructor error, or worse as a 401 one HTTP call later.

        So this asserts the provider class is never REACHED, which is the thing
        the guard is for, plus that the message is actionable.
        """
        sources = registry.resolve(db)
        dead = [s for s in sources.all() if not s.is_live]
        if not dead:  # pragma: no cover - depends on local credentials
            pytest.skip("every registered provider is keyed in this environment")
        source = dead[0]

        reached = []
        monkeypatch.setattr(
            source.provider_cls,
            "from_credential",
            classmethod(lambda cls, key: reached.append(key)),
            raising=True,
        )

        with pytest.raises(RuntimeError) as err:
            source.provider()

        assert reached == [], (
            "the provider class was constructed with no credential — the guard "
            "did not fire, and the failure will now surface as a 401 instead"
        )
        assert source.slug in str(err.value), (
            f"the refusal does not say which distributor is unconfigured: {err.value}"
        )


class TestAHalfConfiguredProviderIsNeverLive:
    """The "every declared value" rule must not depend on where the key came from.

    `env_feed_key` requires all of a provider's declared `credential_env` names,
    which is what stops an operator enabling a Digi-Key run that can only 401.
    But a credential STORED from Admin → Settings bypassed it: the DB row
    supplies one string, `resolve()` took it as the whole answer, and
    `FeedSource.is_live` went true with no `DIGIKEY_CLIENT_SECRET` anywhere.

    That is worse than a failing feed run. `is_live` is what the public BOM tool
    renders as "live feed", so a half-pasted credential would tell buyers a
    distributor's prices come from a live source that has never authenticated —
    the exact false claim the provenance work exists to prevent.

    The rule belongs in ONE place and must apply to both sources: a stored row
    can only ever supply the TRAVELLING value (the row has a single `api_key`
    column), so every other declared name still has to be present in settings.
    """

    @staticmethod
    def _db_with_stored(slug: str, value: str):
        class _Q:
            def query(self, *a, **k):
                return self

            def filter(self, *a, **k):
                return self

            def first(self):
                class Row:
                    api_key = value

                return Row()

            def all(self):
                return [(slug, value)]

        return _Q()

    @staticmethod
    def _multi():
        multi = [(s, c) for s, c in _PROVIDERS if len(getattr(c, "credential_env", ())) > 1]
        if not multi:  # pragma: no cover - only if Digi-Key is unregistered
            pytest.skip("no multi-credential provider registered")
        return multi[0]

    def test_a_stored_key_does_not_bypass_the_other_required_values(self, monkeypatch):
        slug, cls = self._multi()
        for name in cls.credential_env:
            monkeypatch.setattr(registry.settings, name, None, raising=False)

        source = registry.resolve(self._db_with_stored(slug, "pasted-id-only"))[slug]
        assert source.is_live is False, (
            f"{slug} reads as a live feed with a stored key but no "
            f"{cls.credential_env[1:]} — the public BOM tool would badge its "
            "prices 'live feed' for a feed that can only ever 401"
        )

    def test_get_feed_key_applies_the_same_rule(self, monkeypatch):
        """One rule, both readers — or the gate and the label disagree."""
        slug, cls = self._multi()
        for name in cls.credential_env:
            monkeypatch.setattr(registry.settings, name, None, raising=False)
        assert registry.get_feed_key(self._db_with_stored(slug, "pasted-id-only"), slug) is None

    def test_a_stored_key_still_works_when_the_others_are_present(self, monkeypatch):
        """The guard must not break the supported case: paste the id in Admin,
        keep the secret in the environment."""
        slug, cls = self._multi()
        monkeypatch.setattr(registry.settings, cls.credential_env[0], None, raising=False)
        for name in cls.credential_env[1:]:
            monkeypatch.setattr(registry.settings, name, "present", raising=False)

        source = registry.resolve(self._db_with_stored(slug, "pasted-id"))[slug]
        assert source.is_live is True
        assert source.credential == "pasted-id", "the stored row must still beat the environment"

    def test_a_single_credential_provider_is_unaffected(self, monkeypatch):
        """Mouser has one declared value; a stored row is the whole answer."""
        single = [(s, c) for s, c in _PROVIDERS if len(getattr(c, "credential_env", ())) == 1]
        if not single:  # pragma: no cover
            pytest.skip("no single-credential provider registered")
        slug, cls = single[0]
        monkeypatch.setattr(registry.settings, cls.credential_env[0], None, raising=False)
        source = registry.resolve(self._db_with_stored(slug, "stored-key"))[slug]
        assert source.is_live is True and source.credential == "stored-key"
