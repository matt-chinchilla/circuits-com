// /account/my-manufacturing — the caller's OWN manufacturer page.
//
// Half of pair B, and the mirror of /account/my-supply: the other half,
// /account/manufacturers, is "the makers whose products I sell" and belongs to
// the supplier link, while this one belongs to the manufacturer link.
//
// `parts_count` here is their parts in OUR catalog — the live count, never the
// roster's `external_part_count`, which is somebody else's figure.

import { useEffect, useState } from 'react';
import { Link2Off } from 'lucide-react';

import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi, isNotLinked } from '@admin/services/accountApi';
import { useConsolePath } from '@admin/services/consolePath';
import type { AccountManufacturer } from '@admin/types/account';

import {
  AccountBusy,
  AccountNotice,
  MyCompanyCard,
  MyCompanyShell,
  STAFF_LINKS_ACCOUNTS,
} from '../AccountCompany';
import { manufacturingPair } from '../accountPairs';

type Status = 'busy' | 'ready' | 'unlinked' | 'error';

export default function MyManufacturingPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { isCustomer, account } = useAuth();
  const isSupplier = isCustomer && account?.is_supplier === true;
  const isManufacturer = isCustomer && account?.is_manufacturer === true;

  const [manufacturer, setManufacturer] = useState<AccountManufacturer | null>(null);
  const [status, setStatus] = useState<Status>('busy');

  useEffect(() => {
    if (!isManufacturer) {
      setManufacturer(null);
      setStatus('unlinked');
      return;
    }
    let cancelled = false;
    setStatus('busy');
    accountApi
      .getMyManufacturing()
      .then((row) => {
        if (cancelled) return;
        setManufacturer(row);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus(isNotLinked(err) ? 'unlinked' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [isManufacturer]);

  return (
    <MyCompanyShell
      title="My Manufacturing"
      subtitle="Your manufacturer page, as the catalog holds it."
      halves={manufacturingPair(consolePath, isSupplier, isManufacturer)}
      switchLabel="Manufacturing view"
    >
      {status === 'busy' && <AccountBusy label={'Loading your company…'} />}

      {status === 'unlinked' && (
        <AccountNotice
          icon={<Link2Off size={20} strokeWidth={1.6} />}
          title="No manufacturer page yet"
          body="This account is not linked to a manufacturer, so there is no manufacturing page to show."
          hint={STAFF_LINKS_ACCOUNTS}
        />
      )}

      {status === 'error' && (
        <AccountNotice
          title="Could not load your company"
          body="Something went wrong fetching your manufacturer page. Refresh to try again."
        />
      )}

      {status === 'ready' && manufacturer && (
        <MyCompanyCard
          name={manufacturer.name}
          logoUrl={manufacturer.logo_url}
          website={manufacturer.website}
          partsCount={manufacturer.parts_count}
          partsLabel="Your parts in our catalog"
          tier={account?.tier ?? null}
        />
      )}
    </MyCompanyShell>
  );
}
