// AssessIQ — webhooks admin page (FU-B7): list, replay failed delivery, secret once, event checkboxes.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({ adminApi: (...a: unknown[]) => adminApi(...a) }));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

import WebhooksPage from "../pages/webhooks.js";

const EP = { id: "ep-1", name: "Main", url: "https://example.com/hook", events: ["attempt.graded"], status: "active" };
const dl = (id: string, status: string) => ({
  id, endpoint_id: "ep-1", event: "attempt.graded", status, http_status: status === "failed" ? 500 : 200,
  attempts: 1, last_error: null, created_at: "2026-10-01T00:00:00.000Z", payload: { attemptId: `att-${id}` },
});

let created = false;
function mockApi(): void {
  created = false;
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/admin/webhooks" && !init?.method) return { items: created ? [EP, { ...EP, id: "ep-2" }] : [EP] };
    if (path === "/admin/webhooks/deliveries") return { items: [dl("d-ok", "delivered"), dl("d-bad", "failed"), dl("d-wait", "pending")] };
    if (path === "/admin/webhooks/deliveries/d-bad/replay") return { deliveryId: "d-new" };
    if (path === "/admin/webhooks" && init?.method === "POST") { created = true; return { endpoint: { ...EP, id: "ep-2" }, secret: "whsec_abc" }; }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
}
const calls = (path: string, method: string) =>
  adminApi.mock.calls.filter((c) => c[0] === path && (c[1] as RequestInit | undefined)?.method === method);

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("WebhooksPage", () => {
  it("renders endpoints and deliveries", async () => {
    mockApi();
    render(<WebhooksPage />);
    expect(await screen.findByText("https://example.com/hook")).toBeTruthy();
    expect(await screen.findByText("Success")).toBeTruthy();
  });

  it("offers Replay only on failed rows, POSTs, then reloads", async () => {
    mockApi();
    render(<WebhooksPage />);
    const btn = await screen.findByRole("button", { name: "Replay" });
    expect(screen.getAllByRole("button", { name: "Replay" })).toHaveLength(1);
    const before = adminApi.mock.calls.filter((c) => c[0] === "/admin/webhooks/deliveries").length;
    fireEvent.click(btn);
    await screen.findByText("Delivery queued again.");
    expect(calls("/admin/webhooks/deliveries/d-bad/replay", "POST")).toHaveLength(1);
    expect(adminApi.mock.calls.filter((c) => c[0] === "/admin/webhooks/deliveries").length).toBe(before + 1);
  });

  it("filters deliveries by status", async () => {
    mockApi();
    render(<WebhooksPage />);
    await screen.findByText("Success");
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.queryByText("Success")).toBeNull();
    expect(screen.getByRole("button", { name: "Replay" })).toBeTruthy();
  });

  it("builds events from checkboxes and shows the secret once with a copy button", async () => {
    mockApi();
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add endpoint" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "N" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://x.example/h" } });
    fireEvent.click(screen.getByLabelText("result.released"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls("/admin/webhooks", "POST")).toHaveLength(1));
    const body = JSON.parse((calls("/admin/webhooks", "POST")[0]![1] as RequestInit).body as string);
    expect(body.events).toEqual(["attempt.graded", "result.released"]);
    expect(await screen.findByText("whsec_abc")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy secret" })).toBeTruthy();
    expect(screen.getByText("Store it now. It is not shown again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("whsec_abc")).toBeNull();
  });
});
