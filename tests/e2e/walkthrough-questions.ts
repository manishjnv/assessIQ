/**
 * E2E walkthrough — question fixtures used in the 2026-05-15 full-system run.
 *
 * Pack: SOC L1 (id 019e2a27-eea1-7341-b288-4a3bfd1cc40d)
 * Level: L1 SOC Analyst (id 019e2a2a-9399-7468-9dcb-02a12c82f54c)
 * Assessment: e2e-walkthrough-2026-05-15-cohort-1 (id 019e2a2d-18de-7dd5-abd9-19bb5ca1b504)
 * Tenant: e2e-walkthrough-2026-05-15 (id 39049de6-50c1-4a1f-bc4d-a53244c9ed16)
 */

export const E2E_TENANT_ID = "39049de6-50c1-4a1f-bc4d-a53244c9ed16";
export const E2E_ASSESSMENT_ID = "019e2a2d-18de-7dd5-abd9-19bb5ca1b504";
export const E2E_ATTEMPT_ID = "019e2a30-2c19-7abd-bf7a-7a4ae0b58af0";
export const E2E_CERT_CREDENTIAL_ID = "AIQ-2026-05-88GB5C";

// Q1 — MCQ: NIST CSF function that governs continuous monitoring
export const Q1_MCQ = {
  type: "mcq" as const,
  content: {
    prompt: "Which NIST CSF function primarily governs continuous monitoring of security controls?",
    choices: [
      { id: 1, text: "Identify" },
      { id: 2, text: "Detect" },
      { id: 3, text: "Protect" },
      { id: 4, text: "Respond" },
    ],
    correct_choice_id: 2,
  },
  points: 10,
  answer: { selected_choice_id: 2 }, // correct
};

// Q2 — Log analysis: SSH brute force
export const Q2_LOG_ANALYSIS = {
  type: "log_analysis" as const,
  content: {
    prompt: "A Linux auth.log shows 400 'Failed password' entries for root from 198.51.100.42 in 60 seconds, then a 'Accepted publickey' entry from 203.0.113.7. What happened and what is the immediate priority?",
    log_snippet: [
      "May 15 02:30:01 web01 sshd[1234]: Failed password for root from 198.51.100.42 port 51234 ssh2",
      "... (×400, 60 s window)",
      "May 15 02:31:02 web01 sshd[1235]: Accepted publickey for ubuntu from 203.0.113.7 port 55432 ssh2",
    ].join("\n"),
  },
  points: 20,
};

// Q3 — Scenario: Cobalt Strike C2 beacon triage
export const Q3_SCENARIO = {
  type: "scenario" as const,
  points: 60,
};

// Q4 — KQL: brute-force detection
export const Q4_KQL = {
  type: "kql" as const,
  content: {
    prompt: "Write KQL to detect brute-force against Azure AD with ≥10 failures in 5 minutes for the same account, excluding service principals. Flag the NAT false-positive trap.",
    expected_keywords: ["SigninLogs", "ResultType", "summarize", "bin", "where"],
  },
  points: 15,
};

// Q5 — Subjective: process masquerading IR
export const Q5_SUBJECTIVE = {
  type: "subjective" as const,
  points: 50,
};
