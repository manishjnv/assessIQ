import type { TenantBranding } from "../theme/ThemeProvider";

export interface TenantFixture {
  id: string;
  slug: string;
  name: string;
  branding: TenantBranding;
}

export const TENANT_FIXTURES: Record<string, TenantFixture> = {
  "wipro-soc": {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "wipro-soc",
    name: "Wipro SOC",
    branding: { primary: "oklch(0.58 0.17 258)" }, // default accent (hue 258)
  },
  "demo-blue": {
    id: "00000000-0000-0000-0000-000000000002",
    slug: "demo-blue",
    name: "Demo Blue",
    branding: {
      primary: "oklch(0.58 0.17 220)",
      primarySoft: "oklch(0.96 0.03 220)",
      primaryHover: "oklch(0.52 0.19 220)",
    },
  },
  "demo-teal": {
    id: "00000000-0000-0000-0000-000000000003",
    slug: "demo-teal",
    name: "Demo Teal",
    branding: {
      primary: "oklch(0.62 0.14 180)",
      primarySoft: "oklch(0.96 0.03 180)",
      primaryHover: "oklch(0.56 0.16 180)",
    },
  },
};
