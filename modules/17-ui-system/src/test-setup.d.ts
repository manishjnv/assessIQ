// Type augmentations for vitest test matchers.
// @testing-library/jest-dom matchers are covered by the "types" array in tsconfig.json.
// vitest-axe@0.1.0 targets namespace Vi (vitest v1). vitest v2 uses
// `declare module 'vitest' { interface Assertion<T> }` — patch it here.
import "vitest";

declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): void;
  }
}
