# rain-sg

Rain nowcast for Singapore. Given a location, the probability of rain in each
15-minute step over the next two hours — and, when it is already raining, how
much longer it is likely to last.

Everything comes from [data.gov.sg](https://data.gov.sg) under the Singapore
Open Data Licence: rain gauges, wind, and NEA's own 2-hour forecast. No radar —
see `AGENTS.md` for why that is a legal constraint rather than a technical one.

## How well it works

Measured on **60 stratified days of 2025** — 2.3 million station-window-lead
samples that no design decision ever touched. Every feature choice, weighting
scheme and calibration band was fixed before this data was looked at.

| | Brier | vs NEA |
|---|---|---|
| **this model** | **0.033726** | — |
| NEA's own 2-hour forecast | 0.037235 | **9.4% better** |
| assuming it never rains | 0.048330 | 30.2% better |

Skill is concentrated at short range, and honestly so:

| lead | vs NEA |
|---|---|
| **15 min** | **35.4%** |
| 30 min | 19.9% |
| 60 min | 6.8% |
| 120 min | 1.1% |

The two questions the app answers are not equally easy:

| | vs NEA | vs the naive answer |
|---|---|---|
| *Will it rain?* (currently dry) | 7.3% | 17.0% better than "no" |
| ***When will it stop?*** (raining now) | **14.7%** | **69.0%** better than "it keeps raining" |

**We are twice as good at saying when rain will stop as at saying when it will
start** — and nothing else here answers that question at all. That is what the
interface leads with.

## Honest limits

- **We detect rain arriving; we do not anticipate it forming.** Mean probability
  15 minutes before rain starts is ~17%. Gauges are tipping buckets — they
  cannot see a cloud.
- **Past ~90 minutes we add almost nothing** over NEA, so the interface shows
  their outlook rather than pretending otherwise.
- **Probabilities are labelled uncalibrated** until a reliability diagram shows
  that 70% has meant 70%.

## Running it

```
DATA_DIR=/path/outside/the/tree npm run dev
```

`DATA_DIR` has no default, deliberately: a fallback inside the tree lets the app
boot, create an empty directory and serve nothing while reporting healthy.

Then `GET /api/backfill?hours=2` to populate history, and `GET /api/poll` to
fetch the current slot. Both are loopback-only.
