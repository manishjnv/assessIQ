// Admin users page — list / filter / invite / role-change / soft-delete.
//
// Ported from modules/17-ui-system/AccessIQ_UI_Template/screens/admin-list.jsx
// per the canonical-template rule in docs/10-branding-guideline.md § 0.
// admin-list.jsx is the GENERIC pattern for every admin-side list page;
// admin/packs, admin/assessments, admin/results-list, admin/embed-secrets
// will all port from the same screen.
//
// Translation notes (intentional divergences from screens/admin-list.jsx):
//
// 1. Top bar Logo + tenant + user button match the screen, but the user
//    button is wired to the live logout action (template has no behaviour
//    on it; just shows the email). Phase 1+ should ship a proper admin
//    shell with global navigation; this is a single-page approximation.
//
// 2. Filter chips — template demoes status filters (All / Active /
//    Pending / Disabled). The live page uses ROLE filters (admin,
//    reviewer) plus a "show deleted" toggle, because role is the
//    primary axis users actually filter by, and the soft-delete view
//    is the audit-trail recovery path. Same idiom (chip-strip with
//    accent-when-selected), different filter semantics.
//
// 3. Empty state — keeps the template's serif headline + secondary
//    copy + primary CTA shape, but with admin-users-specific copy.
//
// 4. Invite "drawer" — template uses a fixed-position centred Card
//    with a click-outside backdrop. Live page mirrors that exactly.
//
// 5. Mono pager idiom (prev / "X / Y" / next with ghost buttons +
//    arrow icons) replaces the prior outline-button pager.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card, Chip, Field, Logo } from '@assessiq/ui-system';
import type { ChipVariant } from '@assessiq/ui-system';
import { api, ApiCallError } from '../../lib/api';
import { logout, useSession } from '../../lib/session';

// ── Types ────────────────────────────────────────────────────────────────────

type UserRole = 'admin' | 'reviewer';
type UserStatus = 'active' | 'pending' | 'disabled';

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: UserStatus;
  created_at: string;
  deleted_at?: string | null;
}

interface UsersResponse {
  // GET /api/admin/users returns the @assessiq/users service's PaginatedUsers
  // shape with `items` (matches api-keys list + the rest of the workspace).
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_VARIANT: Record<UserStatus, ChipVariant> = {
  active: 'success',
  pending: 'accent',
  disabled: 'default',
};

const PAGE_SIZE = 20;

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

// ── Invite drawer (fixed-position centred Card, matches screens/admin-list.jsx) ─

function InviteForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('reviewer');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);

  const submit = async (): Promise<void> => {
    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api('/admin/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), role }),
      });
      setToast(true);
      setTimeout(() => {
        setToast(false);
        onSuccess();
      }, 1500);
    } catch (err) {
      if (err instanceof ApiCallError) {
        setError(err.apiError.message);
      } else {
        setError('Unexpected error — please try again.');
      }
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.36)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 100,
      }}
      onClick={onCancel}
      role="presentation"
    >
      <Card
        padding="lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 440 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h2
            className="aiq-serif"
            style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: '-0.015em' }}
          >
            Invite teammate
          </h2>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close">
            ×
          </Button>
        </div>
        <p
          style={{
            fontSize: 13,
            color: 'var(--aiq-color-fg-secondary)',
            margin: '0 0 20px',
            lineHeight: 1.5,
          }}
        >
          They will receive a one-time sign-in link, valid for 72 hours.
        </p>

        {toast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">Invitation sent.</Chip>
          </div>
        )}

        <div style={{ display: 'grid', gap: 16 }}>
          <Field
            label="Email address"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }}
            {...(error ? { error } : {})}
          />
          <div data-help-id="admin.users.role">
            <span style={{ ...META_LABEL, display: 'block', marginBottom: 6 }}>Role</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['admin', 'reviewer'] as UserRole[]).map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={role === r ? 'primary' : 'outline'}
                  onClick={() => setRole(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 24 }}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={submit} loading={loading} disabled={toast} rightIcon="arrow">
            Send invite
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Pager — ghost buttons with arrow icons + mono "X / Y" microcopy ──────────

function Pager({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
      <Button size="sm" variant="ghost" leftIcon="arrowLeft" onClick={onPrev} disabled={page <= 1}>
        Prev
      </Button>
      <span style={META_LABEL}>
        {page} / {totalPages || 1}
      </span>
      <Button size="sm" variant="ghost" rightIcon="arrow" onClick={onNext} disabled={page >= totalPages}>
        Next
      </Button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AdminUsers(): JSX.Element {
  const { session } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  // Debounce search input (300ms)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (value: string): void => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  };

  const fetchUsers = useCallback((): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setFetchError(null);

    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (roleFilter) params.set('role', roleFilter);
    if (showDeleted) params.set('includeDeleted', 'true');

    api<UsersResponse>(`/admin/users?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((data) => {
        setUsers(data.items);
        setTotal(data.total);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (err instanceof ApiCallError) {
          setFetchError(err.apiError.message);
        } else {
          setFetchError('Failed to load users.');
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [page, debouncedSearch, roleFilter, showDeleted]);

  useEffect(() => {
    const cleanup = fetchUsers();
    return cleanup;
  }, [fetchUsers]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const handleLogout = async (): Promise<void> => {
    await logout();
    window.location.href = '/admin/login';
  };

  // Column grid — kept consistent across header + every row.
  const ROW_GRID = '120px 2fr 1fr 110px 110px';
  const ROW_GRID_GAP = 12;
  const ROW_PADDING = '16px 20px';

  return (
    <div
      className="aiq-screen"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      {showInvite && (
        <InviteForm
          onSuccess={() => {
            setShowInvite(false);
            void fetchUsers();
          }}
          onCancel={() => setShowInvite(false)}
        />
      )}

      {/* Top bar — Logo + tenant slug + user button (logout). */}
      <header
        style={{
          padding: '20px 32px',
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid var(--aiq-color-border)',
          background: 'var(--aiq-color-bg-base)',
        }}
      >
        <Logo />
        <span style={{ flex: 1 }} />
        {session?.tenant.slug && (
          <span style={META_LABEL}>{session.tenant.slug}</span>
        )}
        {session?.user.email && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon="user"
            onClick={() => { void handleLogout(); }}
            style={{ marginLeft: 16 }}
            aria-label="Sign out"
          >
            {session.user.email}
          </Button>
        )}
      </header>

      <main
        style={{
          flex: 1,
          padding: '32px 40px',
          maxWidth: 1280,
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        {/* Page header — count chip ABOVE title + description below */}
        <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 28 }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="grid">
                {users.length} of {total}
              </Chip>
            </div>
            <h1
              className="aiq-serif"
              style={{
                fontSize: 36,
                lineHeight: 1.1,
                margin: 0,
                fontWeight: 400,
                letterSpacing: '-0.02em',
              }}
            >
              Users.
            </h1>
            <p
              style={{
                fontSize: 14,
                color: 'var(--aiq-color-fg-secondary)',
                margin: '8px 0 0',
                maxWidth: 520,
                lineHeight: 1.5,
              }}
            >
              Admins manage the tenant. Reviewers grade submissions. Candidates take assessments.
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <Button leftIcon="plus" onClick={() => setShowInvite(true)}>
            Invite user
          </Button>
        </div>

        {/* Filter strip — pill-shaped search + filter chips, bottom-bordered. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            marginBottom: 16,
            paddingBottom: 16,
            borderBottom: '1px solid var(--aiq-color-border)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 320px', maxWidth: 360 }}>
            <Field
              label=""
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>

          {/* Role filter chips */}
          <div style={{ display: 'flex', gap: 6 }}>
            {(['admin', 'reviewer'] as const).map((r) => (
              <span
                key={r}
                onClick={() => { setRoleFilter(roleFilter === r ? null : r); setPage(1); }}
                style={{ cursor: 'pointer' }}
                role="button"
                aria-pressed={roleFilter === r}
              >
                <Chip variant={roleFilter === r ? 'accent' : 'default'}>{r}</Chip>
              </span>
            ))}
            <span
              onClick={() => { setShowDeleted(!showDeleted); setPage(1); }}
              style={{ cursor: 'pointer' }}
              role="button"
              aria-pressed={showDeleted}
            >
              <Chip variant={showDeleted ? 'accent' : 'default'}>
                {showDeleted ? 'showing deleted' : 'show deleted'}
              </Chip>
            </span>
          </div>
        </div>

        {/* Error state */}
        {fetchError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{fetchError}</Chip>
          </div>
        )}

        {/* Rows — grid-layout instead of <table> per template idiom */}
        {loading ? (
          <div
            style={{
              padding: 64,
              textAlign: 'center',
              ...META_LABEL,
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-md)',
              background: 'var(--aiq-color-bg-base)',
            }}
          >
            Loading…
          </div>
        ) : users.length === 0 ? (
          /* Empty state — serif headline + secondary copy + primary CTA */
          <div
            style={{
              padding: 64,
              textAlign: 'center',
              border: '1px dashed var(--aiq-color-border-strong)',
              borderRadius: 'var(--aiq-radius-lg)',
              background: 'var(--aiq-color-bg-elevated)',
            }}
          >
            <h2
              className="aiq-serif"
              style={{ fontSize: 24, margin: 0, fontWeight: 400, letterSpacing: '-0.015em' }}
            >
              Nothing here yet.
            </h2>
            <p
              style={{
                fontSize: 14,
                color: 'var(--aiq-color-fg-secondary)',
                margin: '8px 0 20px',
                maxWidth: 360,
                marginLeft: 'auto',
                marginRight: 'auto',
                lineHeight: 1.5,
              }}
            >
              Invite your first teammate to get started. They will receive an email with a sign-in link.
            </p>
            <Button leftIcon="plus" onClick={() => setShowInvite(true)}>
              Invite user
            </Button>
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-md)',
              overflow: 'hidden',
              background: 'var(--aiq-color-bg-base)',
            }}
          >
            {/* Column heads */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: ROW_GRID,
                gap: ROW_GRID_GAP,
                padding: '12px 20px',
                background: 'var(--aiq-color-bg-elevated)',
                borderBottom: '1px solid var(--aiq-color-border)',
                ...META_LABEL,
                fontSize: 10,
              }}
            >
              <span>ID</span>
              <span>User</span>
              <span>Role</span>
              <span>Status</span>
              <span>Created</span>
            </div>
            {users.map((u, i) => (
              <div
                key={u.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: ROW_GRID,
                  gap: ROW_GRID_GAP,
                  padding: ROW_PADDING,
                  alignItems: 'center',
                  borderTop: i === 0 ? 'none' : '1px solid var(--aiq-color-border)',
                  background: i % 2 === 1 ? 'var(--aiq-color-bg-elevated)' : 'transparent',
                  opacity: u.deleted_at ? 0.5 : 1,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--aiq-font-mono)',
                    fontSize: 12,
                    color: 'var(--aiq-color-fg-muted)',
                  }}
                >
                  #{u.id.slice(0, 8)}
                </span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--aiq-color-fg-primary)' }}>
                    {u.name ?? '—'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--aiq-color-fg-secondary)' }}>
                    {u.email}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: 'var(--aiq-font-mono)',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--aiq-color-fg-secondary)',
                  }}
                >
                  {u.role}
                </span>
                <span>
                  <Chip variant={STATUS_VARIANT[u.status] ?? 'default'}>{u.status}</Chip>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--aiq-font-mono)',
                    fontSize: 11,
                    color: 'var(--aiq-color-fg-muted)',
                  }}
                >
                  {formatDate(u.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Pager */}
        {users.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <Pager
              page={page}
              totalPages={totalPages}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
            />
          </div>
        )}
      </main>
    </div>
  );
}
