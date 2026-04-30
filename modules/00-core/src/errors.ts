export interface AppErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    status: number,
    opts?: AppErrorOptions
  ) {
    // Pass cause to the native Error constructor (ES2022+) so `error.cause`
    // chains correctly and stack frames include it. We do NOT redeclare
    // `cause` as a class field — it lives on Error and would conflict with
    // `noImplicitOverride`.
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    if (opts?.details !== undefined) {
      this.details = opts.details;
    }
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJson(): { code: string; message: string; details?: Record<string, unknown> } {
    const result: { code: string; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    return result;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super(message, "VALIDATION_FAILED", 400, opts);
    this.name = "ValidationError";
  }
}

export class AuthnError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super(message, "AUTHN_FAILED", 401, opts);
    this.name = "AuthnError";
  }
}

export class AuthzError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super(message, "AUTHZ_FAILED", 403, opts);
    this.name = "AuthzError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super(message, "NOT_FOUND", 404, opts);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super(message, "CONFLICT", 409, opts);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super(message, "RATE_LIMITED", 429, opts);
    this.name = "RateLimitError";
  }
}
