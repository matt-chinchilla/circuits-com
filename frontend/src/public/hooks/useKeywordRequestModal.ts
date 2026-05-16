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
  selectedTier: RequestModalTier['id'];
  setName: (v: string) => void;
  setCompanyName: (v: string) => void;
  setEmail: (v: string) => void;
  setMessage: (v: string) => void;
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
  const [selectedTier, setSelectedTier] = useState<RequestModalTier['id']>('gold');

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
  // entry point doesn't carry a stale Silver/Platinum choice forward.
  const resetAfterClose = useCallback(() => {
    setName('');
    setCompanyName('');
    setEmail('');
    setMessage('');
    setFormError(null);
    setSubmitted(false);
    setSelectedTier('gold');
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
