#!/usr/bin/env bash
# Z-165 S57: read-only watch on REAL grading quality. Reads gradings through the existing view grading_override_quality.
# Run from the repo root:  bash tools/real-answer-watch.sh
# Overrides only exist where an admin disagreed, so this shows the DIRECTION of the grader's errors and the override
# rate, not accuracy. Rule: act only at 30 or more overrides (ponytail: fixed floor, tune when real volume is known).
set -euo pipefail
OUT=$(ssh assessiq-vps 'docker exec -i assessiq-postgres psql -U assessiq -d assessiq -At -F"|"' <<'SQL'
select count(*) filter (where grader='ai'), count(*) filter (where grader='admin_override') from gradings;
select count(*), count(*) filter (where override_reasoning_band>original_reasoning_band),
  count(*) filter (where override_reasoning_band<original_reasoning_band),
  coalesce(round(avg(override_reasoning_band-original_reasoning_band)::numeric,2),0)
  from grading_override_quality where original_reasoning_band is not null and override_reasoning_band is not null;
select original_reasoning_band||'>'||override_reasoning_band, count(*) from grading_override_quality
  where original_reasoning_band is not null and override_reasoning_band is not null and original_reasoning_band<>override_reasoning_band
  group by 1 order by 2 desc limit 5;
SQL
)
AI=$(sed -n 1p <<<"$OUT" | cut -d'|' -f1); OV=$(sed -n 1p <<<"$OUT" | cut -d'|' -f2)
read -r N UP DOWN MEAN < <(sed -n 2p <<<"$OUT" | tr '|' ' ')
echo "AI gradings: $AI | admin overrides: $OV | override rate: $(awk -v a="$AI" -v o="$OV" 'BEGIN{printf "%.1f%%", (a>0)?(100*o/a):0}')"
echo "band corrections: $N (raised $UP, lowered $DOWN) | mean change (override - AI): $MEAN"
echo "top corrections (AI>admin):"; sed -n '3,$p' <<<"$OUT" | sed 's/^/  /'
if [ "${N:-0}" -lt 30 ]; then echo "VERDICT: not enough real overrides ($N of 30). Keep collecting; change nothing."; exit 0; fi
if awk -v u="$UP" -v d="$DOWN" -v n="$N" 'BEGIN{exit !((u/n>=0.7)||(d/n>=0.7))}'; then
  echo "VERDICT: pattern found (70% or more of corrections go one way). Run the real-answer test: harvest-overrides, then a paired v3 vs candidate run. Mean $MEAN."
else echo "VERDICT: no one-way pattern. Do not change the prompt."; fi
