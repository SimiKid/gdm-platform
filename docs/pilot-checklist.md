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

- all five conditions are visible in Settings → Recruiting (baseline + the
  2x2 grid: public/private delivery x rule-based/rule+LLM detection)
- desired pilot condition is active
- group size is set appropriately (default `3`)
- the Overview shows the expected current **study round** (Round 1 on a fresh
  stack) — pilot sessions are stamped into the open round
- for the `public-llm` / `private-llm` arms: `ANTHROPIC_API_KEY` is set in
  `infra/.env` (with `LLM_MODE=active` the chat service refuses to start
  without it; with `LLM_MODE` unset the arms silently degrade to rule-based)
- `research-db` is healthy in `docker compose ps`

## 2. Create a Forced-Condition Group

For auto-assigned conditions, open the generic study link in 3 tabs:

```
http://localhost:3000/
```

To force a specific condition, use a pilot link from the admin dashboard's
**Testing** tab or manually:

```
http://localhost:3000/?conditionId=public-rule
```

Open in 3 tabs (one per participant). Repeat for each condition:

- `baseline`
- `public-rule`
- `public-llm`
- `private-rule`
- `private-llm`

## 3. Verify Participant Flow

For each participant tab:

- [ ] Tracking token is removed from the browser URL
- [ ] Consent page accepts and advances
- [ ] About You questionnaire completes
- [ ] Individual Moon Survival ranking completes (10-min timer)
- [ ] Group Intro page advances to waiting room
- [ ] Waiting room count increments
- [ ] Chat opens once the group is full
- [ ] Shared ranking edits sync across participants
- [ ] No emoji-reaction UI is offered (removed per study protocol)
- [ ] @mentions work in chat
- [ ] Timer turns red / "wrap up!" in the last 2 minutes (protected end)
- [ ] Timer ends the discussion and opens the exit survey
- [ ] Exit survey can submit
- [ ] Debriefing page shows study explanation and compensation link

## 4. Trigger Bot Behavior

To trigger an intervention:

- Have one participant send several longer messages
- Keep at least one participant quiet
- Wait until outside the protected start window (default: 3 minutes)
- Confirm the bot message appears

Expected behavior per condition (nudge **text is identical** across all
non-baseline arms — only delivery and detection differ):

| Condition | What to verify |
|---|---|
| `baseline` | No bot messages appear at all |
| `public-rule` | Whole group sees the nudge (📢 badge), rule-based trigger |
| `public-llm` | Whole group sees the nudge; classifications recorded (check the contributions export) |
| `private-rule` | Only the dominant participant sees the nudge (🔒 badge) |
| `private-llm` | Only the dominant participant sees the nudge; classifications recorded |

Optional: in the **Testing** tab, enable the 2-bot comparison toggle on a
non-baseline arm and verify Assistants A and B both nudge — then **switch it
off again** (never leave it on for real recruiting; the Testing tab shows a
standing warning while it is enabled).

## 5. Verify Admin Data

In the admin dashboard:

- [ ] Sessions list updates after refresh
- [ ] Session detail contains participants, surveys, messages, ranking data, and interventions
- [ ] Intervention audit shows mode, targets, quiet members, contribution split, and message text
- [ ] Results tab shows the pilot session in the per-condition descriptives
- [ ] Raw exports download (Overview tab: sessions/messages/interventions/surveys/contributions, JSON + CSV)
- [ ] Research exports download (Results tab: participants/sessions-analysis/windows/rankings CSVs and the ZIP bundle with codebook)
- [ ] `linkage.csv` downloads from the Identifying Data section (and stays out of the bundle)
- [ ] Round filter chips appear once more than one round exists and rewrite the download links
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
