// The "You're in" banner the activation email has been promising.
//
// `admin_users.update_user` mails a link to `/account?activated=1` the moment
// staff flip the switch, and nothing rendered anything for it — worse, the
// parameter could not survive the trip: a signed-out recipient meets
// ProtectedRoute's `<Navigate to="/admin/login">`, which drops the query, and
// the hop back lands on `/admin` before bouncing to `/account`. So the flag is
// taken off the URL where it still exists (ProtectedRoute) and held in
// sessionStorage until there is a console to show it over — see
// @admin/services/accountActivation.
//
// A floating notice rather than a strip in the layout: it is rendered above
// AdminLayout, and anything with height there would shove the console's fixed
// chrome. See the SCSS module for why it also spells its own colours.
import styles from './ActivationBanner.module.scss';

export default function ActivationBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.mark} aria-hidden="true">
        &#10003;
      </span>
      <div className={styles.body}>
        <p className={styles.title}>You&rsquo;re in</p>
        <p className={styles.text}>
          Your account has been approved. Everything here is open to you now.
        </p>
      </div>
      <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
