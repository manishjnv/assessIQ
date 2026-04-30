import { describe, it, expect } from "vitest";
import {
  withRequestContext,
  getRequestContext,
  getRequestContextOrThrow,
  type RequestContext,
} from "../request-context.js";

/** Yields to the event loop so async_hooks stores propagate correctly. */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const BASE_CTX: RequestContext = {
  requestId: "test-req-1",
  tenantId: "tenant-a",
  userId: "user-1",
  roles: ["admin"],
  ip: "127.0.0.1",
  ua: "vitest",
};

describe("request-context (AsyncLocalStorage)", () => {
  it("returns undefined outside withRequestContext", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("returns the context inside withRequestContext (async)", async () => {
    let captured: RequestContext | undefined;
    await withRequestContext(BASE_CTX, async () => {
      await tick();
      captured = getRequestContext();
    });
    expect(captured).toEqual(BASE_CTX);
    expect(captured?.requestId).toBe("test-req-1");
  });

  it("returns the context inside withRequestContext (sync)", () => {
    let captured: RequestContext | undefined;
    withRequestContext(BASE_CTX, () => {
      captured = getRequestContext();
    });
    expect(captured?.requestId).toBe("test-req-1");
  });

  it("getRequestContextOrThrow throws outside a context", () => {
    expect(() => getRequestContextOrThrow()).toThrow();
  });

  it("getRequestContextOrThrow returns context inside scope", async () => {
    let captured: RequestContext | undefined;
    await withRequestContext(BASE_CTX, async () => {
      captured = getRequestContextOrThrow();
    });
    expect(captured?.requestId).toBe("test-req-1");
  });

  it("context is not visible after the scope exits", async () => {
    await withRequestContext(BASE_CTX, async () => {
      await tick();
    });
    expect(getRequestContext()).toBeUndefined();
  });

  it("isolation: concurrent contexts do not bleed into each other", async () => {
    const ctxA: RequestContext = { requestId: "A" };
    const ctxB: RequestContext = { requestId: "B" };

    const [idA, idB] = await Promise.all([
      withRequestContext(ctxA, async () => {
        await tick();
        return getRequestContext()?.requestId;
      }),
      withRequestContext(ctxB, async () => {
        await tick();
        return getRequestContext()?.requestId;
      }),
    ]);

    expect(idA).toBe("A");
    expect(idB).toBe("B");
  });

  it("nested contexts shadow the outer context correctly", async () => {
    const outer: RequestContext = { requestId: "outer" };
    const inner: RequestContext = { requestId: "inner" };

    let outerSeen: string | undefined;
    let innerSeen: string | undefined;
    let afterInnerSeen: string | undefined;

    await withRequestContext(outer, async () => {
      outerSeen = getRequestContext()?.requestId;
      await withRequestContext(inner, async () => {
        innerSeen = getRequestContext()?.requestId;
      });
      afterInnerSeen = getRequestContext()?.requestId;
    });

    expect(outerSeen).toBe("outer");
    expect(innerSeen).toBe("inner");
    expect(afterInnerSeen).toBe("outer");
  });

  it("sync withRequestContext returns the fn return value", () => {
    const result = withRequestContext(BASE_CTX, () => 42);
    // withRequestContext may return a value or a Promise wrapping the value
    expect(result).toBe(42);
  });
});
