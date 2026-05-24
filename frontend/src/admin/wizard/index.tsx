// Wizard module entry. Mount <Wizard /> as a sibling of <Outlet /> in
// AdminLayout — it'll only render when the user is inside the admin
// scope, which is exactly where it's useful.
//
// The wizard depends on React Router context (useLocation, useNavigate)
// so it must be inside the BrowserRouter tree. Mounting at the layout
// level satisfies that naturally.
export { default as Wizard } from './WizardApp';
