# Tasks — rain-sg

What this app owes. **Written only by the rain-sg agent**; readable by anyone.
Tasks carry a `from:` pointer, because the reasoning usually lives in a letter
and a one-line task strands the *why*.

## Open

- [ ] **Reliability diagram before dropping the "uncalibrated" label.**
      The interface currently says "estimates uncalibrated" in the footer, and
      that stays until we can show 70% has meant 70%. Calibration is applied
      (Platt, per lead, per island-wetness band) but has never been *plotted* —
      it is asserted, not observed. Data is on disk.
      `from: self · the one honesty claim the UI makes that is not yet earned`


- [ ] **GBM across all eight leads.** Beat the linear model at every lead
      measured (-6.3% at 15 min, -0.4% to -0.9% beyond), but only four of eight
      were measured — stdout buffering lost the rest. 960 trees against 128
      coefficients is a real cost, so decide on complete evidence.
      `from: self · partial result, do not adopt on a quarter of the data`

- [ ] **Onset warning is the real weakness.** Mean probability 15 minutes
      before rain starts is ~17%. Every improvement so far has been to aggregate
      Brier, which is dominated by quiet periods and says nothing about whether
      a user would have been warned.
      `from: self · measured on the 2024 holdout`

- [ ] **Windowed rate in the poller's logging.** A rate averaged over a whole
      run reads 0.48 req/s after a laptop sleep when the true rate is 2.34. On
      the droplet a hung fetch and a suspended one would look identical.
      `from: self · observed during the 2025 holdout pull`

## Done

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
