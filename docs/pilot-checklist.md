# Pilot Checklist

Step-by-step verification for local pilot runs. For setup instructions see [getting-started.md](getting-started.md). For intervention logic details see [bot-rulebook.md](bot-rulebook.md).

## 1. Start Fresh

```bash
cd infra
sh stop.sh --volumes
sh start.sh
```

Open the admin dashboard at http://localhost:3003.

Confirm:

- all four conditions are visible
- desired pilot condition is active
- group size is set appropriately (default `3`)
- `research-db` is healthy in `docker compose ps`

## 2. Create a Forced-Condition Group

Use the pilot links in the admin dashboard, or open participant links manually:

```
http://localhost:3000/?p=pilot-public-neutral-1&conditionId=public-neutral
http://localhost:3000/?p=pilot-public-neutral-2&conditionId=public-neutral
http://localhost:3000/?p=pilot-public-neutral-3&conditionId=public-neutral
```

Repeat for each condition you want to test:

- `public-neutral`
- `public-engaging`
- `private-neutral`
- `private-engaging`

## 3. Verify Participant Flow

For each participant tab:

- [ ] Tracking token is removed from the browser URL
- [ ] Entry survey completes
- [ ] Waiting room count increments
- [ ] Chat opens once the group is full
- [ ] Shared ranking edits sync across participants
- [ ] Reactions sync across participants
- [ ] Timer ends the discussion and opens the exit survey
- [ ] Exit survey can submit

## 4. Trigger Bot Behavior

To trigger an intervention:

- Have one participant send several longer messages
- Keep at least one participant quiet
- Wait until outside the protected start window (default: 3 minutes)
- Confirm the bot message appears

Expected behavior per condition:

| Condition | What to verify |
|---|---|
| `public-neutral` | Whole group sees participation split |
| `public-engaging` | Whole group sees split + top-contributor prompt naming quiet members |
| `private-neutral` | Only dominant participant sees the split |
| `private-engaging` | Only dominant participant sees split + prompt |

## 5. Verify Admin Data

In the admin dashboard:

- [ ] Sessions list updates after refresh
- [ ] Session detail contains participants, surveys, messages, ranking data, and interventions
- [ ] Intervention audit shows mode, targets, quiet members, contribution split, and message text
- [ ] JSON export downloads
- [ ] CSV export downloads
- [ ] Data survives a `session-manager` container restart (without `--volumes`)

## 6. Capture Issues

Record any of the following:

- Unexpected bot timing or repeated interventions
- Confusing intervention wording
- Wrong public/private visibility
- Contribution split that does not match the conversation
- Matrix sync delays
- Participant flow blockers
- Admin dashboard or export gaps
