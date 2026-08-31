"""Matching a visiting network against the leads / manufacturer universe.

The asymmetry these tests defend: a MISSED match costs a badge, a WRONG match
tells the owner a stranger is a live prospect. Every "must not match" case
below is therefore load-bearing, and the ISP/cloud names are the ones a
looser rule (leading token, substring, fuzzy ratio) would light up.
"""

import uuid

import pytest

from app.models import Manufacturer, ManufacturerAlias
from app.models.lead import Lead
from app.services.manufacturer_canon import canon
from app.services.org_match import OrgMatcher


@pytest.fixture
def seeded_matcher(db):
    maker = Manufacturer(
        id=uuid.uuid4(),
        name="Cirrus Logic Inc.",
        slug="cirrus-logic",
        canonical_key=canon("Cirrus Logic Inc."),
        source="test",
    )
    other = Manufacturer(
        id=uuid.uuid4(),
        name="Analog Devices, Inc.",
        slug="analog-devices",
        canonical_key=canon("Analog Devices, Inc."),
        source="test",
    )
    db.add_all([maker, other])
    db.flush()
    db.add(
        ManufacturerAlias(
            manufacturer_id=maker.id,
            alias_canon=canon("Cirrus Logic International"),
            alias="Cirrus Logic International",
            source="test",
            confidence="auto",
        )
    )
    db.add(
        Lead(
            id=uuid.uuid4(),
            source_key=canon("Club Car, LLC|"),
            company_name="Club Car, LLC",
            company_slug=canon("Club Car, LLC"),
        )
    )
    db.commit()
    return OrgMatcher.build(db)


class TestMatches:
    def test_a_manufacturer_network_is_recognised(self, seeded_matcher):
        m = seeded_matcher.match("Cirrus Logic Inc.")
        assert m is not None
        assert (m.kind, m.name) == ("manufacturer", "Cirrus Logic Inc.")

    def test_canon_absorbs_casing_punctuation_and_legal_suffix(self, seeded_matcher):
        # The AS registry string rarely matches our record character for
        # character; canon is what makes these the same company.
        for spelling in ("CIRRUS LOGIC INC", "Cirrus Logic, Inc.", "cirrus logic"):
            assert seeded_matcher.match(spelling) is not None, spelling

    def test_an_alias_resolves_to_its_manufacturer(self, seeded_matcher):
        m = seeded_matcher.match("Cirrus Logic International")
        assert m is not None and m.kind == "manufacturer"

    def test_a_lead_is_recognised_and_labelled_as_one(self, seeded_matcher):
        m = seeded_matcher.match("Club Car, LLC")
        assert m is not None
        assert (m.kind, m.name) == ("lead", "Club Car, LLC")


class TestMustNotMatch:
    @pytest.mark.parametrize(
        "network",
        [
            "Verizon Business",
            "Amazon.com, Inc.",
            "Comcast Cable Communications, LLC",
            "Microsoft Corporation",
            "Cablevision Systems Corp.",
            "Google LLC",
            "Hetzner Online GmbH",
            # The dangerous shape: shares a leading token with a real record.
            "Cirrus Communications Pty Ltd",
            "Analog Networks LLC",
            "Club Med SAS",
        ],
    )
    def test_strangers_never_light_up_as_prospects(self, seeded_matcher, network):
        assert seeded_matcher.match(network) is None, network

    def test_blank_and_missing_names_are_not_matches(self, seeded_matcher):
        for value in (None, "", "   "):
            assert seeded_matcher.match(value) is None


class TestShape:
    def test_kind_is_an_open_string_so_linkedin_can_be_added(self, seeded_matcher):
        # Not an Enum by design — a future Connections.csv import adds
        # "linkedin" as a third source without a schema or type change.
        assert isinstance(seeded_matcher.match("Club Car, LLC").kind, str)

    def test_an_empty_universe_matches_nothing_rather_than_raising(self, db):
        matcher = OrgMatcher.build(db)
        assert matcher.match("Cirrus Logic Inc.") is None


class TestEndpoint:
    def test_the_route_reports_matches_and_counts_them(
        self, client, db, seeded_db, auth_header, seeded_matcher
    ):
        from app.models.page_view import PageView

        ua = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
        )
        db.add_all(
            [
                PageView(path="/", session_id="m-1", user_agent=ua, network="Cirrus Logic Inc."),
                PageView(path="/", session_id="m-2", user_agent=ua, network="Verizon Business"),
            ]
        )
        db.commit()
        data = client.get("/api/dashboard/organizations", headers=auth_header()).json()
        by_name = {o["name"]: o for o in data["organizations"]}
        assert by_name["Cirrus Logic Inc."]["match"]["kind"] == "manufacturer"
        assert by_name["Verizon Business"]["match"] is None
        assert data["matched_count"] == 1
