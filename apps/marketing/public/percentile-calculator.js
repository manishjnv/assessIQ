(function () {
  var form = document.getElementById('pct-form');
  var out = document.getElementById('pct-result');
  var scoreEl = document.getElementById('score');
  var totalEl = document.getElementById('total');
  var cohortEl = document.getElementById('cohort');

  function ordinal(n) {
    var m = n % 100;
    if (m >= 11 && m <= 13) return n + 'th';
    switch (n % 10) {
      case 1: return n + 'st';
      case 2: return n + 'nd';
      case 3: return n + 'rd';
      default: return n + 'th';
    }
  }

  function toNumber(text) {
    var s = String(text).trim();
    if (s === '') return NaN;
    return Number(s);
  }

  function parseCohort(text) {
    var parts = text.split(/[,\n\r]+/);
    var scores = [];
    var bad = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p === '') continue;
      var v = toNumber(p);
      if (!isFinite(v) || v < 0) { bad++; continue; }
      scores.push(v);
    }
    return { scores: scores, bad: bad };
  }

  function showError(message) {
    out.textContent = message;
  }

  function calculate() {
    var score = toNumber(scoreEl.value);
    var total = toNumber(totalEl.value);

    if (!isFinite(score) || score < 0) {
      showError('Enter the candidate\'s score as a number of 0 or more.');
      scoreEl.focus();
      return;
    }
    if (!isFinite(total) || total <= 0) {
      showError('Enter the total marks as a number above 0.');
      totalEl.focus();
      return;
    }
    if (score > total) {
      showError('The score cannot be more than the total marks.');
      scoreEl.focus();
      return;
    }

    var percent = Math.round((score / total) * 1000) / 10;
    var parsed = parseCohort(cohortEl.value);

    var html = '';
    html += '<p class="font-mono text-aiq-xs text-aiq-accent uppercase tracking-aiq-mono mt-0 mb-aiq-xs">Percentage</p>';
    html += '<p class="font-serif text-aiq-hero font-normal tracking-aiq-tighter text-aiq-accent m-0 leading-none mb-aiq-lg">' + percent + '%</p>';

    if (parsed.bad > 0) {
      html += '<p class="font-sans text-aiq-sm text-aiq-fg-secondary mb-aiq-md">' + parsed.bad + (parsed.bad === 1 ? ' entry was' : ' entries were') + ' skipped because ' + (parsed.bad === 1 ? 'it is' : 'they are') + ' not a number of 0 or more.</p>';
    }

    if (parsed.scores.length === 0) {
      html += '<p class="font-sans text-aiq-sm text-aiq-fg-secondary m-0">Paste the group scores to see the percentile rank.</p>';
      out.innerHTML = html;
      return;
    }

    var below = 0;
    var equal = 0;
    for (var i = 0; i < parsed.scores.length; i++) {
      if (parsed.scores[i] < score) below++;
      else if (parsed.scores[i] === score) equal++;
    }
    var n = parsed.scores.length;
    var rank = Math.round(((below + 0.5 * equal) / n) * 100);

    html += '<p class="font-mono text-aiq-xs text-aiq-fg-muted uppercase tracking-aiq-mono mt-0 mb-aiq-xs">Percentile rank in the group</p>';
    html += '<p class="font-serif text-aiq-hero font-normal tracking-aiq-tighter text-aiq-fg-primary m-0 leading-none mb-aiq-lg">' + ordinal(rank) + ' percentile</p>';
    html += '<ul class="font-sans text-aiq-sm text-aiq-fg-secondary m-0 pl-aiq-lg flex flex-col gap-aiq-xs">';
    html += '<li>Group scores in the list: ' + n + '</li>';
    html += '<li>Group scores below the candidate: ' + below + '</li>';
    html += '<li>Group scores equal to the candidate: ' + equal + ' (each counts as half)</li>';
    html += '</ul>';
    html += '<p class="font-sans text-aiq-xs text-aiq-fg-muted mt-aiq-md mb-0">Percentile = (below + half of equal) &divide; group size &times; 100, rounded to a whole number.</p>';

    out.innerHTML = html;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    calculate();
  });
})();
