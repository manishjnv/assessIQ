// Non-render-blocking font stylesheet (replaces the inline onload swap that CSP blocks).
document.querySelectorAll('link[data-font-swap]').forEach(function (l) { l.media = 'all'; });
