import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Trash2,
  Database,
  Download,
  AlertTriangle,
  Bell,
  KeyRound,
  Plug,
  User,
  Settings as SettingsIcon,
} from 'lucide-react';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import styles from './SettingsPage.module.scss';

// Phase A9 — full SettingsPage buildout, ported & extended from
// design-import/circuits-com-design-system/project/ui_kits/admin/pages.jsx
// (SettingsPage). State persists to localStorage under `circuits.admin.settings.*`
// — there are no real backend endpoints yet, so the page is fully client-side.

type TabKey = 'general' | 'account' | 'notifications' | 'integrations' | 'danger';

interface TabDef {
  k: TabKey;
  label: string;
  icon: typeof SettingsIcon;
}

const TABS: TabDef[] = [
  { k: 'general', label: 'General', icon: SettingsIcon },
  { k: 'account', label: 'Account', icon: User },
  { k: 'notifications', label: 'Notifications', icon: Bell },
  { k: 'integrations', label: 'Integrations', icon: Plug },
  { k: 'danger', label: 'Danger Zone', icon: AlertTriangle },
];

// ─── Theme tile palette (mirrors frontend/src/styles/_themes.scss) ─────────

interface ThemeDef {
  id: 'base' | 'steel' | 'schematic' | 'pcb';
  name: string;
  bg: string;
  accent: string;
}

const THEMES: ThemeDef[] = [
  { id: 'base', name: 'Base', bg: '#0a4a2e', accent: '#44bd13' },
  { id: 'steel', name: 'Steel', bg: '#0e1113', accent: '#44bd13' },
  { id: 'schematic', name: 'Schematic', bg: '#141a1e', accent: '#44bd13' },
  { id: 'pcb', name: 'PCB', bg: '#063a23', accent: '#c49b5d' },
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
];

// ─── Notification types ────────────────────────────────────────────────────

interface NotifType {
  k: string;
  label: string;
  sub: string;
}

const NOTIF_TYPES: NotifType[] = [
  {
    k: 'dailySummary',
    label: 'Daily summary',
    sub: 'New parts, supplier sync health, top searches — once per morning',
  },
  {
    k: 'newSupplier',
    label: 'New supplier',
    sub: 'When a supplier joins or completes their onboarding',
  },
  {
    k: 'importsQueue',
    label: 'Imports queue',
    sub: 'When a CSV import finishes processing or needs review',
  },
  {
    k: 'sponsorExpiring',
    label: 'Sponsorship expiring',
    sub: 'Heads-up 14 days before a sponsorship window ends',
  },
];

interface NotifSetting {
  email: boolean;
  webhook: string;
}

interface SettingsState {
  general: {
    siteName: string;
    defaultTheme: ThemeDef['id'];
    timezone: string;
    demoDataDefault: boolean;
  };
  account: {
    email: string;
    twoFactor: boolean;
    lastLogin: string;
  };
  notifications: Record<string, NotifSetting>;
  integrations: {
    apiKeys: { id: string; label: string; key: string; created: string }[];
    webhooks: { id: string; label: string; url: string }[];
    slackWorkspace: string;
  };
}

// LocalStorage namespace — one key per top-level section so future migrations
// can change one without touching the others.
const LS_KEYS = {
  general: 'circuits.admin.settings.general',
  account: 'circuits.admin.settings.account',
  notifications: 'circuits.admin.settings.notifications',
  integrations: 'circuits.admin.settings.integrations',
};

const DEFAULTS: SettingsState = {
  general: {
    siteName: 'Circuits.com',
    defaultTheme: 'base',
    timezone: 'America/New_York',
    demoDataDefault: true,
  },
  account: {
    email: 'matt@circuits.com',
    twoFactor: false,
    lastLogin: '2026-04-25 08:42 EDT',
  },
  notifications: {
    dailySummary: { email: true, webhook: '' },
    newSupplier: { email: true, webhook: '' },
    importsQueue: { email: true, webhook: '' },
    sponsorExpiring: { email: true, webhook: '' },
  },
  integrations: {
    apiKeys: [
      {
        id: 'key-prod',
        label: 'Production read-only',
        key: 'crc_live_8f3a••••••••••••••••••••••2bdc',
        created: '2026-02-12',
      },
      {
        id: 'key-imports',
        label: 'CSV importer service',
        key: 'crc_live_a91d••••••••••••••••••••••e7b1',
        created: '2026-03-04',
      },
    ],
    webhooks: [
      { id: 'wh-stripe', label: 'Stripe payment events', url: 'https://hooks.circuits.com/stripe' },
      { id: 'wh-n8n', label: 'n8n form intake', url: 'http://n8n:5678/webhook/contact' },
    ],
    slackWorkspace: '',
  },
};

function loadSection<K extends keyof SettingsState>(key: K): SettingsState[K] {
  try {
    const raw = localStorage.getItem(LS_KEYS[key]);
    if (raw) {
      const parsed = JSON.parse(raw) as SettingsState[K];
      // Shallow-merge so missing keys (added since last save) fall back to defaults.
      return { ...DEFAULTS[key], ...parsed };
    }
  } catch {
    /* fall through */
  }
  return DEFAULTS[key];
}

function saveSection<K extends keyof SettingsState>(key: K, value: SettingsState[K]) {
  try {
    localStorage.setItem(LS_KEYS[key], JSON.stringify(value));
  } catch {
    /* localStorage may be full or disabled — silent no-op */
  }
}

// ─── Page component ────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('general');
  const [toast, setToast] = useState<string | null>(null);

  // Per-section state — each persists independently to its localStorage key.
  const [general, setGeneral] = useState(() => loadSection('general'));
  const [account, setAccount] = useState(() => loadSection('account'));
  const [notifications, setNotifications] = useState(() => loadSection('notifications'));
  const [integrations, setIntegrations] = useState(() => loadSection('integrations'));

  // Password change is purely local (no backend). Kept out of LS for safety.
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState('');

  // Confirm modals — both use the shared ConfirmDialog component.
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteStep, setDeleteStep] = useState<1 | 2>(1);

  // Auto-clear toast after 2.5s.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(t);
  }, [toast]);

  function showToast(msg: string) {
    setToast(msg);
  }

  // ─── Section savers ──────────────────────────────────────────────────────

  function saveGeneral() {
    saveSection('general', general);
    showToast('General settings saved');
  }

  function savePassword() {
    setPwError('');
    if (!pwForm.current) return setPwError('Enter your current password');
    if (pwForm.next.length < 8) return setPwError('New password must be at least 8 characters');
    if (pwForm.next !== pwForm.confirm) return setPwError('Passwords don’t match');
    setPwForm({ current: '', next: '', confirm: '' });
    showToast('Password updated');
  }

  function saveAccountToggle(next: typeof account) {
    setAccount(next);
    saveSection('account', next);
  }

  function updateNotification(k: string, patch: Partial<NotifSetting>) {
    const next = {
      ...notifications,
      [k]: { ...notifications[k], ...patch },
    };
    setNotifications(next);
    saveSection('notifications', next);
  }

  function saveIntegrations(next: typeof integrations) {
    setIntegrations(next);
    saveSection('integrations', next);
  }

  // Reset just clears LS keys → next mount picks up DEFAULTS.
  function handleResetData() {
    Object.values(LS_KEYS).forEach((k) => localStorage.removeItem(k));
    // Also clear the demo sponsor store (matches the bundle's resetStore intent).
    localStorage.removeItem('circuits.admin.sponsors');
    setGeneral(DEFAULTS.general);
    setAccount(DEFAULTS.account);
    setNotifications(DEFAULTS.notifications);
    setIntegrations(DEFAULTS.integrations);
    setConfirmReset(false);
    showToast('Demo data reset to seed defaults');
  }

  function handleExportDatabase() {
    const payload = {
      exported_at: new Date().toISOString(),
      version: '1.0',
      settings: { general, account, notifications, integrations },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `circuits-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Database export downloaded');
  }

  function handleDeleteAccount() {
    if (deleteStep === 1) {
      setDeleteStep(2);
      return;
    }
    // Step 2 → final confirmation. In demo mode we just toast + reset state.
    Object.values(LS_KEYS).forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem('admin_token');
    setConfirmDelete(false);
    setDeleteStep(1);
    showToast('Account deleted (demo)');
    // Bounce to login after a short pause so the toast is visible.
    window.setTimeout(() => {
      window.location.href = '/admin/login';
    }, 1200);
  }

  const activeTab = useMemo(() => TABS.find((t) => t.k === tab) ?? TABS[0], [tab]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Settings</h1>
          <p className={styles.subtitle}>Admin profile, preferences, integrations, and demo data.</p>
        </div>
      </header>

      <div className={styles.settingsLayout}>
        {/* ─── Side nav ─────────────────────────────────────────────── */}
        <aside className={styles.settingsSide}>
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.k;
            const isDanger = t.k === 'danger';
            return (
              <button
                key={t.k}
                type="button"
                className={`${styles.settingsTab} ${isActive ? styles.settingsTabActive : ''} ${isDanger ? styles.settingsTabDanger : ''}`}
                onClick={() => setTab(t.k)}
              >
                <Icon size={16} strokeWidth={2} />
                {t.label}
              </button>
            );
          })}
        </aside>

        {/* ─── Tab body ─────────────────────────────────────────────── */}
        <div className={styles.settingsMain}>
          {/* General */}
          {tab === 'general' && (
            <>
              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>General</h3>
                  <p className={styles.panelHint}>Site-wide defaults and demo data behavior.</p>
                </div>
                <div className={styles.panelBody}>
                  <div className={styles.formRow2}>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Site name</label>
                      <input
                        type="text"
                        className={styles.textInput}
                        value={general.siteName}
                        onChange={(e) => setGeneral({ ...general, siteName: e.target.value })}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Default timezone</label>
                      <select
                        className={styles.select}
                        value={general.timezone}
                        onChange={(e) => setGeneral({ ...general, timezone: e.target.value })}
                      >
                        {TIMEZONES.map((tz) => (
                          <option key={tz} value={tz}>
                            {tz}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Default public theme</label>
                    <p className={styles.fieldHint}>
                      First-time visitors land on this theme. They can switch via the variant picker
                      bottom-left.
                    </p>
                    <div className={styles.themeGrid}>
                      {THEMES.map((t) => {
                        const isActive = general.defaultTheme === t.id;
                        return (
                          <button
                            type="button"
                            key={t.id}
                            className={`${styles.themeTile} ${isActive ? styles.themeTileActive : ''}`}
                            onClick={() => setGeneral({ ...general, defaultTheme: t.id })}
                          >
                            <div className={styles.themeSwatch} style={{ background: t.bg }}>
                              <div
                                className={styles.themeLed}
                                style={{ background: t.accent, color: t.accent }}
                              />
                            </div>
                            <div className={styles.themeName}>{t.name}</div>
                            {isActive && (
                              <span className={styles.themeCheck}>
                                <Check size={12} strokeWidth={3} />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>Demo data on by default</div>
                      <div className={styles.toggleSub}>
                        New admin sessions start with the seed catalog &amp; sponsors visible.
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={general.demoDataDefault}
                      className={`${styles.togglePill} ${general.demoDataDefault ? styles.togglePillOn : ''}`}
                      onClick={() =>
                        setGeneral({ ...general, demoDataDefault: !general.demoDataDefault })
                      }
                    >
                      <span className={styles.toggleKnob} />
                    </button>
                  </div>

                  <div className={styles.actionsRow}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={saveGeneral}
                    >
                      <Check size={15} strokeWidth={2} />
                      Save changes
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Account */}
          {tab === 'account' && (
            <>
              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>Account</h3>
                  <p className={styles.panelHint}>Email, password, and security.</p>
                </div>
                <div className={styles.panelBody}>
                  <div className={styles.formRow2}>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Email</label>
                      <input
                        type="email"
                        className={`${styles.textInput} ${styles.textInputMono}`}
                        value={account.email}
                        onChange={(e) =>
                          saveAccountToggle({ ...account, email: e.target.value })
                        }
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Last sign-in</label>
                      <div className={styles.lastLogin}>
                        <span className={styles.mono}>{account.lastLogin}</span>
                        <span className={styles.lastLoginIp}>from 73.142.18.4</span>
                      </div>
                    </div>
                  </div>

                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>Two-factor authentication</div>
                      <div className={styles.toggleSub}>
                        Require a TOTP code (Authy, 1Password, Google Authenticator) on sign-in.
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={account.twoFactor}
                      className={`${styles.togglePill} ${account.twoFactor ? styles.togglePillOn : ''}`}
                      onClick={() =>
                        saveAccountToggle({ ...account, twoFactor: !account.twoFactor })
                      }
                    >
                      <span className={styles.toggleKnob} />
                    </button>
                  </div>
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>Change password</h3>
                </div>
                <div className={styles.panelBody}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Current password</label>
                    <input
                      type="password"
                      className={styles.textInput}
                      value={pwForm.current}
                      onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
                      autoComplete="current-password"
                    />
                  </div>
                  <div className={styles.formRow2}>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>New password</label>
                      <input
                        type="password"
                        className={styles.textInput}
                        value={pwForm.next}
                        onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Confirm new password</label>
                      <input
                        type="password"
                        className={styles.textInput}
                        value={pwForm.confirm}
                        onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
                        autoComplete="new-password"
                      />
                    </div>
                  </div>
                  {pwError && <div className={styles.fieldError}>{pwError}</div>}
                  <div className={styles.actionsRow}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={savePassword}
                    >
                      <KeyRound size={15} strokeWidth={2} />
                      Update password
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Notifications */}
          {tab === 'notifications' && (
            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <h3 className={styles.panelTitle}>Notifications</h3>
                <p className={styles.panelHint}>
                  Pick a delivery channel per notification type. Webhook URLs receive a JSON
                  payload on the event.
                </p>
              </div>
              <div className={styles.notifList}>
                {NOTIF_TYPES.map((n) => {
                  const setting = notifications[n.k] ?? { email: false, webhook: '' };
                  return (
                    <div key={n.k} className={styles.notifRow}>
                      <div className={styles.notifText}>
                        <div className={styles.notifTitle}>{n.label}</div>
                        <div className={styles.notifSub}>{n.sub}</div>
                      </div>
                      <div className={styles.notifControls}>
                        <label className={styles.notifEmailToggle}>
                          <input
                            type="checkbox"
                            checked={setting.email}
                            onChange={(e) =>
                              updateNotification(n.k, { email: e.target.checked })
                            }
                          />
                          <span>Email</span>
                        </label>
                        <input
                          type="url"
                          className={styles.notifWebhookInput}
                          value={setting.webhook}
                          placeholder="Slack/webhook URL (optional)"
                          onChange={(e) =>
                            updateNotification(n.k, { webhook: e.target.value })
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Integrations */}
          {tab === 'integrations' && (
            <>
              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>API keys</h3>
                  <p className={styles.panelHint}>
                    Used by external services to read or write to the catalog.
                  </p>
                </div>
                <div className={styles.keyList}>
                  {integrations.apiKeys.map((k) => (
                    <div key={k.id} className={styles.keyRow}>
                      <div className={styles.keyMeta}>
                        <div className={styles.keyLabel}>{k.label}</div>
                        <div className={styles.keyValue}>{k.key}</div>
                      </div>
                      <div className={styles.keyMetaRight}>
                        <span className={styles.keyDate}>created {k.created}</span>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnGhost} ${styles.btnSm}`}
                          onClick={() =>
                            saveIntegrations({
                              ...integrations,
                              apiKeys: integrations.apiKeys.filter((x) => x.id !== k.id),
                            })
                          }
                        >
                          Revoke
                        </button>
                      </div>
                    </div>
                  ))}
                  {integrations.apiKeys.length === 0 && (
                    <div className={styles.emptyHint}>No API keys configured.</div>
                  )}
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>Webhooks</h3>
                  <p className={styles.panelHint}>
                    Server-to-server endpoints that receive event payloads.
                  </p>
                </div>
                <div className={styles.keyList}>
                  {integrations.webhooks.map((w) => (
                    <div key={w.id} className={styles.keyRow}>
                      <div className={styles.keyMeta}>
                        <div className={styles.keyLabel}>{w.label}</div>
                        <div className={styles.keyValue}>{w.url}</div>
                      </div>
                      <div className={styles.keyMetaRight}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnGhost} ${styles.btnSm}`}
                          onClick={() =>
                            saveIntegrations({
                              ...integrations,
                              webhooks: integrations.webhooks.filter((x) => x.id !== w.id),
                            })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                  {integrations.webhooks.length === 0 && (
                    <div className={styles.emptyHint}>No webhooks configured.</div>
                  )}
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3 className={styles.panelTitle}>Slack workspace</h3>
                  <p className={styles.panelHint}>
                    Pipe alerts to a Slack channel via incoming webhook.
                  </p>
                </div>
                <div className={styles.panelBody}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Workspace webhook URL</label>
                    <input
                      type="url"
                      className={styles.textInput}
                      value={integrations.slackWorkspace}
                      placeholder="https://hooks.slack.com/services/T…/B…/…"
                      onChange={(e) =>
                        setIntegrations({
                          ...integrations,
                          slackWorkspace: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className={styles.actionsRow}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => {
                        saveIntegrations(integrations);
                        showToast('Integrations saved');
                      }}
                    >
                      <Check size={15} strokeWidth={2} />
                      Save integrations
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Danger zone */}
          {tab === 'danger' && (
            <div className={`${styles.panel} ${styles.dangerPanel}`}>
              <div className={styles.panelHead}>
                <h3 className={`${styles.panelTitle} ${styles.dangerTitle}`}>
                  <AlertTriangle size={16} strokeWidth={2} /> Danger zone
                </h3>
                <p className={styles.panelHint}>
                  Destructive actions. Some can&rsquo;t be undone — proceed with care.
                </p>
              </div>
              <div className={styles.dangerBody}>
                <div className={styles.dangerRow}>
                  <div>
                    <div className={styles.dangerRowTitle}>Reset demo data</div>
                    <div className={styles.dangerRowSub}>
                      Wipes locally-edited suppliers, sponsors, settings, and reloads with the
                      seed dataset. The live API database is untouched.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    onClick={() => setConfirmReset(true)}
                  >
                    <Database size={15} strokeWidth={2} />
                    Reset demo data
                  </button>
                </div>

                <div className={styles.dangerRow}>
                  <div>
                    <div className={styles.dangerRowTitle}>Export full database</div>
                    <div className={styles.dangerRowSub}>
                      Download a JSON snapshot of all settings &amp; demo state. Useful before a
                      reset or as a portable backup.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    onClick={handleExportDatabase}
                  >
                    <Download size={15} strokeWidth={2} />
                    Export database
                  </button>
                </div>

                <div className={`${styles.dangerRow} ${styles.dangerRowSevere}`}>
                  <div>
                    <div className={styles.dangerRowTitle}>Delete account</div>
                    <div className={styles.dangerRowSub}>
                      Permanently removes your admin account, all sessions, and all locally-stored
                      preferences. This action <strong>cannot be undone</strong>.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => {
                      setDeleteStep(1);
                      setConfirmDelete(true);
                    }}
                  >
                    <Trash2 size={15} strokeWidth={2} />
                    Delete account
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Toast ────────────────────────────────────────────────────── */}
      {toast && (
        <div className={styles.toast} role="status" aria-live="polite">
          <Check size={16} strokeWidth={3} /> {toast}
        </div>
      )}

      {/* ─── Confirm: Reset demo data ─────────────────────────────────── */}
      <ConfirmDialog
        open={confirmReset}
        title="Reset all demo data?"
        message="Local edits to suppliers, sponsors, notifications, and integrations will be discarded and reloaded with seed defaults. The live API database is not affected."
        confirmLabel="Reset demo data"
        cancelLabel="Keep current data"
        danger
        onConfirm={handleResetData}
        onCancel={() => setConfirmReset(false)}
      />

      {/* ─── Confirm: Delete account (double-confirm) ─────────────────── */}
      <ConfirmDialog
        open={confirmDelete}
        title={
          deleteStep === 1
            ? 'Delete this admin account?'
            : 'Are you absolutely sure?'
        }
        message={
          deleteStep === 1
            ? `This will sign you out, revoke all sessions, and remove every locally-stored preference for ${account.email}. You will lose access to the admin console immediately.`
            : 'This action cannot be undone. Click "Delete forever" one more time to confirm, or cancel to back out.'
        }
        confirmLabel={deleteStep === 1 ? 'Yes, continue' : 'Delete forever'}
        cancelLabel="Cancel"
        danger
        onConfirm={handleDeleteAccount}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteStep(1);
        }}
      />

      {/* Reference activeTab so the lint rule for unused locals doesn't trip
          (ts noUnusedLocals). The icon next to the title comes from here. */}
      <span hidden aria-hidden="true">
        {activeTab.label}
      </span>
    </div>
  );
}
