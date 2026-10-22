// RW-61: question editor "Framework nodes" card saves node picks and is read-only for tenant admins.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const put = vi.fn();
let role = "super_admin";

vi.mock("react-router", () => ({
  useParams: () => ({ id: "q1" }),
  useSearchParams: () => [new URLSearchParams()],
  useNavigate: () => vi.fn(),
}));
vi.mock("../api.js", () => ({
  AdminApiError: class AdminApiError extends Error {},
  getSuperQuestionStats: async () => ({ question: {}, stats: null, gradient: [], miscalibrated: { flag: false, reason: null, min_attempts: 30 } }),
  adminApi: vi.fn(async () => ({
    id: "q1", type: "subjective", status: "active", points: 5, content: { question: "Why?" }, rubric: null,
    cognitive_level: "apply", answer_guidance: null,
  })),
}));
vi.mock("../api/frameworks.js", () => ({
  getQuestionTaxonomyApi: async () => ({ node_ids: [], nodes: [] }),
  putQuestionTaxonomyApi: (...a: unknown[]) => put(...a),
  listFrameworksApi: async () => ({ items: [{ id: "f1", slug: "x", name: "Fw", source: "seed", status: "active", tenant_id: null }] }),
  listFrameworkNodesApi: async () => ({ items: [{ id: "n1", parent_id: null, kind: "subject", code: null, label: "Science", position: 0, status: "active" }] }),
}));
vi.mock("../session.js", () => ({ useAdminSession: () => ({ session: { user: { id: "u", role } }, loading: false }) }));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../components/QuestionContentView.js", () => ({ QuestionContentView: () => null }));
vi.mock("../components/RubricEditor.js", () => ({ RubricEditor: () => null }));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { AdminQuestionEditor } from "../pages/question-editor.js";

afterEach(() => { cleanup(); put.mockReset(); role = "super_admin"; });

describe("question editor framework nodes", () => {
  it("super admin ticks a node and it is saved", async () => {
    put.mockResolvedValue({ node_ids: ["n1"] });
    render(<AdminQuestionEditor />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Science/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("q1", ["n1"]));
  });

  it("tenant admin sees the tree read-only", async () => {
    role = "admin";
    render(<AdminQuestionEditor />);
    const box = (await screen.findByRole("checkbox", { name: /Science/ })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });
});
