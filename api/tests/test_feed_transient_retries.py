"""One upstream blip must not end an overnight sweep (found 2026-08-29).

The owner's overnight DigiKey run died 32 seconds and 2 calls in: the API
answered one keyword search with HTTP 500 and both providers treated EVERY
non-200 as run-ending. A continuous sweep makes thousands of calls against
public APIs that throw occasional transient 5xx — so overnight runs were
structurally impossible: mean-time-between-blips < the night.

`send_with_retries` (base.py) retries 500/502/503/504 and dropped
connections with backoff; real walls (401/403/429) stay immediate — retrying
those only burns quota on answers that cannot change.

Mutation-proven: emptying TRANSIENT_RETRY_DELAYS reddens the recovery tests;
adding 403 to TRANSIENT_STATUSES reddens the no-retry test.
"""

import httpx
import pytest

from app.services.part_feed import base
from app.services.part_feed.digikey import DigiKeyProvider
from app.services.part_feed.mouser import FeedFatalError, MouserProvider

OK_MOUSER = {"Errors": [], "SearchResults": {"NumberOfResult": 0, "Parts": []}}


@pytest.fixture(autouse=True)
def instant_retries(monkeypatch):
    """No real sleeping: neither the providers' call gaps nor the backoff."""
    monkeypatch.setattr(base.time, "sleep", lambda s: None)
    monkeypatch.setattr("app.services.part_feed.mouser.time.sleep", lambda s: None)
    monkeypatch.setattr("app.services.part_feed.digikey.time.sleep", lambda s: None)


def _mouser(responses):
    calls = {"n": 0}

    def handler(request):
        i = min(calls["n"], len(responses) - 1)
        calls["n"] += 1
        r = responses[i]
        if isinstance(r, Exception):
            raise r
        return httpx.Response(r, json=OK_MOUSER if r == 200 else {"detail": "x"})

    p = MouserProvider(api_key="k", client=httpx.Client(transport=httpx.MockTransport(handler)))
    return p, calls


class TestMouser:
    def test_a_single_500_is_retried_and_the_call_succeeds(self):
        p, calls = _mouser([500, 200])
        assert p._post("/search/keyword", {}) == OK_MOUSER
        assert calls["n"] == 2

    def test_a_dropped_connection_is_retried(self):
        p, calls = _mouser([httpx.ConnectError("boom"), 200])
        assert p._post("/search/keyword", {}) == OK_MOUSER
        assert calls["n"] == 2

    def test_persistent_500_still_fails_with_the_real_status(self):
        p, calls = _mouser([500])
        with pytest.raises(RuntimeError, match="HTTP 500"):
            p._post("/search/keyword", {})
        assert calls["n"] == 1 + len(base.TRANSIENT_RETRY_DELAYS)

    def test_quota_403_is_never_retried(self):
        p, calls = _mouser([403])
        with pytest.raises(FeedFatalError):
            p._post("/search/keyword", {})
        assert calls["n"] == 1

    def test_exhausted_connection_errors_fail_without_url_in_message(self):
        # httpx exception text embeds the request URL — and Mouser's key rides
        # the query string. The terminal error must be OUR plain message.
        p, calls = _mouser([httpx.ConnectError("secret-bearing detail")])
        with pytest.raises(FeedFatalError) as exc:
            p._post("/search/keyword", {})
        assert "secret-bearing" not in str(exc.value)
        assert "apiKey" not in str(exc.value)


class TestDigiKey:
    def _provider(self, responses):
        calls = {"n": 0}
        token = {"access_token": "t", "expires_in": 600}

        def handler(request):
            if request.url.path.endswith("/oauth2/token"):
                return httpx.Response(200, json=token)
            i = min(calls["n"], len(responses) - 1)
            calls["n"] += 1
            r = responses[i]
            if isinstance(r, Exception):
                raise r
            body = {"Products": [], "ProductsCount": 0} if r == 200 else {"detail": "x"}
            return httpx.Response(r, json=body)

        DigiKeyProvider._token = None  # class-level cache from other tests
        DigiKeyProvider._token_expires_at = 0.0
        p = DigiKeyProvider(
            client_id="id",
            client_secret="secret",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        return p, calls

    def test_a_single_500_is_retried_and_the_call_succeeds(self):
        p, calls = self._provider([500, 200])
        assert p._post("/products/v4/search/keyword", {"Keywords": "x"})["Products"] == []
        assert calls["n"] == 2

    def test_persistent_500_still_fails_with_the_real_status(self):
        p, calls = self._provider([500])
        with pytest.raises(FeedFatalError, match="HTTP 500"):
            p._post("/products/v4/search/keyword", {"Keywords": "x"})
        assert calls["n"] == 1 + len(base.TRANSIENT_RETRY_DELAYS)

    def test_quota_429_is_never_retried(self):
        p, calls = self._provider([429])
        with pytest.raises(FeedFatalError):
            p._post("/products/v4/search/keyword", {"Keywords": "x"})
        assert calls["n"] == 1
