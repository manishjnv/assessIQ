// Barrel for the /take/* page tree.
//
// Routes registered in App.tsx (under <TakeRoot> which wraps <HelpProvider>):
//   /take/expired                        → Expired       (static)
//   /take/error                          → ErrorPage     (static)
//   /take/attempt/:id                    → AttemptPage   (the runner)
//   /take/attempt/:id/submitted          → Submitted     (terminal post-submit)
//   /take/:token                         → TokenLanding  (magic-link entry; matches LAST per RR specificity)

export { TokenLanding } from './TokenLanding';
export { Expired } from './Expired';
export { ErrorPage } from './ErrorPage';
export { AttemptPage } from './Attempt';
export { Submitted } from './Submitted';
export { TakeRoot } from './TakeRoot';
