from fastapi import FastAPI
from sqladmin import Admin, ModelView
from sqladmin.authentication import AuthenticationBackend
from starlette.requests import Request

from app.config import settings
from app.db.session import engine
from app.models.supplier import Supplier, CategorySupplier
from app.models.category import Category
from app.models.sponsor import Sponsor


class AdminAuth(AuthenticationBackend):
    async def login(self, request: Request) -> bool:
        form = await request.form()
        username = form.get("username")
        password = form.get("password")

        if username == settings.ADMIN_USERNAME and password == settings.ADMIN_PASSWORD:
            request.session.update({"authenticated": True})
            return True
        return False

    async def logout(self, request: Request) -> bool:
        request.session.clear()
        return True

    async def authenticate(self, request: Request) -> bool:
        return request.session.get("authenticated", False)


class SupplierAdmin(ModelView, model=Supplier):
    name = "Supplier"
    name_plural = "Suppliers"
    icon = "fa-solid fa-building"
    column_list = [Supplier.name, Supplier.phone, Supplier.email, Supplier.website]
    column_searchable_list = [Supplier.name, Supplier.email]
    column_sortable_list = [Supplier.name]
    column_default_sort = "name"
    form_excluded_columns = [Supplier.category_associations]


class CategoryAdmin(ModelView, model=Category):
    name = "Category"
    name_plural = "Categories"
    icon = "fa-solid fa-folder"
    column_list = [Category.name, Category.slug, Category.icon, Category.parent, Category.sort_order]
    column_searchable_list = [Category.name, Category.slug]
    column_sortable_list = [Category.name, Category.sort_order]
    column_default_sort = "name"
    form_excluded_columns = [Category.children, Category.supplier_associations]


class CategorySupplierAdmin(ModelView, model=CategorySupplier):
    name = "Category Assignment"
    name_plural = "Category Assignments"
    icon = "fa-solid fa-link"
    column_list = [
        CategorySupplier.supplier,
        CategorySupplier.category,
        CategorySupplier.is_featured,
        CategorySupplier.rank,
    ]
    column_sortable_list = [CategorySupplier.rank, CategorySupplier.is_featured]


class SponsorAdmin(ModelView, model=Sponsor):
    name = "Sponsor"
    name_plural = "Sponsors"
    icon = "fa-solid fa-star"
    column_list = [Sponsor.supplier, Sponsor.category, Sponsor.keyword, Sponsor.tier]
    column_sortable_list = [Sponsor.tier]


def setup_admin(app: FastAPI) -> Admin:
    auth_backend = AdminAuth(secret_key=settings.ADMIN_SECRET_KEY)
    admin = Admin(
        app,
        engine,
        authentication_backend=auth_backend,
        title="Circuits.com Admin",
    )
    admin.add_view(SupplierAdmin)
    admin.add_view(CategoryAdmin)
    admin.add_view(CategorySupplierAdmin)
    admin.add_view(SponsorAdmin)
    return admin
