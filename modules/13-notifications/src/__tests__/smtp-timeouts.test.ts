import { describe, it, expect } from "vitest";
import { withSmtpTimeouts } from "../email/transport.js";

describe("withSmtpTimeouts", () => {
  it("adds fail-fast SMTP timeouts and keeps a value the operator already set", () => {
    expect(withSmtpTimeouts("smtps://u:p@h:465")).toBe(
      "smtps://u:p@h:465?connectionTimeout=10000&greetingTimeout=10000&socketTimeout=30000",
    );
    expect(withSmtpTimeouts("smtp://h:587?socketTimeout=5000")).toBe(
      "smtp://h:587?socketTimeout=5000&connectionTimeout=10000&greetingTimeout=10000",
    );
  });
});
