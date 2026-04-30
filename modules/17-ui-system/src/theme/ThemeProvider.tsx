import type React from "react";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export interface TenantBranding {
  primary?: string;       // OKLCH or hex; sets --aiq-color-accent
  primarySoft?: string;   // optional; sets --aiq-color-accent-soft
  primaryHover?: string;  // optional; sets --aiq-color-accent-hover
  productName?: string;   // wordmark override (Phase 1+; currently unused)
}

export type ThemeMode = "light" | "dark" | "system";
export type DensityMode = "compact" | "cozy" | "comfortable";

export interface ThemeProviderProps {
  children: ReactNode;
  branding?: TenantBranding;
  theme?: ThemeMode;       // default "system" — respects prefers-color-scheme + listens for changes
  density?: DensityMode;   // default "cozy"
  className?: string;
  "data-test-id"?: string;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({
  children,
  branding,
  theme,
  density = "cozy",
  className,
  "data-test-id": dataTestId,
}) => {
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const resolvedTheme =
    theme === "system" || theme === undefined
      ? systemPrefersDark
        ? "dark"
        : "light"
      : theme;

  const brandingStyle: CSSProperties = {
    ...(branding?.primary !== undefined
      ? { ["--aiq-color-accent" as never]: branding.primary }
      : {}),
    ...(branding?.primarySoft !== undefined
      ? { ["--aiq-color-accent-soft" as never]: branding.primarySoft }
      : {}),
    ...(branding?.primaryHover !== undefined
      ? { ["--aiq-color-accent-hover" as never]: branding.primaryHover }
      : {}),
  };

  return (
    <div
      data-theme={resolvedTheme}
      data-density={density}
      className={className}
      style={brandingStyle}
      {...(dataTestId !== undefined ? { "data-test-id": dataTestId } : {})}
    >
      {children}
    </div>
  );
};

ThemeProvider.displayName = "ThemeProvider";
