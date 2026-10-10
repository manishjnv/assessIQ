import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiCallError } from "@assessiq/http-client";
import { useApi } from "../hooks/useApi.js";

function okRes(body: unknown): Response {
  return { ok: true, status: 200, statusText: "", json: async () => body } as unknown as Response;
}

/** fetch that rejects with AbortError when its signal aborts. */
function pendingFetch() {
  const signals: AbortSignal[] = [];
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    const sig = init?.signal as AbortSignal;
    signals.push(sig);
    return new Promise<Response>((_res, rej) => {
      sig.addEventListener("abort", () =>
        rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, signals };
}

afterEach(() => vi.unstubAllGlobals());

describe("useApi", () => {
  it("loads data on mount", async () => {
    const fn = vi.fn(async () => okRes({ a: 1 }));
    vi.stubGlobal("fetch", fn);
    const { result } = renderHook(() => useApi<{ a: number }>("/x"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ a: 1 });
    expect(result.current.error).toBeNull();
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe("/api/x");
  });

  it("maps errors to ApiCallError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ error: { code: "UNAUTHENTICATED", message: "no" } }),
      })),
    );
    const { result } = renderHook(() => useApi("/x"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBeInstanceOf(ApiCallError);
    expect((result.current.error as ApiCallError).status).toBe(401);
    expect(result.current.loading).toBe(false);
  });

  it("aborts on unmount without surfacing an error", async () => {
    const { signals } = pendingFetch();
    const { result, unmount } = renderHook(() => useApi("/x"));
    await waitFor(() => expect(signals.length).toBe(1));
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {});
    expect(result.current.error).toBeNull();
  });

  it("does not show the previous path response under a new path", async () => {
    const fn = vi.fn(async (url: string) => okRes(url === "/api/a" ? { from: "a" } : { from: "b" }));
    vi.stubGlobal("fetch", fn);
    const { result, rerender } = renderHook(({ p }) => useApi<{ from: string }>(p), { initialProps: { p: "/a" } });
    await waitFor(() => expect(result.current.data).toEqual({ from: "a" }));
    rerender({ p: "/b" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual({ from: "b" }));
  });

  it("aborts the previous request when the path changes", async () => {
    const { signals, fn } = pendingFetch();
    const { result, rerender } = renderHook(({ p }) => useApi(p), { initialProps: { p: "/a" } });
    await waitFor(() => expect(signals.length).toBe(1));
    rerender({ p: "/b" });
    await waitFor(() => expect(signals.length).toBe(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect((fn.mock.calls[1] as unknown as [string])[0]).toBe("/api/b");
    expect(result.current.error).toBeNull();
  });

  it("refetch aborts the previous request and re-requests", async () => {
    const { signals } = pendingFetch();
    const { result } = renderHook(() => useApi("/x"));
    await waitFor(() => expect(signals.length).toBe(1));
    act(() => result.current.refetch());
    await waitFor(() => expect(signals.length).toBe(2));
    expect(signals[0]?.aborted).toBe(true);
  });

  it("makes no request when enabled=false or path=null", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const a = renderHook(() => useApi("/x", { enabled: false }));
    const b = renderHook(() => useApi(null));
    await act(async () => {});
    expect(fn).not.toHaveBeenCalled();
    expect(a.result.current.loading).toBe(false);
    expect(b.result.current.loading).toBe(false);
  });

  it("honours the base override", async () => {
    const fn = vi.fn(async () => okRes({}));
    vi.stubGlobal("fetch", fn);
    renderHook(() => useApi("/take/x", { base: "" }));
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe("/take/x");
  });
});
