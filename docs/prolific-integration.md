# Prolific integration

The participant frontend supports Prolific's standard external-study URL
parameters while keeping the existing generic and `?p=` pilot links.

## Prolific study setup

In the Prolific study's **Data collection** section:

1. Use `https://gdmproject.ifi.uzh.ch/` as the external study URL.
2. Select **I'll use URL parameters**.
3. Confirm that Prolific appends all three standard parameters:

```text
https://gdmproject.ifi.uzh.ch/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

4. Create the normal completion path and copy its redirect URL, for example:

```text
https://app.prolific.com/submissions/complete?cc=YOUR_COMPLETION_CODE
```

5. Put that URL in **Admin dashboard → Settings → Compensation Link**.
6. Set `PROLIFIC_STUDY_ID` in `infra/.env` to the study's 24-character ID.

`PROLIFIC_STUDY_ID` is optional for local pilots. It must be set for the real
study so a link from another study cannot claim a seat.

## Implemented flow

- The frontend captures `PROLIFIC_PID`, `STUDY_ID`, and `SESSION_ID`.
- Incomplete Prolific parameter sets are rejected instead of becoming generic
  participants.
- The IDs are removed from the address bar immediately after capture.
- An arrival is persisted before the consent/task flow, so early departures
  remain reconcilable.
- The forming-session participant stores all three IDs.
- `(STUDY_ID, SESSION_ID)` is unique and reuses the same seat on duplicate
  joins.
- The PID is not embedded in the generic tracking token.
- The exit survey is persisted before the participant can be marked complete.
- Individual completion is idempotent and separate from group completion.
- Prolific IDs and individual completion timestamps are included in the
  detailed JSON and survey exports.
- `/api/export/prolific-arrivals` lists arrivals including people who did not
  reach the waiting room.

## Configuration still required before launch

- Replace `YOUR_COMPLETION_CODE` with the real normal-completion URL.
- Add the final compensation amount, researcher contact, ethics contact,
  privacy/retention language, and partial-payment wording to the consent pages.
- Decide and configure Prolific completion paths for no consent, voluntary
  withdrawal, unmatched waiting-room participants, and technical failures.
- Decide the reconnect grace period and what a group does after a permanent
  dropout.
- Enable Prolific's deception prescreener for the withheld AI-study focus.
- TODO(Prolific security): enable Secure external URL JWT verification when
  available for the workspace, or provide a Prolific API token so `SESSION_ID`
  can be checked against the submission API. Current validation checks ID
  format and the configured study ID, but URL parameters are not cryptographically
  authenticated.

The completion redirect records completion in Prolific. Whether that
immediately pays the participant or sends the submission to review is selected
inside the Prolific completion-path configuration.
