// ManageMenu — split from platform.tsx (E9, no behaviour change).

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Button } from "@assessiq/ui-system";
import { type TenantListItem } from "../../api.js";
import { type LifecycleAction } from "./shared.js";

// ── Per-row Manage menu ───────────────────────────────────────────────────────

export function ManageMenu({
  tenant,
  onOpenBilling,
  onEditAdmin,
  onLifecycleAction,
}: {
  tenant: TenantListItem;
  onOpenBilling: () => void;
  onEditAdmin: () => void;
  onLifecycleAction: (action: LifecycleAction) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  // Portal-anchored dropdown — same reason as users.tsx: parent table uses
  // overflow:hidden for rounded corners, which clips an absolutely-positioned
  // dropdown on the last row. Render to document.body via createPortal,
  // anchored via getBoundingClientRect, position:fixed. Closes on outside
  // click or any scroll/resize.
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    if (triggerRef.current === null) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right });

    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onScrollOrResize = (): void => setOpen(false);

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const menuItem = (label: string, onClick: () => void, danger = false): React.ReactElement => (
    <button
      key={label}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        onClick();
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 14px",
        background: "none",
        border: "none",
        cursor: "pointer",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: 13,
        color: danger ? "var(--aiq-color-danger, #dc2626)" : "var(--aiq-color-fg-primary)",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--aiq-color-bg-sunken)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "none"; }}
    >
      {label}
    </button>
  );

  const lifecycleItems: React.ReactElement[] = [];
  if (tenant.status === "active") {
    lifecycleItems.push(menuItem("Suspend organisation", () => onLifecycleAction("suspend"), true));
    lifecycleItems.push(menuItem("Archive organisation", () => onLifecycleAction("archive"), true));
  } else if (tenant.status === "suspended") {
    lifecycleItems.push(menuItem("Resume organisation", () => onLifecycleAction("resume")));
    lifecycleItems.push(menuItem("Archive organisation", () => onLifecycleAction("archive"), true));
  } else if (tenant.status === "archived") {
    lifecycleItems.push(menuItem("Unarchive organisation", () => onLifecycleAction("unarchive")));
  } else if (tenant.status === "provisioning") {
    lifecycleItems.push(
      <div
        key="provisioning"
        style={{
          padding: "7px 14px",
          fontFamily: "var(--aiq-font-sans)",
          fontSize: 12,
          color: "var(--aiq-color-fg-muted)",
        }}
      >
        Provisioning in progress
      </div>,
    );
  }

  return (
    <>
      <div ref={triggerRef} style={{ position: "relative", display: "inline-block" }}>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          Manage ▾
        </Button>
      </div>
      {open && coords !== null &&
        createPortal(
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            top: coords.top,
            right: coords.right,
            background: "var(--aiq-color-bg-base, #ffffff)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 1000,
            minWidth: 180,
            paddingTop: 4,
            paddingBottom: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuItem("Open billing", () => { onOpenBilling(); })}
          {tenant.admin_user_id !== null && menuItem("Edit organisation", () => { onEditAdmin(); })}
          {menuItem("Manage users", () => { navigate(`/admin/platform/${tenant.id}/users`); })}
          {lifecycleItems.length > 0 && (
            <div
              style={{
                height: 1,
                background: "var(--aiq-color-border)",
                margin: "4px 0",
              }}
            />
          )}
          {lifecycleItems}
        </div>,
        document.body,
      )}
    </>
  );
}
