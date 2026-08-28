"""The single home for "what may this caller see" — app/services/account_scope.py.

The point of these tests is that a scoping filter which passes against UNSCOPED
code is measuring nothing. So every visibility test here asserts BOTH halves:
the rows the caller may see AND the rows they may not, against a fixture that
deliberately contains both. Each one has been mutation-checked (break the
filter, watch it redden) — see the report.
"""

import inspect
import uuid
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from fastapi import Depends, FastAPI, params
from fastapi.testclient import TestClient
from sqlalchemy.sql.elements import ColumnElement

from app.db.session import get_db
from app.models import Manufacturer, Message, Part, PartListing, Sponsor, User
from app.services.account_scope import (
    AccountScope,
    account_scope,
    listings_owned_by,
    listings_visible_to,
    messages_visible_to,
    parts_visible_to,
    sponsorships_visible_to,
)
from app.services.auth_service import create_token, require_account_user


# ── Fixture ─────────────────────────────────────────────────────────────────
# Built so the three scopes have DISJOINT-plus-overlapping answers. If the
# union were implemented as an if/elif, or as an intersection, or as "no
# filter", each of those produces a different, detectable answer here.
@pytest.fixture
def world(db, seeded_db):
    """seeded_db plus a manufacturer and four parts arranged as a Venn diagram.

    supplier2 (Kennedy) is the supplier ``company_user`` is linked to.

      part_carried  — listed by Kennedy, made by nobody we track  → supplier set
      part_made     — made by Nordic, listed by nobody            → maker set
      part_both     — listed by Kennedy AND made by Nordic        → the overlap
      part2         — neither (from seeded_db)                    → no set
    """
    kennedy = seeded_db["supplier2"]
    avnet = seeded_db["supplier1"]

    nordic = Manufacturer(
        id=uuid.uuid4(),
        name="Nordic Semiconductor",
        slug="nordic-semiconductor",
        canonical_key="nordicsemiconductor",
    )
    other_mfr = Manufacturer(
        id=uuid.uuid4(),
        name="Renesas Electronics",
        slug="renesas-electronics",
        canonical_key="renesaselectronics",
    )
    db.add_all([nordic, other_mfr])
    db.flush()

    part_made = Part(
        id=uuid.uuid4(),
        sku="NRF52840-QIAA-R7",
        description="Bluetooth 5.4 SoC",
        manufacturer_name="Nordic Semiconductor",
        manufacturer_id=nordic.id,
        category_id=seeded_db["child"].id,
        lifecycle_status="active",
    )
    part_both = Part(
        id=uuid.uuid4(),
        sku="NRF52833-QIAA",
        description="Bluetooth 5.4 SoC, Kennedy carries it",
        manufacturer_name="Nordic Semiconductor",
        manufacturer_id=nordic.id,
        category_id=seeded_db["child"].id,
        lifecycle_status="active",
    )
    part_other_mfr = Part(
        id=uuid.uuid4(),
        sku="R5F5210",
        description="Somebody else's chip",
        manufacturer_name="Renesas Electronics",
        manufacturer_id=other_mfr.id,
        category_id=seeded_db["child"].id,
        lifecycle_status="active",
    )
    db.add_all([part_made, part_both, part_other_mfr])
    db.flush()

    # part1 (LM7805CT) is already listed by BOTH suppliers in seeded_db, so it
    # is the "carried" member of the Venn diagram.
    part_carried = seeded_db["part1"]

    # Kennedy's offer on the overlap part; Avnet's offer on a part Nordic makes
    # (visible to the MAKER as "who stocks my parts", never OWNED by them).
    kennedy_on_both = PartListing(
        id=uuid.uuid4(),
        part_id=part_both.id,
        supplier_id=kennedy.id,
        sku="KEN-NRF52833",
        stock_quantity=42,
        unit_price=Decimal("5.1000"),
    )
    avnet_on_made = PartListing(
        id=uuid.uuid4(),
        part_id=part_made.id,
        supplier_id=avnet.id,
        sku="AVN-NRF52840",
        stock_quantity=7,
        unit_price=Decimal("6.2000"),
    )
    db.add_all([kennedy_on_both, avnet_on_made])
    db.flush()

    # A second customer, so "another customer's rows" is a real row and not a
    # hypothetical. Unlinked on purpose — this is the free browsing account.
    stranger = User(
        id=uuid.uuid4(),
        username="stranger",
        password_hash=seeded_db["company_user"].password_hash,
        role="user",
        email="stranger@test.example",
        email_verified_at=datetime.now(UTC),
        activated_at=datetime.now(UTC),
    )
    db.add(stranger)
    db.flush()

    # Three messages: mine, the stranger's, and the shared STAFF inbox (NULL).
    mine = Message(
        id=str(uuid.uuid4()),
        type="contact",
        seq=9001,
        payload={"body": "mine"},
        user_id=seeded_db["company_user"].id,
    )
    theirs = Message(
        id=str(uuid.uuid4()),
        type="contact",
        seq=9002,
        payload={"body": "theirs"},
        user_id=stranger.id,
    )
    staff_inbox = Message(
        id=str(uuid.uuid4()),
        type="contact",
        seq=9003,
        payload={"body": "public form submission"},
        user_id=None,
    )
    db.add_all([mine, theirs, staff_inbox])

    # An Avnet sponsorship, so "somebody else's placement" exists. seeded_db
    # already gives Kennedy a Gold one with status NULL — which counts as
    # Active and must not be dropped.
    avnet_sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=avnet.id,
        category_id=seeded_db["parent"].id,
        description="Avnet's own placement",
        tier="Platinum",
        status="Active",
    )
    db.add(avnet_sponsor)
    db.commit()

    company_user = seeded_db["company_user"]
    company_user.activated_at = datetime.now(UTC)
    db.commit()

    return {
        **seeded_db,
        "nordic": nordic,
        "other_mfr": other_mfr,
        "part_carried": part_carried,
        "part_made": part_made,
        "part_both": part_both,
        "part_other_mfr": part_other_mfr,
        "part_neither": seeded_db["part2"],
        "kennedy_on_both": kennedy_on_both,
        "avnet_on_made": avnet_on_made,
        "kennedy_on_carried": seeded_db["listing2"],
        "avnet_on_carried": seeded_db["listing1"],
        "stranger": stranger,
        "msg_mine": mine,
        "msg_theirs": theirs,
        "msg_staff": staff_inbox,
        "avnet_sponsor": avnet_sponsor,
        "kennedy_sponsor": seeded_db["sponsor"],
    }


def unlinked_scope(world):
    return AccountScope(user_id=world["company_user"].id, supplier_id=None, manufacturer_id=None)


def supplier_scope(world):
    return AccountScope(
        user_id=world["company_user"].id,
        supplier_id=world["supplier2"].id,
        manufacturer_id=None,
    )


def manufacturer_scope(world):
    return AccountScope(
        user_id=world["company_user"].id,
        supplier_id=None,
        manufacturer_id=world["nordic"].id,
    )


def both_scope(world):
    return AccountScope(
        user_id=world["company_user"].id,
        supplier_id=world["supplier2"].id,
        manufacturer_id=world["nordic"].id,
    )


def skus(db, scope):
    return {p.sku for p in db.query(Part).filter(parts_visible_to(scope)).all()}


# ── The dataclass ───────────────────────────────────────────────────────────
class TestAccountScopeShape:
    def test_unlinked_is_neither_and_says_so(self, world):
        scope = unlinked_scope(world)
        assert scope.is_supplier is False
        assert scope.is_manufacturer is False
        assert scope.is_unlinked is True

    def test_supplier_only(self, world):
        scope = supplier_scope(world)
        assert (scope.is_supplier, scope.is_manufacturer, scope.is_unlinked) == (
            True,
            False,
            False,
        )

    def test_manufacturer_only(self, world):
        scope = manufacturer_scope(world)
        assert (scope.is_supplier, scope.is_manufacturer, scope.is_unlinked) == (
            False,
            True,
            False,
        )

    def test_both_links_are_not_exclusive(self, world):
        """Avnet distributes AND manufactures. Never an elif, never a type enum."""
        scope = both_scope(world)
        assert scope.is_supplier is True
        assert scope.is_manufacturer is True
        assert scope.is_unlinked is False

    def test_scope_is_frozen(self, world):
        scope = supplier_scope(world)
        with pytest.raises(FrozenInstanceError):
            scope.supplier_id = uuid.uuid4()

    def test_from_user_reads_both_links(self, world, db):
        user = world["company_user"]
        user.manufacturer_id = world["nordic"].id
        db.flush()
        scope = AccountScope.from_user(user)
        assert scope.user_id == user.id
        assert scope.supplier_id == world["supplier2"].id
        assert scope.manufacturer_id == world["nordic"].id

    def test_a_scope_without_a_user_is_refused(self, world):
        """``Message.user_id == None`` compiles to ``IS NULL``, which is the
        SHARED STAFF INBOX. A scope with no user is therefore not merely
        useless, it is a privilege escalation waiting to be written — so it
        cannot be constructed."""
        with pytest.raises(ValueError):
            AccountScope(user_id=None, supplier_id=None, manufacturer_id=None)


# ── The dependency ──────────────────────────────────────────────────────────
class TestAccountScopeDependency:
    def test_it_depends_on_require_account_user(self):
        """The activation gate is the whole authorization boundary. If this
        ever points at get_current_user, every scoped route silently admits
        staff and unactivated customers."""
        param = inspect.signature(account_scope).parameters["user"]
        assert isinstance(param.default, params.Depends)
        assert param.default.dependency is require_account_user

    @pytest.fixture
    def probe(self, db):
        app = FastAPI()

        @app.get("/probe")
        def _probe(scope: AccountScope = Depends(account_scope)):
            return {
                "user_id": str(scope.user_id),
                "supplier_id": str(scope.supplier_id) if scope.supplier_id else None,
                "manufacturer_id": (str(scope.manufacturer_id) if scope.manufacturer_id else None),
                "is_unlinked": scope.is_unlinked,
            }

        app.dependency_overrides[get_db] = lambda: db
        return TestClient(app)

    def test_activated_customer_gets_their_own_links(self, probe, world, db):
        user = world["company_user"]
        user.manufacturer_id = world["nordic"].id
        db.commit()
        token = create_token(str(user.id), "user")
        resp = probe.get("/probe", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["user_id"] == str(user.id)
        assert body["supplier_id"] == str(world["supplier2"].id)
        assert body["manufacturer_id"] == str(world["nordic"].id)
        assert body["is_unlinked"] is False

    def test_unactivated_customer_is_refused(self, probe, world, db):
        user = world["company_user"]
        user.activated_at = None
        db.commit()
        token = create_token(str(user.id), "user")
        resp = probe.get("/probe", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 403
        assert resp.json()["detail"] == "account_not_activated"

    def test_anonymous_is_refused(self, probe, world):
        assert probe.get("/probe").status_code in (401, 403)


# ── Parts ───────────────────────────────────────────────────────────────────
class TestPartsVisibleTo:
    def test_the_catalog_is_not_empty(self, world, db):
        """Guards every 'sees nothing' assertion below from passing vacuously."""
        assert db.query(Part).count() == 5

    def test_unlinked_sees_nothing(self, world, db):
        assert skus(db, unlinked_scope(world)) == set()

    def test_unlinked_is_a_filter_that_matches_nothing_not_an_absent_filter(self, world):
        """Never None, never [] — a caller doing ``filter(*helper(scope))``
        with an empty list gets the WHOLE CATALOG."""
        clause = parts_visible_to(unlinked_scope(world))
        assert clause is not None
        assert isinstance(clause, ColumnElement)
        sql = str(clause.compile(compile_kwargs={"literal_binds": True}))
        # `col == None` renders IS NULL, which MATCHES rows. An unlinked scope
        # must never compile to a null-comparison against a nullable column.
        assert "IS NULL" not in sql.upper()

    def test_supplier_sees_what_it_carries_and_nothing_else(self, world, db):
        assert skus(db, supplier_scope(world)) == {
            world["part_carried"].sku,
            world["part_both"].sku,
        }

    def test_manufacturer_sees_what_it_makes_and_nothing_else(self, world, db):
        assert skus(db, manufacturer_scope(world)) == {
            world["part_made"].sku,
            world["part_both"].sku,
        }

    def test_both_links_see_the_union(self, world, db):
        assert skus(db, both_scope(world)) == {
            world["part_carried"].sku,
            world["part_made"].sku,
            world["part_both"].sku,
        }

    def test_the_union_is_not_either_or(self, world, db):
        """An if/elif returns one side's answer. Both sides are strict subsets
        here, so either mistake is visible."""
        union = skus(db, both_scope(world))
        carried = skus(db, supplier_scope(world))
        made = skus(db, manufacturer_scope(world))
        assert union == carried | made
        assert union > carried
        assert union > made

    def test_the_union_is_not_an_intersection(self, world, db):
        union = skus(db, both_scope(world))
        intersection = skus(db, supplier_scope(world)) & skus(db, manufacturer_scope(world))
        assert intersection == {world["part_both"].sku}
        assert union != intersection

    def test_the_overlap_part_appears_once(self, world, db):
        rows = db.query(Part).filter(parts_visible_to(both_scope(world))).all()
        assert len(rows) == len({r.id for r in rows}) == 3

    def test_nobody_sees_a_part_that_is_neither(self, world, db):
        orphan = world["part_neither"].sku
        for scope in (
            unlinked_scope(world),
            supplier_scope(world),
            manufacturer_scope(world),
            both_scope(world),
        ):
            assert orphan not in skus(db, scope)

    def test_a_null_manufacturer_id_is_not_a_wildcard(self, world, db):
        """part_carried has manufacturer_id NULL. A maker scope must not pick
        it up, and the maker clause must not be built for a supplier-only
        scope (where manufacturer_id is None → ``IS NULL`` → every unlinked
        part in the catalog)."""
        assert world["part_carried"].manufacturer_id is None
        assert world["part_carried"].sku not in skus(db, manufacturer_scope(world))


# ── Listings ────────────────────────────────────────────────────────────────
class TestListings:
    def _skus(self, db, clause):
        return {listing.sku for listing in db.query(PartListing).filter(clause).all()}

    def test_unlinked_owns_and_sees_nothing(self, world, db):
        assert db.query(PartListing).count() == 4
        scope = unlinked_scope(world)
        assert self._skus(db, listings_visible_to(scope)) == set()
        assert self._skus(db, listings_owned_by(scope)) == set()

    def test_supplier_owns_its_own_shelf(self, world, db):
        assert self._skus(db, listings_owned_by(supplier_scope(world))) == {
            "KEN-LM7805CT",
            "KEN-NRF52833",
        }

    def test_a_maker_owns_no_shelf(self, world, db):
        """Ownership is the WRITE scope. A manufacturer may look at who stocks
        its parts; it may never edit that distributor's offer."""
        assert self._skus(db, listings_owned_by(manufacturer_scope(world))) == set()

    def test_a_maker_sees_offers_on_its_own_parts(self, world, db):
        assert self._skus(db, listings_visible_to(manufacturer_scope(world))) == {
            "AVN-NRF52840",
            "KEN-NRF52833",
        }

    def test_both_links_see_the_union_of_shelf_and_offers(self, world, db):
        union = self._skus(db, listings_visible_to(both_scope(world)))
        assert union == {"KEN-LM7805CT", "KEN-NRF52833", "AVN-NRF52840"}
        assert "AVN-LM7805CT" not in union  # Avnet's offer on a part we neither
        # carry nor make

    def test_owned_is_never_wider_than_visible(self, world, db):
        for scope in (
            unlinked_scope(world),
            supplier_scope(world),
            manufacturer_scope(world),
            both_scope(world),
        ):
            assert self._skus(db, listings_owned_by(scope)) <= self._skus(
                db, listings_visible_to(scope)
            )


# ── Sponsorships ────────────────────────────────────────────────────────────
class TestSponsorships:
    def _ids(self, db, scope):
        return {s.id for s in db.query(Sponsor).filter(sponsorships_visible_to(scope)).all()}

    def test_unlinked_sees_no_placements(self, world, db):
        assert db.query(Sponsor).count() == 2
        assert self._ids(db, unlinked_scope(world)) == set()

    def test_supplier_sees_only_its_own(self, world, db):
        seen = self._ids(db, supplier_scope(world))
        assert seen == {world["kennedy_sponsor"].id}
        assert world["avnet_sponsor"].id not in seen

    def test_a_null_status_row_is_still_visible(self, world, db):
        """seeded_db's Kennedy sponsor omits status. NULL counts as Active and
        this helper must not filter on status at all — it answers WHOSE, not
        whether it is live."""
        assert world["kennedy_sponsor"].status is None
        assert world["kennedy_sponsor"].id in self._ids(db, supplier_scope(world))

    def test_a_maker_alone_has_no_placements(self, world, db):
        """sponsors.supplier_id is NOT NULL — a placement is always a
        supplier's. A manufacturer-only account sees none, and must not fall
        through to 'no filter'."""
        assert self._ids(db, manufacturer_scope(world)) == set()

    def test_both_links_still_see_only_the_supplier_side(self, world, db):
        assert self._ids(db, both_scope(world)) == {world["kennedy_sponsor"].id}


# ── Messages ────────────────────────────────────────────────────────────────
class TestMessages:
    def _seqs(self, db, scope):
        return {m.seq for m in db.query(Message).filter(messages_visible_to(scope)).all()}

    def test_a_customer_sees_only_their_own_inbox(self, world, db):
        assert db.query(Message).count() == 3
        assert self._seqs(db, unlinked_scope(world)) == {9001}

    def test_the_shared_staff_inbox_is_never_visible(self, world, db):
        """messages.user_id NULL is the staff inbox and every public form
        submission. It belongs to no customer."""
        for scope in (
            unlinked_scope(world),
            supplier_scope(world),
            manufacturer_scope(world),
            both_scope(world),
        ):
            assert 9003 not in self._seqs(db, scope)

    def test_another_customers_inbox_is_never_visible(self, world, db):
        assert 9002 not in self._seqs(db, both_scope(world))

    def test_a_stranger_sees_their_own_and_only_their_own(self, world, db):
        scope = AccountScope.from_user(world["stranger"])
        assert self._seqs(db, scope) == {9002}
