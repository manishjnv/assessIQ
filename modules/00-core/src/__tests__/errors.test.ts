import { describe, it, expect } from "vitest";
import {
  AppError,
  ValidationError,
  AuthnError,
  AuthzError,
  NotFoundError,
  ConflictError,
  RateLimitError,
} from "../errors.js";

describe("AppError hierarchy", () => {
  const subclasses = [
    {
      Class: ValidationError,
      name: "ValidationError",
      code: "VALIDATION_FAILED",
      status: 400,
    },
    {
      Class: AuthnError,
      name: "AuthnError",
      code: "AUTHN_FAILED",
      status: 401,
    },
    {
      Class: AuthzError,
      name: "AuthzError",
      code: "AUTHZ_FAILED",
      status: 403,
    },
    {
      Class: NotFoundError,
      name: "NotFoundError",
      code: "NOT_FOUND",
      status: 404,
    },
    {
      Class: ConflictError,
      name: "ConflictError",
      code: "CONFLICT",
      status: 409,
    },
    {
      Class: RateLimitError,
      name: "RateLimitError",
      code: "RATE_LIMITED",
      status: 429,
    },
  ] as const;

  for (const { Class, name, code, status } of subclasses) {
    describe(name, () => {
      it("has the correct name", () => {
        const err = new Class("test message");
        expect(err.name).toBe(name);
      });

      it("has the correct code", () => {
        const err = new Class("test message");
        expect(err.code).toBe(code);
      });

      it("has the correct HTTP status", () => {
        const err = new Class("test message");
        expect(err.status).toBe(status);
      });

      it("is instanceof AppError", () => {
        const err = new Class("test message");
        expect(err).toBeInstanceOf(AppError);
      });

      it("is instanceof Error", () => {
        const err = new Class("test message");
        expect(err).toBeInstanceOf(Error);
      });

      it("is instanceof its own class", () => {
        const err = new Class("test message");
        expect(err).toBeInstanceOf(Class);
      });

      it("preserves the message", () => {
        const err = new Class("specific message");
        expect(err.message).toBe("specific message");
      });
    });
  }

  describe("toJson()", () => {
    it("returns code and message", () => {
      const err = new ValidationError("invalid input");
      const json = err.toJson();
      expect(json.code).toBe("VALIDATION_FAILED");
      expect(json.message).toBe("invalid input");
    });

    it("includes details when provided", () => {
      const err = new ValidationError("invalid input", {
        details: { field: "email", reason: "too short" },
      });
      const json = err.toJson();
      expect(json.details).toEqual({ field: "email", reason: "too short" });
    });

    it("omits details when not provided", () => {
      const err = new ValidationError("invalid input");
      const json = err.toJson();
      expect(Object.prototype.hasOwnProperty.call(json, "details")).toBe(false);
    });

    it("does NOT leak cause in toJson()", () => {
      const cause = new Error("internal db error with sensitive info");
      const err = new NotFoundError("resource not found", { cause });
      const json = err.toJson();
      expect(Object.prototype.hasOwnProperty.call(json, "cause")).toBe(false);
    });

    it("preserves cause on the instance for logging", () => {
      const cause = new Error("upstream failure");
      const err = new AuthnError("authentication failed", { cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe("details round-trip", () => {
    it("preserves complex details objects", () => {
      const details = {
        field: "username",
        constraints: ["min_length", "no_spaces"],
        received: 3,
      };
      const err = new ValidationError("validation failed", { details });
      expect(err.details).toEqual(details);
      expect(err.toJson().details).toEqual(details);
    });
  });

  describe("AppError directly", () => {
    it("can be constructed with a custom code and status", () => {
      const err = new AppError("something", "CUSTOM_CODE", 503);
      expect(err.code).toBe("CUSTOM_CODE");
      expect(err.status).toBe(503);
      expect(err.name).toBe("AppError");
    });
  });
});
