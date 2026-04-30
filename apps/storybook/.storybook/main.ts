import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: [
    "../../../modules/17-ui-system/src/**/*.stories.@(ts|tsx)",
  ],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-themes",
  ],
  typescript: {
    check: false,
    reactDocgen: "react-docgen-typescript",
  },
};

export default config;
