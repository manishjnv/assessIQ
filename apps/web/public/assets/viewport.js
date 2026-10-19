// Set data-viewport on <html> before React mounts to avoid first-paint flicker between desktop and
// mobile layouts. Kept in sync at runtime by useViewportSync() in @assessiq/ui-system
// (modules/17-ui-system/src/hooks/useViewportSync.ts). External file so CSP script-src needs no unsafe-inline.
(function () {
  try {
    var q = "(max-width: 719px), ((pointer: coarse) and (max-width: 1024px))";
    var v = window.matchMedia && window.matchMedia(q).matches ? "mobile" : "desktop";
    document.documentElement.setAttribute("data-viewport", v);
  } catch {
    document.documentElement.setAttribute("data-viewport", "desktop");
  }
})();
