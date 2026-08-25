"""The enumeration signal is DISTINCT addresses, not raw attempts.

D5 traded the anti-enumeration property at signup for UX. This is what pays
for it: someone who forgot they registered retries ONE address; an enumerator
walks many.
"""

from app.services import rate_limit
from app.services.rate_limit import (
    MAX_LOCK_SECONDS,
    PROBE_DISTINCT_THRESHOLD,
    PROBE_LOCK_SECONDS,
    limiter,
    record_probe,
    reset_probes,
    signup_email_key,
    signup_ip_key,
)


class _FakeClock:
    """The limiter's ``_now`` seam — fast-forward instead of sleeping."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def setup_function():
    limiter.reset()
    reset_probes()


def test_threshold_is_eight():
    assert PROBE_DISTINCT_THRESHOLD == 8


def test_repeating_one_address_does_not_trip_it():
    for _ in range(20):
        n = record_probe("signup:probe:1.2.3.4", "same@test.example")
    assert n == 1


def test_distinct_addresses_accumulate():
    for i in range(5):
        n = record_probe("signup:probe:1.2.3.4", f"a{i}@test.example")
    assert n == 5


def test_case_and_space_do_not_inflate_the_count():
    record_probe("signup:probe:1.2.3.4", "Person@Example.com")
    n = record_probe("signup:probe:1.2.3.4", "  person@example.com ")
    assert n == 1


def test_separate_ips_do_not_share_a_counter():
    record_probe("signup:probe:1.1.1.1", "a@test.example")
    n = record_probe("signup:probe:2.2.2.2", "b@test.example")
    assert n == 1


def test_the_signup_namespace_is_not_the_login_namespace():
    # A signup flood must never lock a real customer out of signing in.
    class _Req:
        headers = {"X-Real-IP": "9.9.9.9"}
        client = None

    assert signup_ip_key(_Req()).startswith("signup:")
    assert signup_email_key("a@test.example").startswith("signup:")
    assert signup_email_key(None) is None


class TestThePenaltyIsADurationNotALadderRung:
    """`PROBE_LOCK_SECONDS` is 3600 and the design's threshold table says "1
    hour pause". `limiter.record_failure` cannot deliver that — its delay comes
    from the key's own escalation level — so the probe threshold arms
    `limiter.pause(key, seconds=PROBE_LOCK_SECONDS)` instead. These pin the
    difference, so nobody can quietly swap one for the other.
    """

    def test_the_ladder_could_never_reach_the_specified_hour(self):
        # Not "record_failure gives 60s the first time" — even fully escalated,
        # forever, the ladder's ceiling is a quarter of the pause the spec asks
        # for. The mechanism is wrong, not merely mistuned.
        assert MAX_LOCK_SECONDS < PROBE_LOCK_SECONDS

    def test_pause_locks_for_exactly_the_duration_asked_for(self):
        assert limiter.pause("signup:ip:1.2.3.4", seconds=PROBE_LOCK_SECONDS) == PROBE_LOCK_SECONDS

    def test_pause_never_shortens_a_lock_already_in_force(self):
        limiter.pause("signup:ip:1.2.3.4", seconds=PROBE_LOCK_SECONDS)
        assert limiter.pause("signup:ip:1.2.3.4", seconds=60) == PROBE_LOCK_SECONDS

    def test_pause_does_not_advance_the_escalation_ladder(self, monkeypatch):
        # A caller-supplied duration is not a rung. If pause bumped lock_level,
        # the NEXT ordinary lockout on this key would silently start at 120s.
        clock = _FakeClock()
        monkeypatch.setattr(rate_limit, "_now", clock)
        key = "signup:ip:1.2.3.4"
        # A SHORT pause on purpose: an hour outlives the 15-minute decay
        # window, so record_failure would reset the level anyway and the test
        # would pass whatever pause did to it.
        limiter.pause(key, seconds=30)
        clock.t += 31  # the pause has expired, the decay window has not
        assert limiter.retry_after(key) == 0
        for _ in range(rate_limit.per_worker_threshold()):
            retry_after = limiter.record_failure(key)
        assert retry_after == rate_limit.BASE_LOCK_SECONDS  # first rung, not the second

    def test_a_signup_pause_leaves_the_login_namespace_alone(self):
        limiter.pause("signup:ip:1.2.3.4", seconds=PROBE_LOCK_SECONDS)
        assert limiter.retry_after("login:ip:1.2.3.4") == 0
        assert limiter.retry_after("recovery:ip:1.2.3.4") == 0
