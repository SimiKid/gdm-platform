# Prolific integration

The participant frontend supports Prolific's standard external-study URL
parameters while keeping the existing generic and `?p=` pilot links.

## Prolific study setup

In the Prolific study's **Data collection** section:

1. Use `https://gdmproject.ifi.uzh.ch/` as the external study URL.
2. Select **I'll use URL parameters**.
3. Confirm that Prolific automatically appends all three standard parameters:

```text
PROLIFIC_PID
STUDY_ID
SESSION_ID
```

Do not add the placeholders to the base URL manually; selecting URL parameters
in Prolific adds them.

4. Use the normal completion redirect:

```text
https://app.prolific.com/submissions/complete?cc=CNE4B56C
```

5. Put that URL in **Admin dashboard → Settings → Compensation Link**.
6. Set the study ID in `infra/.env`:

```text
PROLIFIC_STUDY_ID=6a69fc8742750ae81af3d24a
```

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

- Add the final compensation amount, researcher contact, ethics contact,
  privacy/retention language, and partial-payment wording to the consent pages.
- No consent, voluntary withdrawal, unmatched waiting-room participants, and
  technical failures all use the same no-completion outcome: the participant
  leaves the GDM study and is not sent through the paid completion redirect.
  Their Prolific submission must be returned or allowed to time out.
- Decide the reconnect grace period and what a group does after a permanent
  dropout.
- Enable Prolific's deception prescreener for the withheld AI-study focus.
- Create a server-only Prolific API token and set `PROLIFIC_API_TOKEN` in
  `infra/.env`. The Session Manager then retrieves each `SESSION_ID` from
  Prolific and requires its study and participant IDs to match before assigning
  a seat. If Prolific enables Secure external URLs for the workspace later, JWT
  verification can replace the full-permission researcher token.

The completion redirect records completion in Prolific. Whether that
immediately pays the participant or sends the submission to review is selected
inside the Prolific completion-path configuration.
