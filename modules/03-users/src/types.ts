export type UserRole = 'admin' | 'reviewer' | 'candidate';
export type UserStatus = 'active' | 'disabled' | 'pending';

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface UserInvitation {
  id: string;
  tenant_id: string;
  email: string;
  role: UserRole;
  token_hash: string;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

export interface PaginatedUsers {
  items: User[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListUsersInput {
  role?: UserRole;
  status?: UserStatus;
  search?: string;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: UserRole;
  metadata?: Record<string, unknown>;
}

export interface UpdateUserPatch {
  name?: string;
  role?: UserRole;
  status?: UserStatus;
  metadata?: Record<string, unknown>;
}

export interface InviteUserInput {
  email: string;
  role: UserRole;
  invited_by: string;           // user id of the admin issuing the invite
  assessmentIds?: string[];     // Phase 1 only — Window 5 throws if non-empty (see § 13)
}

export interface InviteUserResult {
  user: User;
  invitation: { id: string; email: string; role: UserRole; expires_at: Date } | null;
  // null when re-invite hits an existing active user
}

export interface AcceptInvitationResult {
  user: User;
  sessionToken: string;
  expiresAt: string; // ISO 8601
}

export interface ImportReport {
  // Per addendum § 1; type only — implementation throws
  totalRows: number;
  succeeded: number;
  failed: number;
  created: User[];
  updated: User[];
  errors: Array<{
    row: number;
    email: string | null;
    code:
      | 'INVALID_EMAIL'
      | 'INVALID_ROLE'
      | 'USER_EMAIL_EXISTS'
      | 'USER_DISABLED'
      | 'MISSING_REQUIRED'
      | 'NAME_TOO_LONG'
      | 'UNKNOWN_COLUMN'
      | 'TOO_MANY_ROWS';
    message: string;
  }>;
}
