# Pilot Checklist

Use this checklist for local pilot runs before the final Mars task
specification is available. The Docker stack includes a dedicated research
Postgres database, so pilot data survives backend restarts unless the Docker
volume is removed.

## 1. Start Fresh

```bash
cd infra
docker compose down -v
docker compose up --build
```

Open the admin dashboard:

```text
http://localhost:3003
```

Confirm:

- all four conditions are visible
- desired pilot condition is active
- group size is small enough for the run, usually `3`
- protected start/end and score/rate windows are set as intended
- `research-db` is healthy in `docker compose ps`

## 2. Create A Forced-Condition Group

Use the pilot links in the admin dashboard, or open participant links manually:

```text
http://localhost:3000/?p=pilot-public-neutral-1&conditionId=public-neutral
http://localhost:3000/?p=pilot-public-neutral-2&conditionId=public-neutral
http://localhost:3000/?p=pilot-public-neutral-3&conditionId=public-neutral
```

Repeat with:

- `public-neutral`
- `public-engaging`
- `private-neutral`
- `private-engaging`

## 3. Verify Participant Flow

For each participant:

- tracking token is removed from the browser URL
- entry survey completes
- waiting room count increments
- chat opens once the group is full
- shared ranking edits sync across participants
- reactions sync across participants
- timer ends the discussion and opens the exit survey
- exit survey can submit

## 4. Trigger Bot Behavior

For intervention conditions:

- have one participant send several longer messages
- keep at least one participant quiet
- wait until outside the protected start window
- confirm the bot message appears

Expected behavior:

- public neutral: group sees participation split
- public engaging: group sees split plus top-contributor prompt
- private neutral: only dominating participant sees split
- private engaging: only dominating participant sees split plus prompt

## 5. Verify Admin Data

In the admin dashboard:

- sessions list updates after refresh
- selected session detail contains participants, surveys, messages, ranking data, and interventions
- intervention audit shows mode, targets, quiet members, contribution split, and message text
- JSON export opens
- CSV export opens
- exports still contain the session after restarting only `session-manager`

## 6. Capture Issues

Record:

- unexpected bot timing
- confusing wording
- wrong public/private visibility
- contribution split that does not match the conversation
- Matrix sync delays
- participant flow blockers
- admin/export gaps
