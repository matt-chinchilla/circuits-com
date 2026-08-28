import { Link } from 'react-router-dom';
import Icon from '@shared/components/Icon';
import { useConsolePath } from '@admin/services/consolePath';
import { useAuth } from '@admin/contexts/AuthContext';
import { initialsOf } from '@admin/components/messages/messageHelpers';
import { payloadText } from '../customerInbox';
import styles from './CustomerWelcome.module.scss';

/**
 * The welcome row, rendered as the centrepiece it is: it is the first thing
 * every new customer opens, and for most of them it is the console's only
 * introduction to itself.
 *
 * Its payload carries a name and nothing else — routes/auth.py writes
 * `{first_name, full_name}` when the address is verified — so the greeting is
 * all that is read from it. Everything below the greeting is the ORIENTATION,
 * and it is built from the account's two capability links so it can only ever
 * offer pages that mean something for this company.
 */

interface Stop {
  /** Already rewritten onto the rendering mount — see `consolePath` below. */
  to: string;
  label: string;
  icon: string;
  blurb: string;
}

/**
 * The same rule the sidebar is built from (spec §1), and it must stay the
 * same rule: capability is TWO INDEPENDENT LINKS, never a type. Both set is
 * the normal case for the largest players, neither is the free account, and
 * each PAIR resolves to the single half that has a meaning here — the pair's
 * other half is reached from the page itself, through CatalogSwitch.
 */
function orientationStops(
  isSupplier: boolean,
  isManufacturer: boolean,
  consolePath: (adminPath: string) => string,
): Stop[] {
  const stops: Stop[] = [
    {
      to: consolePath('/admin'),
      label: 'Dashboard',
      icon: 'gauge',
      blurb: 'Your parts, your placements and what they cost, at a glance.',
    },
    {
      to: consolePath('/admin/parts'),
      label: 'Parts',
      icon: 'package',
      blurb: 'Every part of yours in the Circuit Center catalog.',
    },
    {
      to: consolePath('/admin/categories'),
      label: 'Categories',
      icon: 'squares-four',
      blurb: 'Where those parts sit on the public site.',
    },
  ];

  if (isSupplier || isManufacturer) {
    stops.push(
      isManufacturer
        ? {
            to: consolePath('/admin/suppliers'),
            label: 'Suppliers',
            icon: 'buildings',
            blurb: 'The distributors listing your products.',
          }
        : {
            to: consolePath('/admin/my-supply'),
            label: 'My Supply',
            icon: 'buildings',
            blurb: 'Your own distributor page, as buyers see it.',
          },
    );
    stops.push(
      isSupplier
        ? {
            to: consolePath('/admin/manufacturers'),
            label: 'Manufacturers',
            icon: 'factory',
            blurb: 'The makers whose products you carry.',
          }
        : {
            to: consolePath('/admin/my-manufacturing'),
            label: 'My Manufacturing',
            icon: 'factory',
            blurb: 'Your own manufacturer page, as buyers see it.',
          },
    );
  }

  // `sponsors.supplier_id` is NOT NULL, so a maker cannot hold a placement
  // today — offering the page would be offering a permanent empty list.
  if (isSupplier) {
    stops.push({
      to: consolePath('/admin/sponsors'),
      label: 'Sponsorships',
      icon: 'star',
      blurb: 'The placements your company holds, live and lapsed.',
    });
  }

  return stops;
}

export default function CustomerWelcomeBody({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { account } = useAuth();
  const isSupplier = account?.is_supplier === true;
  const isManufacturer = account?.is_manufacturer === true;

  const firstName = payloadText(payload, 'first_name');
  const fullName = payloadText(payload, 'full_name');
  const stops = orientationStops(isSupplier, isManufacturer, consolePath);

  return (
    <div className={styles.welcome}>
      <div className={styles.hero}>
        <div className={styles.avatar}>{initialsOf(fullName ?? firstName ?? '')}</div>
        <div className={styles.greeting}>
          Welcome{firstName ? `, ${firstName}` : ''}.
        </div>
        <p className={styles.lede}>
          Your Circuit Center account is open. Everything in this console is scoped to you
          &mdash; the parts we list for your company, where they sit in the catalog, and
          whatever else is yours. Nothing here is anybody else&rsquo;s.
        </p>
      </div>

      <div className={styles.guideLabel}>Where to start</div>
      <div className={styles.stops}>
        {stops.map((stop) => (
          <Link key={stop.to} to={stop.to} className={styles.stop}>
            <span className={styles.stopHead}>
              <Icon name={stop.icon} className={styles.stopIcon} />
              {stop.label}
            </span>
            <p className={styles.stopBlurb}>{stop.blurb}</p>
          </Link>
        ))}
      </div>

      {!isSupplier && !isManufacturer && (
        <p className={styles.unlinked}>
          Your account is not linked to a company yet. Circuit Center staff make that link
          &mdash; once yours is made, these pages fill with your own catalog, and the pages
          that belong to a distributor or a manufacturer appear alongside them.
        </p>
      )}
    </div>
  );
}
