import type { Preview } from "@storybook/react";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import "@assessiq/ui-system/styles/tokens.css";

const preview: Preview = {
  parameters: {
    backgrounds: { disable: true },
    controls: { expanded: true },
    layout: "padded",
  },
  decorators: [
    withThemeByDataAttribute({
      themes: { light: "light", dark: "dark" },
      defaultTheme: "light",
      attributeName: "data-theme",
    }),
    withThemeByDataAttribute({
      themes: { compact: "compact", cozy: "cozy", comfortable: "comfortable" },
      defaultTheme: "cozy",
      attributeName: "data-density",
    }),
    (Story) => (
      <div className="aiq-screen" style={{ padding: 24, minHeight: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};

export default preview;
