// The console's route table, extracted from App.tsx so it can be MOUNTED TWICE
// — once under /admin for staff, once under /account for customers. The two
// mounts differ only in the guard above them and in their URL prefix; React
// Router resolves these relative paths from whichever mount matched, so this
// component takes no props and knows nothing about which one it is under.
//
// The lazy() page imports live here rather than in App.tsx for the same reason
// they lived there before: each console page keeps its own chunk, and none of
// them reaches the public entry bundle. The <Suspense> boundary is App.tsx's.
import { lazy } from "react";
import { Routes, Route } from "react-router-dom";

const DashboardPage = lazy(() => import("@admin/pages/dashboard"));
const SuppliersPage = lazy(() => import("@admin/pages/suppliers/list"));
const ManufacturersPage = lazy(() => import('@admin/pages/manufacturers/list'));
const ManufacturerDetailPage = lazy(() => import('@admin/pages/manufacturers/detail'));
const ManufacturerFormPage = lazy(() => import('@admin/pages/manufacturers/form'));
const UsersListPage = lazy(() => import('@admin/pages/users/list'));
const LeadsPage = lazy(() => import('@admin/pages/leads/list'));
const LeadDetailPage = lazy(() => import('@admin/pages/leads/detail'));
const LeadRepPage = lazy(() => import('@admin/pages/leads/rep'));
const SupplierDetailPage = lazy(
  () => import("@admin/pages/suppliers/detail"),
);
const SupplierFormPage = lazy(() => import("@admin/pages/suppliers/form"));
// The customer console's two own-company pages. They have no staff twin: the
// sidebar offers each one only to an account holding that capability link, and
// CatalogSwitch is how an account holding both moves between the halves of a
// pair (surface-map 1).
const MySupplyPage = lazy(() => import("@admin/pages/suppliers/mine"));
const MyManufacturingPage = lazy(() => import("@admin/pages/manufacturers/mine"));
const PartsPage = lazy(() => import("@admin/pages/parts/list"));
const PartDetailPage = lazy(() => import("@admin/pages/parts/detail"));
const PartFormPage = lazy(() => import("@admin/pages/parts/form"));
const AttachListingPage = lazy(() => import("@admin/pages/parts/attach"));
const ImportPage = lazy(() => import("@admin/pages/import"));
const ReportsPage = lazy(() => import("@admin/pages/reports"));
const CategoriesPage = lazy(() => import("@admin/pages/categories"));
const SponsorsPage = lazy(() => import("@admin/pages/sponsors/list"));
const SponsorFormPage = lazy(() => import("@admin/pages/sponsors/form"));
const ExpensesPage = lazy(() => import("@admin/pages/expenses/list"));
const ExpenseFormPage = lazy(() => import("@admin/pages/expenses/form"));
const SettingsPage = lazy(() => import("@admin/pages/settings"));
const MessagesListPage = lazy(() => import("@admin/pages/messages/list"));
const MessageDetailPage = lazy(() => import("@admin/pages/messages/detail"));

export default function ConsoleRoutes() {
  return (
    <Routes>
      <Route index element={<DashboardPage />} />
      <Route path="suppliers" element={<SuppliersPage />} />
      <Route path="manufacturers" element={<ManufacturersPage />} />
      <Route path="manufacturers/new" element={<ManufacturerFormPage />} />
      <Route path="manufacturers/:id" element={<ManufacturerDetailPage />} />
      <Route path="manufacturers/:id/edit" element={<ManufacturerFormPage />} />
      {/* Reachable at BOTH mounts, so /account/users resolves too. That is
          acceptable under D16 (the console is shared) and the server refuses:
          /api/admin/users is require_staff, so a customer sees the page chrome
          and an error, not a roster. Trimming customer-side routes is
          Project 2 work. */}
      <Route path="users" element={<UsersListPage />} />
      <Route path="leads" element={<LeadsPage />} />
      <Route path="leads/reps/:username" element={<LeadRepPage />} />
      <Route path="leads/:id" element={<LeadDetailPage />} />
      <Route
        path="suppliers/new"
        element={<SupplierFormPage />}
      />
      <Route
        path="suppliers/:id"
        element={<SupplierDetailPage />}
      />
      <Route
        path="suppliers/:id/edit"
        element={<SupplierFormPage />}
      />
      <Route path="my-supply" element={<MySupplyPage />} />
      <Route path="my-manufacturing" element={<MyManufacturingPage />} />
      <Route path="parts" element={<PartsPage />} />
      <Route path="parts/new" element={<PartFormPage />} />
      <Route path="parts/:id" element={<PartDetailPage />} />
      <Route path="parts/:id/edit" element={<PartFormPage />} />
      <Route
        path="parts/:id/listings/new"
        element={<AttachListingPage />}
      />
      <Route path="import" element={<ImportPage />} />
      <Route path="reports" element={<ReportsPage />} />
      <Route path="categories" element={<CategoriesPage />} />
      <Route path="sponsors" element={<SponsorsPage />} />
      <Route
        path="sponsors/new"
        element={<SponsorFormPage />}
      />
      <Route
        path="sponsors/:id/edit"
        element={<SponsorFormPage />}
      />
      <Route path="expenses" element={<ExpensesPage />} />
      <Route path="expenses/new" element={<ExpenseFormPage />} />
      <Route
        path="expenses/:id/edit"
        element={<ExpenseFormPage />}
      />
      <Route path="messages" element={<MessagesListPage />} />
      <Route
        path="messages/:id"
        element={<MessageDetailPage />}
      />
      <Route path="settings" element={<SettingsPage />} />
    </Routes>
  );
}
