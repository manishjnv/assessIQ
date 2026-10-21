/** Boolean flow for the camera line: real + resolver true -> true; mock -> false; no resolver -> false. No DB. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent = vi.hoisted(() => ({ invite: vi.fn(async () => undefined), reminder: vi.fn(async () => undefined) }));
vi.mock("@assessiq/notifications", () => ({
  sendAssessmentInvitationEmail: sent.invite,
  sendInvitationReminderEmail: sent.reminder,
}));
import { sendInvitationEmail, sendReminderEmail, setCameraRequiredResolver } from "../email.js";

const inv = { to: "a@x.test", candidateName: "A", assessmentName: "T", invitationLink: "https://x.test/take/t", expiresAt: new Date(), tenantName: "O", tenantId: "t1" };
const rem = { to: "a@x.test", candidateName: "A", assessmentName: "T", invitationLink: "https://x.test/take/t", deadline: new Date(), tenantName: "O", tenantId: "t1" };
const flag = (m: ReturnType<typeof vi.fn>) => (m.mock.calls.at(-1) as unknown as [{ cameraRequired: boolean }])[0].cameraRequired;

beforeEach(() => { vi.clearAllMocks(); setCameraRequiredResolver(undefined); });

describe("camera flag passed to the sender", () => {
  it("real + resolver true -> true (invite and reminder), and the resolver gets tenant and mode", async () => {
    const fn = vi.fn(async () => true);
    setCameraRequiredResolver(fn);
    await sendInvitationEmail({ ...inv, deliveryMode: "real" });
    await sendReminderEmail({ ...rem, deliveryMode: "real" });
    expect(flag(sent.invite)).toBe(true);
    expect(flag(sent.reminder)).toBe(true);
    expect(fn).toHaveBeenCalledWith("t1", "real");
  });
  it("mock -> false and the resolver is not asked", async () => {
    const fn = vi.fn(async () => true);
    setCameraRequiredResolver(fn);
    await sendInvitationEmail({ ...inv, deliveryMode: "mock" });
    await sendReminderEmail({ ...rem, deliveryMode: "mock" });
    expect(flag(sent.invite)).toBe(false);
    expect(flag(sent.reminder)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  it("a value already resolved by the caller (bulk invite, once per batch) is used and the resolver is not asked again", async () => {
    const fn = vi.fn(async () => false);
    setCameraRequiredResolver(fn);
    await sendInvitationEmail({ ...inv, deliveryMode: "real", cameraRequired: true });
    expect(flag(sent.invite)).toBe(true);
    await sendInvitationEmail({ ...inv, deliveryMode: "real", cameraRequired: false });
    expect(flag(sent.invite)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  it("resolver missing, resolver error or mode missing -> false", async () => {
    await sendInvitationEmail({ ...inv, deliveryMode: "real" });
    expect(flag(sent.invite)).toBe(false);
    setCameraRequiredResolver(async () => { throw new Error("db down"); });
    await sendReminderEmail({ ...rem, deliveryMode: "real" });
    expect(flag(sent.reminder)).toBe(false);
    setCameraRequiredResolver(async () => true);
    await sendInvitationEmail(inv);
    expect(flag(sent.invite)).toBe(false);
  });
});
