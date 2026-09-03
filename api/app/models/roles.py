"""The roles that count as "an administrator of this site".

``owner`` (alembic 022) is a tier ABOVE ``admin``, not a sibling of it, so every
query that means "an admin" has to accept both. A bare ``User.role == "admin"``
silently drops the owner — ``/api/admin/sales-reps`` did exactly that and
rendered the site owner as a departed employee ("matthew (former)") the moment
the migration promoted him.

Kept next to the models so ``db/seed.py`` and the routers share one definition
rather than each hardcoding the pair.
"""

ADMIN_ROLES = ("admin", "owner")

# The customer principal (alembic 043). Deliberately disjoint from
# ADMIN_ROLES: a membership test against one must never accidentally admit
# the other, which is exactly how the pre-043 console let a customer-role
# user reach /api/admin/sponsors/.
CUSTOMER_ROLES = ("user",)

# Read-only staff (alembic 051; owner ask 2026-09-03: a prospective partner
# should "see the backend" without being able to change it). A viewer clears
# the customer/staff wall on every GET and is refused with 403 read_only on
# every other verb — see services/auth_service.require_staff. Deliberately NOT
# in ADMIN_ROLES: every query that means "an administrator who ACTS" (the
# sales-rep roster, seed adoption, the owner tier) must keep excluding it.
VIEWER_ROLES = ("viewer",)

# Everyone the /admin mount belongs to — acting administrators plus read-only
# viewers. This is the membership `is_staff` tests; ADMIN_ROLES stays the
# membership "may this account be listed as a rep / act on the data".
STAFF_ROLES = ADMIN_ROLES + VIEWER_ROLES
