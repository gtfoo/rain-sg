# Tasks — rain-sg

What this app owes. **Written only by the rain-sg agent**; readable by anyone.
Tasks carry a `from:` pointer, because the reasoning usually lives in a letter
and a one-line task strands the *why*.

## Open

- [ ] **"Upwind cleared" may be a missing model feature, not just a caption.**
      Measured on the 2025 holdout, over windows where it is raining and rain
      stops next 35.5% of the time: when 0-5% of upwind gauges have cleared it
      stops 11.1% of the time, and when 75-100% have cleared, 73.9%. A 6.7x
      swing, wider than upwind wetness alone (65.3% vs 16.9%), because
      "cleared" separates dry-because-it-stopped from dry-because-it-never-
      rained. The feature set has upwind *wetness* and local and island mm
      trends, but nothing for an upwind temporal derivative. "When will it
      stop" is the app's strongest claim, so this is the likeliest place to
      make it stronger. Needs a retrain, so it belongs with the quarterly one.
      `from: self · measured while building the clearing line, 2026-09-11`

- [ ] **Wind is 27% complete while the day is running.** The model was trained
      on ~15 wind readings per 15-minute window; the live endpoint only advances
      every 4-6 minutes, so polling supplies 3-4 and no rate fixes it. The
      nightly backfill takes the stored record to 99.8%, but a forecast served
      at 3pm used the thin version. Measure how far the four wind features
      actually move between a 3-sample and a 15-sample window mean before
      deciding whether this needs anything at all.
      `from: self · measured 2026-09-08, live endpoint vs archive`

- [ ] **A missing slot silently shifts the lag features.** `loadObservations`
      takes the four newest stored slots as [now, -15, -30, -45] without
      checking they are consecutive, so after a gap "15 minutes ago" is really
      30. `slotMinutes` already exists in that file to compute true offsets and
      is only used for the forecast join. One gap in 681 slots so far, so the
      effect is small — but it is the "missing is not dry" failure again:
      absence treated as continuity, with nothing logged.
      `from: self · found via the 2026-09-02T0345 gap`

- [ ] **Reliability diagram before dropping the "uncalibrated" label.**
      The footer says "estimates uncalibrated" and that stays until we can show
      70% has meant 70%. Calibration is applied (Platt, per lead, per
      island-wetness band) but has never been *plotted* — asserted, not
      observed.

      Unblocked as of 2026-09-04: `appendVerification` existed but nothing ever
      called it, so the log was empty four days after going live. The poller now
      records all 88 stations x 8 leads on every slot that advances. At 216 MB
      a year it can run indefinitely; the diagram needs enough rain to have
      fallen, which the first four days did not supply (0.19% wet, verified
      against NEA's own archive).
      `from: self · the one honesty claim the UI makes that is not yet earned`


- [ ] **GBM across all eight leads.** Beat the linear model at every lead
      measured (-6.3% at 15 min, -0.4% to -0.9% beyond), but only four of eight
      were measured — stdout buffering lost the rest. 960 trees against 128
      coefficients is a real cost, so decide on complete evidence.
      `from: self · partial result, do not adopt on a quarter of the data`

- [ ] **Onset warning: decide the threshold, not the model.** Re-measured on
      the fresh 2025 holdout (`onset2025.js`), which replaces the 2024 figure
      the task used to quote — that set was contaminated by dozens of design
      decisions.

      | | ours | NEA |
      |---|---|---|
      | mean 15 min before onset | 20.1% | 30.3% |
      | median | 14.6% | |
      | mean over all dry windows | 2.07% | 4.47% |
      | **lift over own baseline** | **9.69x** | 6.77x |

      NEA reads higher at onset, but that is bluntness rather than skill: it is
      higher *everywhere*. Scale-free, our model raises its own voice nearly ten
      times when rain is coming, against NEA's under seven. Checking that was
      the difference between a finding and a misreading.

      **So the model is not blind to onset, and "improve the model" is the wrong
      framing.** The problem is the base rate: only 1.77% of dry windows are
      followed by rain, so any threshold that catches most onsets also fires
      often when nothing happens.

      | warn at | onsets caught | false alarms per catch |
      |---|---|---|
      | >= 10% | 63.4% | 7.1 |
      | >= 15% | 49.3% | 5.8 |
      | >= 20% | 38.5% | 5.2 |
      | >= 50% | 8.2% | 3.3 |

      The open question is a product one: which point on that curve, and what
      the interface says at it. Half of all onsets are preceded by a reading
      under 15%, so no wording makes those a warning — the honest move may be
      to say what the number means rather than to promise a warning the data
      cannot support.
      `from: self · re-measured on the fresh 2025 holdout, 2026-08-31`

## Done

- [x] The verification log has a reader: `scripts/score-point.mjs`. Joins the
      recorded forecasts to the stored rainfall and blends the four nearest
      reporting gauges exactly as `forecastAtPoint` does, so it scores what was
      served rather than a replay. Runs on the box against its own DATA_DIR.
      `from: self · closed 2026-09-11`

- [x] Windowed rate, and the task was filed against the wrong program. The
      defect was never in `/api/poll` — that logs only run duration, computes
      no rate, and bounds a hung fetch with `curl --max-time 60` under
      `TimeoutStartSec=90`. It was in `~/rain-data/pull-fast.js`, which divided
      total requests by wall-clock since launch: a cumulative average that read
      0.48 req/s after a laptop sleep against a true 2.34, and that can never
      recover because one stall drags the remainder down. The ETA inherited it
      (~147 min reported, ~56 true). Both are now windowed over 60s, and a
      stalled run prints "stalled" rather than a decaying guess.

      **The first version of the fix was wrong and a test caught it**: `mark()`
      trimmed only on write, so through a five-minute sleep the "windowed" rate
      still read 2.33 — reproducing the exact failure it replaced. `perSec` now
      trims at read time. `~/rain-data/rate-test.js` drives the real functions
      against a controlled clock and asserts 2.34 / 0.00 / 2.33.

      Note: that file lives outside this repo, which is why the task as
      originally written could never be closed from here.
      `from: self · observed during the 2025 holdout pull, fixed 2026-08-31`

- [x] Fully live. Credentials transferred with the owner's authorisation and
      verified by byte count on both sides (18/12/100), not by "does search
      work" — search needs no credentials and would have passed a mangled
      value. Reverse geocoding returns real names; 36 of 36 grid points
      forecast; nearest gauge 1.9 km in the city centre, which is the store
      confirming the coverage fix healed it in production.
      `from: self · 2026-08-31`

- [x] First deploy. Commit `4bb5f0e`, fifteen steps green: bundle assembled and
      shipped, `rain.service` restarted, **3004 answering, bound to loopback
      only**. The unit came up on an empty env file exactly as designed.
      `from: self · run under .github/workflows/deploy.yml`

- [x] Provisioning unblocked. The order was circular — the key was held until
      3004 answered, and 3004 could only answer after a deploy that needed the
      key. Splitting the items by *public or running?* freed the three private
      ones. Run `33317433563` supplied the evidence: every gate passed, and it
      failed at the handshake for the one expected reason.
      `from: self · droplet acted on it same day`

- [x] There is no DNS step. `*.gtfoo.com` is a wildcard, so `rain.gtfoo.com`
      resolved before it was asked for. Six apps were told to create an A
      record; none did, and all six got certificates. Guide corrected upstream.
      `from: droplet · MAIL.md · the DNS you are waiting on does not exist`

- [x] Fresh holdout. 60 stratified days of 2025, untouched by any design
      decision: 9.4% over NEA overall, 35.4% at 15 min, 14.7% on "when will it
      stop". Contamination on 2024 was worth ~2.3 points, not the ~7 the naive
      comparison implied.
