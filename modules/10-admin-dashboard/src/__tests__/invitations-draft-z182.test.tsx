// Z-182: a draft assessment shows no invite controls. Published and active keep them.
// The section only receives isDraft, so one isDraft=false case covers published and active.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

vi.mock("../components/CandidateCsvImport.js", () => ({
  CandidateCsvImport: () => <button type="button">Import from CSV</button>,
}));
vi.mock("../components/EmailQueuePanel.js", () => ({ EmailQueuePanel: () => null }));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { InvitationsSection, type InvitationsSectionProps } from "../pages/assessment-detail/InvitationsSection.js";

const noop = () => {};

function props(isDraft: boolean): InvitationsSectionProps {
  return {
    id: "a1", resultsSort: "name", setResultsSort: noop, showInviteForm: false, setShowInviteForm: noop,
    setInviteError: noop, setSelectedUserIds: noop, fetchData: async () => {}, handleInvite: async () => {},
    uninvitedUsers: [], selectedUserIds: new Set(), toggleUser: noop, inviteError: null, inviteLimit: null,
    inviteErrorPath: null, inviting: false, resendable: 0, resendResult: null, resendError: null,
    setResendError: noop, setShowResendAll: noop, resendingAll: false, resendingId: null, invitations: [],
    invitationColumns: [], sortedInvitations: [], sortBy: "", setSortBy: noop, sortDir: "asc", setSortDir: noop,
    invPage: 1, invPaging: false, invTotal: 0, goToInvPage: async () => {}, isDraft,
  } as unknown as InvitationsSectionProps;
}

function renderSection(isDraft: boolean) {
  return render(<MemoryRouter><InvitationsSection {...props(isDraft)} /></MemoryRouter>);
}

afterEach(() => cleanup());

describe("InvitationsSection on a draft (Z-182)", () => {
  it("shows the publish line and no invite controls or list", () => {
    renderSection(true);
    expect(screen.getByText("Publish this assessment to invite students.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Invite candidates" })).toBeNull();
    expect(screen.queryByText("Import from CSV")).toBeNull();
    expect(screen.queryByText("No candidates invited yet.")).toBeNull();
  });
});

describe("InvitationsSection after publish (Z-182)", () => {
  it("keeps the invite and import controls and hides the publish line", () => {
    renderSection(false);
    expect(screen.getByRole("button", { name: "+ Invite candidates" })).toBeTruthy();
    expect(screen.getByText("Import from CSV")).toBeTruthy();
    expect(screen.getByText("No candidates invited yet.")).toBeTruthy();
    expect(screen.queryByText("Publish this assessment to invite students.")).toBeNull();
  });
});
