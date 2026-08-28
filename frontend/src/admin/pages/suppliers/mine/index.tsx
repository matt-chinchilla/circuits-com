// /account/my-supply — the caller's OWN distributor page.
//
// Half of pair A. The other half, /account/suppliers, is "the distributors
// selling my products" and belongs to the manufacturer link; this one belongs
// to the supplier link, and an account holding both reaches each through the
// switch. Every route keeps exactly one meaning (surface-map §1).
//
// The capability flag decides whether the request is made at all: a customer
// with no supplier link has no row to fetch, and 404-ing on purpose to learn
// something the session already knows is a round trip spent to be told no.

import { useEffect, useState } from 'react';
import { Link2Off } from 'lucide-react';

import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi, isNotLinked } from '@admin/services/accountApi';
import { useConsolePath } from '@admin/services/consolePath';
import type { AccountSupplier } from '@admin/types/account';

import {
  AccountBusy,
  AccountNotice,
  MyCompanyCard,
  MyCompanyShell,
  STAFF_LINKS_ACCOUNTS,
} from '../../manufacturers/AccountCompany';
import { supplyPair } from '../../manufacturers/accountPairs';

type Status = 'busy' | 'ready' | 'unlinked' | 'error';

export default function MySupplyPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { isCustomer, account } = useAuth();
  const isSupplier = isCustomer && account?.is_supplier === true;
  const isManufacturer = isCustomer && account?.is_manufacturer === true;

  const [supplier, setSupplier] = useState<AccountSupplier | null>(null);
  const [status, setStatus] = useState<Status>('busy');

  useEffect(() => {
    if (!isSupplier) {
      setSupplier(null);
      setStatus('unlinked');
      return;
    }
    let cancelled = false;
    setStatus('busy');
    accountApi
      .getMySupply()
      .then((row) => {
        if (cancelled) return;
        setSupplier(row);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        // The 404 means "no such link" — a state, not a failure.
        setStatus(isNotLinked(err) ? 'unlinked' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [isSupplier]);

  return (
    <MyCompanyShell
      title="My Supply"
      subtitle="Your distributor page, as the catalog holds it."
      halves={supplyPair(consolePath, isSupplier, isManufacturer)}
      switchLabel="Supply view"
    >
      {status === 'busy' && <AccountBusy label={'Loading your company…'} />}

      {status === 'unlinked' && (
        <AccountNotice
          icon={<Link2Off size={20} strokeWidth={1.6} />}
          title="No distributor page yet"
          body="This account is not linked to a distributor, so there is no supply page to show."
          hint={STAFF_LINKS_ACCOUNTS}
        />
      )}

      {status === 'error' && (
        <AccountNotice
          title="Could not load your company"
          body="Something went wrong fetching your distributor page. Refresh to try again."
        />
      )}

      {status === 'ready' && supplier && (
        <MyCompanyCard
          name={supplier.name}
          logoUrl={supplier.logo_url}
          website={supplier.website}
          description={supplier.description}
          partsCount={supplier.parts_count}
          partsLabel="Parts you stock"
          tier={account?.tier ?? null}
        />
      )}
    </MyCompanyShell>
  );
}
