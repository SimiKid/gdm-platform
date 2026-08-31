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

5. Put that URL in **Admin dashboard → Settings → Prolific completion and
   exit paths → Full completion**.
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
- Consent decline, failed English eligibility, voluntary withdrawal,
  unmatched waiting, technical/group failure, participant dropout, and full
  completion are stored as durable, idempotent outcomes.
- The participant can leave explicitly after consent. A waiting-room
  withdrawal releases the seat; a dropout after the group starts aborts the
  group so the remaining participants are not stranded in an invalid task.
- Every active Prolific page sends a heartbeat. After
  `PARTICIPANT_RECONNECT_GRACE_SECONDS` (30 seconds by default) without one,
  the submission receives an immutable `connection_timeout` outcome. A
  waiting seat is released; a live group is aborted and its Matrix members are
  removed from the room. Reopening within the grace period resumes normally.
- With `PROLIFIC_AUTO_RETURN_DISCONNECTS=true`, a connection timeout also
  sends Prolific's request-return message automatically. This does not pay a
  bonus or approve a submission.
- Waiting rooms have a durable deadline and visible countdown. The backend
  sweeps expired rooms even when no browser makes another join request.
- Returning participants resume their terminal outcome rather than being
  silently placed into another group.
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
- `/api/export/prolific-outcomes` and the admin dashboard's **Prolific** tab
  show lifecycle, elapsed time, compensation decision, and API action state.
- Return requests, bonus preparation, and bonus payment are separate audited
  actions. Automatic processing is disabled unless
  `PROLIFIC_PAYMENT_AUTOMATION=true`.
- Bonus payment has a persisted one-way guard. Prolific documents that paying
  a bulk bonus is not idempotent, so an ambiguous payment is never retried;
  it is marked for manual reconciliation.
- Post-consent early exits show the same withheld-purpose debrief as successful
  completion and require acknowledgement before the Prolific redirect. Consent
  declines and eligibility screen-outs do not show it.
- Time-based partial amounts are rounded up by minute and capped by
  `PARTIAL_PAYMENT_MAX_PENCE` (508 pence for the current £5.08 study reward).

## Exit-path configuration

Create the required completion paths/codes in Prolific, then store their full
HTTPS redirect URLs under **Admin → Settings → Prolific completion and exit
paths**:

| App outcome | Admin setting | Compensation decision |
| --- | --- | --- |
| Completed | Full completion | Normal study reward |
| Declined consent | Consent declined | None |
| Insufficient English | Ineligible | None / configured screen-out path |
| Chose to withdraw | Voluntary withdrawal | None or researcher review, depending on stage |
| Connection lost for more than 30 seconds | Technical/group failure | None, review, or capped time-based partial depending on stage |
| Group did not form | Group not formed | Time-based partial bonus review |
| Technical failure or live dropout | Technical/group failure | Time-based partial bonus review |

An empty early-exit URL is fail-safe: the outcome is still recorded, but the
participant is told to contact the researcher rather than receiving an
incorrect completion code.

## Configuration still required before launch

- Create and enter the final Prolific completion/screen-out/return URLs.
- Confirm the final compensation amount, researcher contact, ethics contact,
  privacy/retention language, waiting deadline, partial-payment rate, and
  partial-payment cap.
- Keep `PROLIFIC_PAYMENT_AUTOMATION=false` through local and Prolific preview
  testing. Use the admin queue for manual reconciliation first.
- Enable Prolific's deception prescreener for the withheld AI-study focus.
- Create a server-only Prolific API token and set `PROLIFIC_API_TOKEN` in
  `infra/.env`. The Session Manager then retrieves each `SESSION_ID` from
  Prolific and requires its study and participant IDs to match before assigning
  a seat. If Prolific enables Secure external URLs for the workspace later, JWT
  verification can replace the full-permission researcher token.

The completion redirect records completion in Prolific. Whether that
immediately pays the participant or sends the submission to review is selected
inside the Prolific completion-path configuration.
