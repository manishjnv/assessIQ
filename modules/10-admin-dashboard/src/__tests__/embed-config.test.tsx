// FU-B14 — embed config page: signing-secret list, create/rotate/delete, show-once, snippet.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({ adminApi: (...a: unknown[]) => adminApi(...a) }));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

import EmbedConfigPage from "../pages/embed-config.js";

const row = (id: string, status: string) => ({ id, name: `n-${id}`, status, createdAt: "2026-10-01T00:00:00Z", rotatedAt: null });
let items = [row("s1", "active"), row("s2", "revoked")];

beforeEach(() => {
  items = [row("s1", "active"), row("s2", "revoked")];
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/admin/embed-origins" && !init) return { origins: [] };
    if (path === "/admin/embed-secrets" && !init) return { items };
    if (path === "/admin/embed-secrets" && init?.method === "POST") return { id: "s3", plaintextSecret: "PLAIN-NEW" };
    if (path === "/admin/embed-secrets/s1/rotate") return { id: "s4", plaintextSecret: "PLAIN-ROT" };
    if (path === "/admin/embed-secrets/s1" && init?.method === "DELETE") return undefined;
    throw new Error(`unexpected adminApi call: ${path}`);
  });
});
afterEach(() => { cleanup(); adminApi.mockReset(); });

describe("EmbedConfigPage secrets", () => {
  it("lists secrets; revoked rows have no actions", async () => {
    render(<EmbedConfigPage />);
    await waitFor(() => expect(screen.getByText("n-s1")).toBeTruthy());
    expect(screen.getAllByText("Rotate")).toHaveLength(1);
    expect(screen.getAllByText("Delete")).toHaveLength(1);
    expect(document.querySelector('[data-help-id="admin.embed.secrets_list"]')).toBeTruthy();
    expect(document.querySelector('[data-help-id="admin.embed.snippet"]')).toBeTruthy();
  });

  it("rotate shows the new secret once with the store-now notice", async () => {
    render(<EmbedConfigPage />);
    await waitFor(() => screen.getByText("n-s1"));
    fireEvent.click(screen.getByText("Rotate"));
    await waitFor(() => expect(screen.getByText("PLAIN-ROT")).toBeTruthy());
    expect(screen.getByText("Store it now. It is not shown again.")).toBeTruthy();
    expect(document.querySelector('[data-help-id="admin.embed.secret_once"]')).toBeTruthy();
    fireEvent.click(screen.getByText("I stored it"));
    expect(screen.queryByText("PLAIN-ROT")).toBeNull();
  });

  it("create posts the name and shows the secret", async () => {
    render(<EmbedConfigPage />);
    await waitFor(() => screen.getByText("n-s1"));
    fireEvent.change(screen.getByLabelText("New secret name"), { target: { value: "prod" } });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(screen.getByText("PLAIN-NEW")).toBeTruthy());
    expect(adminApi).toHaveBeenCalledWith("/admin/embed-secrets", { method: "POST", body: JSON.stringify({ name: "prod" }) });
  });

  it("delete asks to confirm, then calls DELETE", async () => {
    render(<EmbedConfigPage />);
    await waitFor(() => screen.getByText("n-s1"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(await screen.findByText("Delete secret"));
    await waitFor(() => expect(adminApi).toHaveBeenCalledWith("/admin/embed-secrets/s1", { method: "DELETE" }));
  });

  it("snippet card shows the sdk script tag", async () => {
    render(<EmbedConfigPage />);
    await waitFor(() => screen.getByText("n-s1"));
    expect(screen.getByText(/\/embed\/sdk\.js/)).toBeTruthy();
    expect(screen.getByText(/Mint tokens on your server/)).toBeTruthy();
  });
});
