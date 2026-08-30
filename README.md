# rain-sg

Rain nowcast for Singapore. Given a location, the probability of rain in each
15-minute step over the next two hours — and, when it is already raining, how
much longer it is likely to last.

Everything comes from [data.gov.sg](https://data.gov.sg) under the Singapore
Open Data Licence: rain gauges, wind, and NEA's own 2-hour forecast. No radar —
see `AGENTS.md` for why that is a legal constraint rather than a technical one.

## How it works

A logistic model per 15-minute lead, trained on 2021–2023 and validated on 2024.
Features are rainfall history and neighbourhood, rainfall *intensity* and its
trend, wind (including whether rain is upwind or downwind of you), and NEA's
forecast as a calibrated probability. Predictions are Platt-calibrated per lead
and per island-wetness regime.

Measured on 16.75M held-out samples: **16.5% better than NEA's own forecast**,
and 31% better than assuming it will not rain.

## Honest limits

- We detect rain arriving; we do not anticipate it forming. ~17% mean
  probability 15 minutes before rain starts.
- Beyond ~105 minutes we show NEA's number, because ours is no longer better.
- Probabilities are labelled uncalibrated until the reliability data exists.
