# Working on rain-sg

@AGENTS.md

This file exists only to import the rules above — without it nothing in
`AGENTS.md` reaches a session automatically.

Recorded because it had a cost here on 2026-08-31: this app was built across a
session whose working directory was the parent repo, so the rules in context
were *that* app's. They read plausibly — same fleet, same droplet, same
conventions — while the ones that actually govern this code were never loaded:
that radar is a **legal** constraint rather than a technical one, that a missing
gauge reading is not a dry one, and that features must never be keyed to station
identity. `NEW-APP.md` did not mention this file, so an app built to the guide
got a rules file nothing read.
