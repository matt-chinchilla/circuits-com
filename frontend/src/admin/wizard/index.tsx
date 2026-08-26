// Wizard module entry. Mount <Wizard /> as a sibling of <Outlet /> in
// AdminLayout — it'll only render when the user is inside the admin
// scope, which is exactly where it's useful.
//
// The wizard depends on React Router context (useLocation, useNavigate)
// so it must be inside the BrowserRouter tree. Mounting at the layout
// level satisfies that naturally.
//
// STAFF ONLY, and gated HERE rather than at the call site so no future mount
// can forget: AdminLayout is the chrome for BOTH consoles (D16), so a customer
// at /account was being offered the guided tours — which teach the internal
// catalog, and whose steps navigate to /admin routes ProtectedRoute bounces
// them out of. That is also what keeps `helpers.navTo` honest: it addresses
// /admin absolutely, which is correct for the only audience that can see it.
import { useAuth } from '@admin/contexts/AuthContext';
import { isStaff } from '@admin/services/permissions';
import WizardApp from './WizardApp';

export function Wizard() {
  const { user } = useAuth();
  // Before the early return, so the hook order is the same on every render.
  if (!isStaff(user)) return null;
  return <WizardApp />;
}

export default Wizard;
