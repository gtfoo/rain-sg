# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

## Shared droplet contract

@~/Git/INFRA.md

## Correspondence

Live mail is in `MAIL.md`, closed mail in `MAIL-ARCHIVE.md`. Neither is imported —
mail churns, and loaded into every session it buries the rules below it. Read
`MAIL.md` before starting work; an empty inbox is the read receipt.

---

# Rules for this app

rain-sg forecasts rain at a point in Singapore for the next two hours, in
15-minute steps. Everything comes from **data.gov.sg** under the Singapore Open
Data Licence.

## NEA radar imagery is off limits — this is legal, not technical

`weather.gov.sg` serves georeferenced rain-area PNGs every 5 minutes. They are
technically ideal: 217×120 at ~290 m, decodable with Node's built-in `zlib`.
**Do not use them.** MSS terms of use 4.1 forbid reproducing or redistributing
site contents, 4.3 limits use to personal and non-commercial, and 4.4 makes
*modification* without written permission a violation. Advecting their frames and
publishing the result is both modification and redistribution.

Clause 4.2 allows asking: `NEA_MSS_Engage@nea.gov.sg`, stating contents, intent,
manner, timeframe and identity. Until that permission exists in writing, the
model is gauges + wind + NEA's own text forecast, and nothing else.

## The forecast join must be causal, and this has broken three times

NEA publishes **multiple updates for the same valid period** — on 7 Jan 2026 the
12:30 forecast was revised at 12:39 and again at 12:53, upgrading Jurong Island
from "Passing Showers" (~13%) to "Thundery Showers" (~44%). Three separate bugs
came out of mishandling that:

1. **Ordering by `valid_period_start` instead of issue time** applies a 12:53
   update to the 12:30 window. That is lookahead: the model learns that NEA
   predicts rain partly because the code was chosen knowing the outcome. It
   inflated measured skill and collapsed when fixed.
2. **JS sort is stable**, so ordering on the period alone silently keeps
   whichever duplicate came first in the file — the *oldest* update in API page
   order, the *newest* in CSV order. Same code, opposite bug, depending on source.
3. **The offset from `valid_period_start` is frequently negative** (a forecast is
   usually issued before its period begins). Stored unsigned, 46% of windows
   became "unknown" with no error anywhere.

Rule: order by **issue timestamp**, apply a forecast only once `issue <= now`,
and keep the offset **signed**.

## Fit P(rain | code, lead) across all eight leads, not just the observed window

NEA reissues every 30 minutes, so "windows since valid start" is almost always 0
or 1. Fitting the code→probability table indexed on that leaves bins 3–7 empty,
and they fall back to the global base rate. Inference then queries
`since + 1 + lead` and reads a placeholder at every lead past 30 minutes —
producing 84% at +15 and 14% at +30 for the same station.

Score each forecast against outcomes at **all eight future offsets**.

## Missing is not dry, and millimetres are not a boolean

Panel coverage is 86–94%. Counting absent readings as zero rain understates the
base rate by 13% relative. A missing reading is unknown.

And the gauges report **millimetres** — a cell going 8 → 4 → 2 mm/h is dying,
one going 2 → 5 → 9 is growing. Binarised to wet/dry those are identical, and
decay is the dominant error at long lead. Keep the intensity.

## Never key a feature to station identity

The gauge network went 61 → 90 stations in eight months, and 2021→2024 saw
stations retired and re-added. A model keyed to station id trains beautifully and
is blind at a fifth of the network. Use location and neighbourhood instead.

Station ids themselves are stable — verified — but the roster is not.

## Weighting requires calibration, and calibration is per regime

Training weights (wet ×3, partial-coverage ×4) improve ranking and **destroy**
calibration: raw Brier goes from 0.0326 to 0.0421, worse than NEA and worse than
doing nothing. Recalibrated it is the best model we have. Ship one without the
other and the app is worse than a blank page.

Platt is fitted **per lead and per island-wetness band** (<2%, 2–20%, ≥20%). A
single global transform cannot correct a bias that appears only when the island
is dry.

## A strong marginal relationship can already be inside the model

"Upwind cleared" — of the gauges upwind that were raining 30 minutes ago, how
many have stopped — separates an 11% chance of rain ending from a 74% one on
the 2025 holdout. A 6.7x swing, wider than upwind wetness alone, and the model
carried no such feature. Every reason to add it.

Added to `lib7.js` and retrained on the same 2023/2022 setup as v5, it changed
**nothing**: 14.7% over NEA became 14.6% on 2026, and 9.4% became 9.3% on 2025.
The fitted weight says why — at +15 min it is -0.085 against 0.472 for upwind
wetness, and by +120 it has decayed to zero and flipped sign. The two are
collinear enough that the existing feature had already absorbed it.

The lesson is about what a marginal measurement can and cannot tell you. A
strong relationship between a candidate and the outcome says nothing about
whether the model already has it. Before building a feature, check the
**residual**: bin the model's existing error by the candidate and see whether
it explains any of it. That check cost ten minutes here and would have saved a
retrain — and it is the same check that correctly predicted the post-hoc
correction would fail.

## A held-out split of one period is not a holdout

Fitting on even days of a holdout and scoring on its odd days feels like
validation. It is not, for anything that varies by season or by year: both
halves share whatever was peculiar to that period, so a period-specific bias
looks exactly like signal.

Measured, on the clearing correction. Across 2025, when 75-100% of upwind
gauges had cleared, the model predicted continuing rain 12 points too high. A
one-term correction fixed it and scored **+1.8% Brier on held-out days of the
same 60 days**. On a fresh 64 days of 2026 the same correction scored
**-0.6%**, because the model's bias in that bin was only 3 points there, not
12 — so the correction overshot by 11. The 2025 numbers alone justified
shipping it, and shipping it would have made the app worse.

Validate anything fitted post-hoc against a **different period**, not a
different slice of the same one. The three stacked adjustments here — the
model's Platt calibration, the cumulative table, and anything added later —
are all fitted on 2025, so 2026 is the check that matters.

## What the interface must not claim

- **We do not anticipate rain forming.** Mean probability 15 minutes before rain
  starts is ~17%. Gauges are tipping buckets; they cannot see a cloud.
- **Beyond ~105 minutes, show NEA's number.** Our skill decays and theirs is the
  honest answer at the far end.
- **Label probabilities uncalibrated** until a reliability diagram shows 70% has
  meant 70%.

Lead with **"when will it stop"** (+26% over NEA, +33% for settled rain), not
"will it rain" — that is where we are strongest and no local product answers it.

## Not this app's

Anything under `/etc`, `/usr/local/bin` or systemd. Box-level changes go to the
droplet agent via `MAIL.md`.
