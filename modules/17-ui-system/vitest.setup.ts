import { expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import * as axeMatchers from "vitest-axe/matchers";
import "@testing-library/jest-dom/vitest";

expect.extend(axeMatchers);
afterEach(cleanup);
