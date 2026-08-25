import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell from '@admin/pages/login/components/AuthShell';
import { adminApi } from '@admin/services/adminApi';

/**
 * Spends the emailed verification token.
 *
 * The token is spent by a POST this page performs, NOT by a GET on the link
 * itself: corporate mail scanners prefetch every URL in a message, so a GET
 * would be consumed before the human ever clicked.
 */
export default function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const fired = useRef(false);
  /**
   * Liveness, deliberately a ref rather than a `let cancelled` closed over by
   * the requesting effect.
   *
   * StrictMode tears the first effect run down immediately, which would flip a
   * per-run flag — while `fired` (correctly) stops the second run from opening
   * a replacement request, because the token is single-use. The POST would then
   * land with nothing listening and the page would sit on "One moment" forever
   * in dev. This is re-armed by every run, so it settles on `true` after the
   * double-invoke and reads `false` only after a real unmount.
   */
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    // StrictMode double-invokes effects in dev; the token is single-use, so a
    // second POST would report "already_verified" on a perfectly good link.
    if (fired.current) return;
    fired.current = true;
    const token = params.get('token');
    if (!token) {
      setError('That link is missing its code. Use the link from your email.');
      return;
    }
    adminApi
      .verifyEmail(token)
      .then(() => {
        if (live.current) navigate('/admin/login?welcome=1', { replace: true });
      })
      .catch(() => {
        if (live.current) {
          setError('That link has expired or has already been used.');
        }
      });
  }, [params, navigate]);

  return (
    <AuthShell>
      <div className="screen">
        <p className="eyebrow">
          <span className="dot" /> Confirming your email
        </p>
        <h2>{error ? 'That link did not work' : 'One moment'}</h2>
        {error ? (
          <>
            <p className="lede">{error}</p>
            <div className="success-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => navigate('/admin/login', { replace: true })}
              >
                Back to sign in
              </button>
            </div>
          </>
        ) : (
          <p className="lede">Checking your confirmation link&hellip;</p>
        )}
      </div>
    </AuthShell>
  );
}
