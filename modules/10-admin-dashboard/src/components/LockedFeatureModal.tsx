// AssessIQ — LockedFeatureModal (Z-80).
//
// Shared "Contact us" popup. Opens when the API answers 403 TIER_NOT_INCLUDED
// for a feature the plan does not include. The feature stays visible on its page.
//
// INVARIANTS:
//  - Plain text only. No feature flag is read or changed here.
//  - The button opens the public contact page (same site as the marketing pages).

import React from "react";
import { ConfirmDialog } from "@assessiq/ui-system";

export const CONTACT_URL = "https://assessiq.in/contact";

export interface LockedFeatureModalProps {
  open: boolean;
  /** Plain phrase for the feature, for example "webhooks". */
  feature: string;
  onClose: () => void;
}

export function LockedFeatureModal({ open, feature, onClose }: LockedFeatureModalProps): React.ReactElement | null {
  return (
    <ConfirmDialog
      open={open}
      title="Full access needed"
      cancelLabel="Close"
      confirmLabel="Contact us"
      onConfirm={() => {
        window.open(CONTACT_URL, "_blank", "noopener,noreferrer");
        onClose();
      }}
      onCancel={onClose}
      body={
        <div data-help-id="admin.locked.contact">
          Your plan does not include {feature}. Contact AssessIQ to get full access.
        </div>
      }
    />
  );
}

LockedFeatureModal.displayName = "LockedFeatureModal";
