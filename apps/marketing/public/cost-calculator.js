// Cost-of-a-bad-hire calculator (external file: CSP script-src has no unsafe-inline).
(function () {
  'use strict';

  // Format a number as Indian rupee string with lakh/crore grouping
  function formatINR(amount) {
    // Use Intl if available (modern browsers)
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(Math.round(amount));
    } catch {
      return '₹' + Math.round(amount).toLocaleString('en-IN');
    }
  }

  function calculate() {
    var ctc = parseFloat(document.getElementById('ctc').value) || 0;
    var recruitingPct = parseFloat(document.getElementById('recruiting-pct').value) || 0;
    var rampMonths = parseFloat(document.getElementById('ramp-months').value) || 0;
    var rampProductivity = parseFloat(document.getElementById('ramp-productivity').value) || 0;
    var exitCost = parseFloat(document.getElementById('exit-cost').value) || 0;

    // Clamp percentages to valid range
    recruitingPct = Math.max(0, recruitingPct);
    rampMonths = Math.max(0, rampMonths);
    rampProductivity = Math.min(100, Math.max(0, rampProductivity));

    // 1. Recruiting & replacement cost
    var recruitingCost = ctc * (recruitingPct / 100);

    // 2. Ramp productivity loss
    //    Monthly salary equivalent = ctc / 12
    //    Productivity gap = 1 - (rampProductivity / 100)
    var monthlyCTC = ctc / 12;
    var productivityGap = 1 - (rampProductivity / 100);
    var rampLoss = monthlyCTC * rampMonths * productivityGap;

    // 3. Separation & exit cost (direct input)
    var separation = exitCost;

    // Total
    var total = recruitingCost + rampLoss + separation;

    // Update DOM
    document.getElementById('result-recruiting').textContent = formatINR(recruitingCost);
    document.getElementById('result-ramp').textContent = formatINR(rampLoss);
    document.getElementById('result-exit').textContent = formatINR(separation);
    document.getElementById('result-total').textContent = formatINR(total);
  }

  // Run on every input change
  var form = document.getElementById('calc-form');
  if (form) {
    form.addEventListener('input', calculate);
    // Initial render with defaults
    calculate();
  }
}());
