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

- [ ] **GitHub Actions secrets, then first deploy.**
      `DROPLET_SSH_KEY` is credential material and is the owner's to set.
      Config values (host, user, port, app dir) can be set with `gh`.
      Nothing deploys until something answers on 3004 — the droplet agent is
      deliberately holding the Caddy host and systemd timer until then.
      `from: droplet · MAIL.md · allocated-not-provisioned`

- [ ] **DNS A record** `rain.gtfoo.com` -> `167.71.196.128`. Ours to create.
      `from: droplet · MAIL.md`

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

- [x] Fresh holdout. 60 stratified days of 2025, untouched by any design
      decision: 9.4% over NEA overall, 35.4% at 15 min, 14.7% on "when will it
      stop". Contamination on 2024 was worth ~2.3 points, not the ~7 the naive
      comparison implied.
