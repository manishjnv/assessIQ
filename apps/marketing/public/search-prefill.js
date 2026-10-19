// ?q= prefill for the Pagefind component UI (external file: CSP script-src has no unsafe-inline).
window.addEventListener('DOMContentLoaded', function () {
  var q = new URLSearchParams(window.location.search).get('q');
  if (!q) return;
  // Component UI has no prefill attribute; set the input value and dispatch
  // an input event. The input renders asynchronously, so retry briefly.
  var tries = 0;
  (function fill() {
    var input = document.querySelector('#search pagefind-input input');
    if (input) {
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (tries++ < 50) {
      setTimeout(fill, 100);
    }
  })();
});
