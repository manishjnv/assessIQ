// Fresh-MFA guard for admin actions (override, manual score, accept, release,
// send back).
//
// A fresh-MFA failure opens the shared MfaStepUp in place and re-runs the action
// once the code verifies, so the admin keeps their place. (/admin/mfa ignores
// ?return= and always lands on /admin, so a redirect would lose the page — same
// reasoning as the tenant-settings result-release save.) It sits in a Modal so
// it is visible however far down a long review page the action was started.

import React, { useCallback, useState } from "react";
import { Modal } from "@assessiq/ui-system";
import { MfaStepUp } from "./mfa-step-up.js";
import { apiMessage, isMfaError } from "../lib/evaluation.js";

export interface MfaGuard {
  /** Runs `action`; a fresh-MFA failure opens the step-up and retries, anything else goes to `onError`. */
  guard: (action: () => Promise<void>, onError: (message: string) => void) => Promise<void>;
  /** Render this anywhere in the page (null when idle). */
  stepUp: React.ReactNode;
}

export function useMfaGuard(prompt: string): MfaGuard {
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);

  const guard = useCallback(
    async (action: () => Promise<void>, onError: (message: string) => void): Promise<void> => {
      try {
        await action();
      } catch (err) {
        if (isMfaError(err)) {
          // Functional form: a bare function would be treated as an updater.
          setRetry(() => () => guard(action, onError));
        } else {
          onError(apiMessage(err, "Something went wrong. Try again."));
        }
      }
    },
    [],
  );

  const stepUp = retry ? (
    <Modal open onClose={() => setRetry(null)} title="Verify it's you" width={480} data-test-id="mfa-step-up">
      <MfaStepUp
        prompt={prompt}
        confirmLabel="Verify & continue"
        onVerified={() => {
          const run = retry;
          setRetry(null);
          void run();
        }}
        onCancel={() => setRetry(null)}
      />
    </Modal>
  ) : null;

  return { guard, stepUp };
}
