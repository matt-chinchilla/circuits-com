"""The enumeration signal is DISTINCT addresses, not raw attempts.

D5 traded the anti-enumeration property at signup for UX. This is what pays
for it: someone who forgot they registered retries ONE address; an enumerator
walks many.
"""

from app.services.rate_limit import (
    PROBE_DISTINCT_THRESHOLD,
    limiter,
    record_probe,
    reset_probes,
    signup_email_key,
    signup_ip_key,
)


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
