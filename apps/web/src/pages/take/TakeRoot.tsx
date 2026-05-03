// /take/* subtree root.
//
// Wraps every candidate route in <HelpProvider> so <HelpTip helpId="...">
// and <HelpDrawer /> consumers (used inside Attempt.tsx) get tooltip /
// drawer content from /api/help?page=candidate.attempt&audience=candidate.
//
// HelpProvider degrades gracefully on 4xx (anonymous magic-link visitors
// can't authenticate to the help endpoint until the candidate session is
// minted) — it sets entries=Map() and the consumer components return their
// children unchanged. So mounting at the /take root is safe even before
// Session 4b's session-mint backend ships.
//
// Page hierarchy (non-embed):
//   <HelpProvider page="candidate.attempt" audience="candidate" locale="en">
//     <Outlet />   ← the matched child route renders here
//   </HelpProvider>
//
// Page hierarchy (embed mode — ?embed=true in URL):
//   <EmbedLayout>
//     <HelpProvider ...>
//       <Outlet />
//     </HelpProvider>
//   </EmbedLayout>
//
// EmbedLayout hides the nav bar, sets data-density="compact", and posts
// aiq.height to the host frame via ResizeObserver. It also posts aiq.ready
// on mount so the host SDK can confirm the load.

import { Outlet } from 'react-router-dom';
import { HelpProvider } from '@assessiq/help-system/components';
import { useEmbedMode } from '../../lib/useEmbedMode';
import { EmbedLayout } from '../../lib/EmbedLayout';

export function TakeRoot(): JSX.Element {
  const isEmbed = useEmbedMode();

  const inner = (
    <HelpProvider page="candidate.attempt" audience="candidate" locale="en">
      <Outlet />
    </HelpProvider>
  );

  if (isEmbed) {
    return <EmbedLayout>{inner}</EmbedLayout>;
  }

  return inner;
}

