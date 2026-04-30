import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/AccessIQ_UI_Template/**",
    ],
  },

  // TypeScript recommended rules (no type-aware rules — avoids projectService
  // brittleness in flat config with pnpm workspaces under TS 5.6)
  ...tseslint.configs.recommended,

  // Project-wide custom rules
  {
    rules: {
      // Code must use pino logger — never console
      "no-console": ["error"],

      // Block Anthropic / Claude SDK imports everywhere (CLAUDE.md hard rule #1).
      // The only allowlisted import site is modules/07-ai-grading/runtimes/anthropic-api.ts,
      // enforced by the no-ambient-claude CI lint script (tools/lint-no-ambient-claude.ts).
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@anthropic-ai/claude-agent-sdk"],
              message:
                "Claude Agent SDK is forbidden in Phase 0. See CLAUDE.md rule #1.",
            },
            {
              group: ["@anthropic-ai/sdk"],
              message:
                "Anthropic SDK is forbidden in Phase 0. See CLAUDE.md rule #1.",
            },
            {
              group: ["**/AccessIQ_UI_Template/**"],
              message:
                "Do not import from the UI template at runtime. Hand-port idioms into modules/17-ui-system/src/components/.",
            },
          ],
        },
      ],
    },
  },
);
