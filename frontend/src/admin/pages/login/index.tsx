import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@admin/contexts/AuthContext';
import Icon from '@shared/components/Icon';
import styles from './LoginPage.module.scss';

export default function LoginPage() {
  const { login, isAuthenticated, loading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/admin" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(username, password);
    } catch {
      setError('Invalid username or password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <Icon name="arrow-left" />
        <span>Back to circuits.com</span>
      </Link>
      <form className={styles.card} onSubmit={handleSubmit}>
        <div className={styles.header}>
          <span className={styles.logo}>{'\u26A1'}</span>
          <h1 className={styles.title}>Circuits Control Center</h1>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <label className={styles.label} htmlFor="login-username">
          Username
        </label>
        <input
          id="login-username"
          className={styles.input}
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />

        <label className={styles.label} htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          className={styles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        <button
          className={styles.submit}
          type="submit"
          disabled={submitting}
        >
          {submitting ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
