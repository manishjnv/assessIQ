import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, Field, Label } from '@assessiq/ui-system';
import type { ChipVariant } from '@assessiq/ui-system';
import { api, ApiCallError } from '../../lib/api';

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
  users: AdminUser[];
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

// ── Pager ────────────────────────────────────────────────────────────────────

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Button size="sm" variant="outline" onClick={onPrev} disabled={page <= 1}>
        Prev
      </Button>
      <span
        style={{
          fontFamily: 'var(--aiq-font-mono)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--aiq-color-fg-secondary)',
        }}
      >
        {page} / {totalPages || 1}
      </span>
      <Button size="sm" variant="outline" onClick={onNext} disabled={page >= totalPages}>
        Next
      </Button>
    </div>
  );
}

// ── Invite form (inline Card overlay) ────────────────────────────────────────

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
      }, 3000);
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
    <Card
      padding="lg"
      style={{
        position: 'fixed',
        inset: 0,
        margin: 'auto',
        width: '100%',
        maxWidth: 440,
        height: 'fit-content',
        zIndex: 100,
      }}
    >
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: -1,
        }}
        onClick={onCancel}
      />
      <h2 className="aiq-serif" style={{ fontSize: 24, margin: '0 0 20px' }}>
        Invite user
      </h2>

      {toast && (
        <div style={{ marginBottom: 16 }}>
          <Chip variant="success">Invitation sent successfully.</Chip>
        </div>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        <Field
          label="Email address"
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setError(null); }}
          {...(error ? { error } : {})}
        />
        <div>
          <Label>Role</Label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
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
          <p
            style={{
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--aiq-color-fg-muted)',
              marginTop: 6,
            }}
          >
            Candidate invitations are managed per-assessment (addendum §13)
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
        <Button onClick={submit} loading={loading} disabled={toast}>
          Send invitation
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const META_LABEL: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--aiq-color-fg-secondary)',
};

export function AdminUsers(): JSX.Element {
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
        setUsers(data.users);
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

  return (
    <div className="aiq-screen" style={{ minHeight: '100vh', padding: '40px 48px' }}>
      {showInvite && (
        <InviteForm
          onSuccess={() => {
            setShowInvite(false);
            void fetchUsers();
          }}
          onCancel={() => setShowInvite(false)}
        />
      )}

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 32,
        }}
      >
        <div>
          <h1 className="aiq-serif" style={{ fontSize: 36, margin: 0 }}>
            Users
          </h1>
          <p style={{ ...META_LABEL, marginTop: 4 }}>
            {total} total · page {page} of {totalPages || 1}
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <Button leftIcon="plus" onClick={() => setShowInvite(true)}>
          Invite user
        </Button>
      </div>

      {/* Filters */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 240px', maxWidth: 360 }}>
          <Field
            label=""
            placeholder="Search by email or name…"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>

        {/* Role filter chips */}
        <div style={{ display: 'flex', gap: 8 }}>
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
        </div>

        {/* Show deleted toggle */}
        <span
          onClick={() => { setShowDeleted(!showDeleted); setPage(1); }}
          style={{ cursor: 'pointer' }}
          role="button"
          aria-pressed={showDeleted}
        >
          <Chip variant={showDeleted ? 'accent' : 'default'}>
            {showDeleted ? 'hiding deleted' : 'show deleted'}
          </Chip>
        </span>
      </div>

      {/* Error state */}
      {fetchError && (
        <div style={{ marginBottom: 16 }}>
          <Chip>{fetchError}</Chip>
        </div>
      )}

      {/* Table */}
      <Card padding="none" style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--aiq-color-border)',
              }}
            >
              {(['Email', 'Name', 'Role', 'Status', 'Created'] as const).map((h) => (
                <th
                  key={h}
                  style={{
                    ...META_LABEL,
                    padding: '12px 16px',
                    textAlign: 'left',
                    fontWeight: 500,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    padding: '32px 16px',
                    textAlign: 'center',
                    color: 'var(--aiq-color-fg-muted)',
                    fontFamily: 'var(--aiq-font-mono)',
                    fontSize: 12,
                  }}
                >
                  Loading…
                </td>
              </tr>
            )}
            {!loading && users.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    padding: '32px 16px',
                    textAlign: 'center',
                    color: 'var(--aiq-color-fg-muted)',
                    fontFamily: 'var(--aiq-font-mono)',
                    fontSize: 12,
                  }}
                >
                  No users found.
                </td>
              </tr>
            )}
            {!loading &&
              users.map((u) => (
                <tr
                  key={u.id}
                  style={{
                    borderBottom: '1px solid var(--aiq-color-border)',
                    opacity: u.deleted_at ? 0.5 : 1,
                  }}
                >
                  <td style={{ padding: '12px 16px', fontWeight: 500 }}>{u.email}</td>
                  <td style={{ padding: '12px 16px', color: 'var(--aiq-color-fg-secondary)' }}>
                    {u.name ?? '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span
                      style={{
                        fontFamily: 'var(--aiq-font-mono)',
                        fontSize: 11,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <Chip variant={STATUS_VARIANT[u.status] ?? 'default'}>{u.status}</Chip>
                  </td>
                  <td
                    style={{
                      padding: '12px 16px',
                      fontFamily: 'var(--aiq-font-mono)',
                      fontSize: 11,
                      color: 'var(--aiq-color-fg-muted)',
                    }}
                  >
                    {formatDate(u.created_at)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <Pager
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
        />
      </div>
    </div>
  );
}
