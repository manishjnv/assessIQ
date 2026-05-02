// Per-module test setup. Provides a deterministic localStorage shim and
// canvas/matchMedia stubs so jsdom doesn't choke on browser APIs the
// components touch (matchMedia for prefers-reduced-motion, etc.).
//
// The root vitest.setup.ts handles env vars; this file handles the DOM.

import "@testing-library/react";

if (typeof window !== "undefined") {
  // jsdom does not implement matchMedia. Components that read
  // prefers-reduced-motion or other media queries would crash; the
  // shim returns a stable "no match" result.
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  // BroadcastChannel for the multi-tab warning hook. jsdom 25+ ships it
  // but older versions don't — provide a no-op shim that's safe either way.
  if (typeof window.BroadcastChannel !== "function") {
    class StubBroadcastChannel {
      name: string;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(name: string) {
        this.name = name;
      }
      postMessage(_msg: unknown): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean {
        return false;
      }
    }
    Object.defineProperty(window, "BroadcastChannel", {
      writable: true,
      value: StubBroadcastChannel,
    });
  }
}
