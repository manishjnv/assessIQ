// Camera feature: platform tenants page "School" switch -> POST /api/admin/platform/tenants/:tenantId/school.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { TenantListItem } from "../api.js";

const setTenantSchoolApi = vi.hoisted(() => vi.fn());
vi.mock("../api/camera.js", () => ({ setTenantSchoolApi }));
vi.mock("../components/mfa-step-up.js", () => ({ MfaStepUp: () => null }));

import { SchoolSwitch } from "../pages/platform/SchoolSwitch.js";

const tenant = { id: "t-1", name: "Acme School", slug: "acme" } as unknown as TenantListItem;

beforeEach(() => setTenantSchoolApi.mockReset());
afterEach(cleanup);

describe("SchoolSwitch", () => {
  it("calls the school route with the new value when toggled on", async () => {
    setTenantSchoolApi.mockResolvedValue({ ok: true, isSchool: true });
    const onChanged = vi.fn();
    render(<SchoolSwitch tenant={tenant} onChanged={onChanged} />);
    const sw = screen.getByRole("switch", { name: "School for Acme School" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(setTenantSchoolApi).toHaveBeenCalledWith("t-1", true));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("Acme School: school on"));
  });

  it("shows the school state when the list reports it", () => {
    render(<SchoolSwitch tenant={{ ...tenant, is_school: true } as TenantListItem} onChanged={vi.fn()} />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("School")).toBeTruthy();
  });

  it("carries the help id for the school switch", () => {
    const { container } = render(<SchoolSwitch tenant={tenant} onChanged={vi.fn()} />);
    expect(container.querySelector('[data-help-id="admin.platform.tenants.school"]')).not.toBeNull();
  });
});
