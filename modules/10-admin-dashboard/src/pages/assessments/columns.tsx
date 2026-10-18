import React from "react";
import type { NavigateFunction } from "react-router-dom";
import { Chip, formatDate } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { assessmentStatusDisplay } from "../../lib/labels.js";
import { domainLabel } from "../../lib/domains.js";
import { HelpTip } from "@assessiq/help-system/components";
import { type AssessmentListItem, assessmentStatusVariant, rowRemoveMode } from "./shared.js";

export function buildAssessmentColumns({
  navigate,
  onRemove,
}: {
  navigate: NavigateFunction;
  onRemove: (row: AssessmentListItem, mode: "delete" | "cancel") => void;
}): ColumnDef<AssessmentListItem>[] {
  return [
    {
      key: "name",
      label: "Name",
      sortable: true,
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontWeight: 500,
            fontSize: "var(--aiq-text-sm)",
          }}
        >
          {row.name}
        </span>
      ),
    },
    {
      key: "level_label",
      label: "Difficulty",
      sortable: true,
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: row.level_label
              ? "var(--aiq-color-fg-default)"
              : "var(--aiq-color-fg-muted)",
          }}
        >
          {row.level_label ?? "—"}
        </span>
      ),
    },
    {
      key: "domain",
      label: "Subject",
      sortable: true,
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: row.domain
              ? "var(--aiq-color-fg-default)"
              : "var(--aiq-color-fg-muted)",
          }}
        >
          {row.domain ? domainLabel(row.domain) : "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (row: AssessmentListItem) => (
        <Chip variant={assessmentStatusVariant(row.status)}>
          {assessmentStatusDisplay(row.status).label}
        </Chip>
      ),
    },
    {
      // Not sortable: value is a composite { total, … } object the generic
      // client-side comparator can't order meaningfully.
      key: "invitations",
      label: "Invited",
      render: (row: AssessmentListItem) => {
        const inv = row.invitations;
        const total = inv?.total ?? 0;
        if (total === 0) {
          return (
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              —
            </span>
          );
        }
        const nonPending = total - (inv?.pending ?? 0);
        return (
          <span
            style={{
              display: "inline-flex",
              flexDirection: "column",
              gap: "2px",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
            }}
          >
            <span style={{ fontWeight: 600 }}>{total} invited</span>
            <span style={{ color: "var(--aiq-color-fg-muted)" }}>
              {nonPending} sent · {inv?.pending ?? 0} pending
            </span>
          </span>
        );
      },
    },
    {
      key: "opens_at",
      label: "Opens",
      sortable: true,
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.opens_at ? formatDate(row.opens_at) : "—"}
        </span>
      ),
    },
    {
      key: "closes_at",
      label: "Closes",
      sortable: true,
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.closes_at ? formatDate(row.closes_at) : "—"}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      sortable: true,
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {formatDate(row.created_at)}
        </span>
      ),
    },
    {
      key: "action",
      label: "",
      width: 170,
      render: (row: AssessmentListItem) => {
        const mode = rowRemoveMode(row);
        return (
          <span style={{ display: "inline-flex", gap: "var(--aiq-space-xs)" }}>
            <button
              type="button"
              className="aiq-btn aiq-btn-outline aiq-btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/admin/assessments/${row.id}`);
              }}
            >
              Open
            </button>
            {mode !== null && (
              <HelpTip helpId="admin.assessments.row_delete">
                <button
                  type="button"
                  className="aiq-btn aiq-btn-outline aiq-btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(row, mode);
                  }}
                >
                  {mode === "delete" ? "Delete" : "Cancel"}
                </button>
              </HelpTip>
            )}
          </span>
        );
      },
    },
  ];
}
