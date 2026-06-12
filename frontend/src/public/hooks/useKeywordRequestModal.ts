import { useCallback, useState, type FormEvent } from 'react';
import { api } from '@public/services/api';
import type { RequestModalTier } from '@public/components/widgets/RequestModal';

// Shared form-state + submit pipeline for the keyword-sponsorship RequestModal.
// Both /keyword (landing) and /keyword/:keyword consume this — they only differ
// in how they manage the modal-open boolean (the landing page tracks the
// pre-filled keyword in the open state; the detail page reads it from URL
// params). So the hook owns form fields + submit + reset, and the host page
// owns open/close. Default tier is 'gold' (the design's recommended tier) so
// AT users land on a chosen radio option immediately.
//
// Keyword tier set (2026-06-11): per the sponsor-tier-boards matrix, keyword
// sponsorships accept only Silver or Gold — Platinum is reserved for top-level
// Category Sponsor boards and the backend `KeywordRequestForm.tier` Literal now
// rejects it (422). The picker still RENDERS the Platinum pricing card (visual
// only), but `setSelectedTier` coerces any Platinum pick down to Gold so the
// submitted `tier` is always in {silver, gold}; `KeywordTier` enforces the same
// at the type level.

// The tiers a keyword request may actually be submitted as. Narrower than the
// RequestModal picker's id union (which still includes 'platinum' for the
// display-only pricing card) — Platinum is coerced to 'gold' before it can
// reach state.
type KeywordTier = 'silver' | 'gold';

interface UseKeywordRequestModalOptions {
  /** Tag included in console.error logs to identify the calling page. */
  logTag: string;
}

interface UseKeywordRequestModalReturn {
  name: string;
  companyName: string;
  email: string;
  message: string;
  submitting: boolean;
  submitted: boolean;
  formError: string | null;
  selectedTier: KeywordTier;
  setName: (v: string) => void;
  setCompanyName: (v: string) => void;
  setEmail: (v: string) => void;
  setMessage: (v: string) => void;
  // Accepts the full picker id union (incl. 'platinum' from the display-only
  // pricing card) but coerces Platinum to Gold — state never holds 'platinum'.
  setSelectedTier: (id: RequestModalTier['id']) => void;
  handleSubmit: (keyword: string) => (e: FormEvent) => Promise<void>;
  resetAfterClose: () => void;
}

export function useKeywordRequestModal(
  { logTag }: UseKeywordRequestModalOptions,
): UseKeywordRequestModalReturn {
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedTier, setSelectedTierState] = useState<KeywordTier>('gold');

  // Coerce the picker's id union down to a submittable keyword tier: Platinum
  // (display-only pricing card) folds to Gold so state — and therefore the POST
  // body and the success receipt — never carries 'platinum'.
  const setSelectedTier = useCallback((id: RequestModalTier['id']) => {
    setSelectedTierState(id === 'platinum' ? 'gold' : id);
  }, []);

  const handleSubmit = useCallback(
    (keyword: string) => async (e: FormEvent) => {
      e.preventDefault();
      setFormError(null);

      if (!name.trim() || !companyName.trim() || !email.trim()) {
        setFormError('Name, company name, and email are required.');
        return;
      }

      setSubmitting(true);
      try {
        await api.submitKeywordRequest({
          company_name: companyName.trim(),
          email: email.trim(),
          keyword,
          name: name.trim(),
          tier: selectedTier,
          message: message.trim(),
        });
        setSubmitted(true);
      } catch (err) {
        console.error(`[${logTag}] keyword-request submit failed`, err);
        setFormError('Something went wrong. Please try again later.');
      } finally {
        setSubmitting(false);
      }
    },
    [name, companyName, email, message, selectedTier, logTag],
  );

  // Fires after the modal's close-animation completes so the user doesn't
  // see fields blank mid-fade. Callers schedule via setTimeout(..., 200).
  // selectedTier resets to 'gold' so a subsequent open from a non-tier-card
  // entry point doesn't carry a stale Silver choice forward. Uses the raw
  // state setter (not the coercing wrapper) — reset writes a known-good tier.
  const resetAfterClose = useCallback(() => {
    setName('');
    setCompanyName('');
    setEmail('');
    setMessage('');
    setFormError(null);
    setSubmitted(false);
    setSelectedTierState('gold');
  }, []);

  return {
    name,
    companyName,
    email,
    message,
    submitting,
    submitted,
    formError,
    selectedTier,
    setName,
    setCompanyName,
    setEmail,
    setMessage,
    setSelectedTier,
    handleSubmit,
    resetAfterClose,
  };
}
