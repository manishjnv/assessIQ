import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiRawRequest } from "./index";

afterEach(() => vi.unstubAllGlobals());

describe("createApiRawRequest", () => {
  it("returns a 503 Response as data instead of throwing", async () => {
    const body = { checks: { db: true, redis: false } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 503, headers: { "Content-Type": "application/json" } })),
    );
    const res = await createApiRawRequest("/api")("/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(body);
  });

  it("sends credentials and the base override", async () => {
    const fn = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    await createApiRawRequest("/api")("/ready", { base: "" });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/ready");
    expect(init.credentials).toBe("include");
  });
});
