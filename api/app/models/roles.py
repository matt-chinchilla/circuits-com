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
