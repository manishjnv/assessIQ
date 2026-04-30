import { forwardRef, useId } from "react";
import type {
  FC,
  CSSProperties,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  HTMLAttributes,
} from "react";

// ── Input ────────────────────────────────────────────────────────────────────

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  "data-test-id"?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, ...rest }, ref) {
    const composedClassName = ["aiq-input", className].filter(Boolean).join(" ");
    return <input ref={ref} className={composedClassName} {...rest} />;
  },
);

Input.displayName = "Input";

// ── Label ────────────────────────────────────────────────────────────────────

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  "data-test-id"?: string;
}

const LABEL_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--aiq-color-fg-primary)",
  display: "block",
  marginBottom: 6,
};

export const Label: FC<LabelProps> = function Label({ className, style, ...rest }) {
  return (
    <label
      className={className}
      style={{ ...LABEL_BASE_STYLE, ...style }}
      {...rest}
    />
  );
};

// ── FieldHelp ────────────────────────────────────────────────────────────────

export interface FieldHelpProps extends HTMLAttributes<HTMLParagraphElement> {
  variant?: "help" | "error";
}

const FIELD_HELP_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 12,
  margin: 0,
  marginTop: 6,
};

export const FieldHelp: FC<FieldHelpProps> = function FieldHelp({
  variant = "help",
  style,
  ...rest
}) {
  const color =
    variant === "error"
      ? "var(--aiq-color-danger)"
      : "var(--aiq-color-fg-muted)";

  return (
    <p
      style={{ ...FIELD_HELP_BASE_STYLE, color, ...style }}
      role={variant === "error" ? "alert" : undefined}
      {...rest}
    />
  );
};

// ── Field ────────────────────────────────────────────────────────────────────

export interface FieldProps extends Omit<InputProps, "id"> {
  label: string;
  help?: string;
  error?: string;
  id?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(
  function Field({ label, help, error, id, className, ...rest }, ref) {
    const autoId = useId();
    const inputId = id ?? autoId;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;

    const ariaDescribedBy = error ? errorId : help ? helpId : undefined;

    return (
      <div className="aiq-field" style={{ display: "block" }}>
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={ariaDescribedBy}
          className={className}
          {...rest}
        />
        {error ? (
          <FieldHelp id={errorId} variant="error">
            {error}
          </FieldHelp>
        ) : help ? (
          <FieldHelp id={helpId}>{help}</FieldHelp>
        ) : null}
      </div>
    );
  },
);

Field.displayName = "Field";
