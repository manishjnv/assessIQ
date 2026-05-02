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
// Page hierarchy:
//   <HelpProvider page="candidate.attempt" audience="candidate" locale="en">
//     <Outlet />   ← the matched child route renders here
//   </HelpProvider>

import { Outlet } from 'react-router-dom';
import { HelpProvider } from '@assessiq/help-system/components';

export function TakeRoot(): JSX.Element {
  return (
    <HelpProvider page="candidate.attempt" audience="candidate" locale="en">
      <Outlet />
    </HelpProvider>
  );
}
