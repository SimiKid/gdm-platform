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

- all three conditions are visible in Settings → Recruiting (`baseline`,
  `public-llm`, `private-llm`)
- desired pilot condition is active
- group size is set appropriately (default `3`)
- the Overview shows the expected current **study round** (Round 1 on a fresh
  stack) — pilot sessions are stamped into the open round
- `ANTHROPIC_API_KEY` is set in `infra/.env`: both nudging arms depend on
  it. Without a key every classification is recorded as a failure, the
  dominance score silently drops to 0.9 × share (there is no rule-only arm
  to fall back to), and nudges use the fixed fallback wording; with
  `GDM_ENV=production` the chat service refuses to start without the key
- `research-db` is healthy in `docker compose ps` (it has a `pg_isready`
  healthcheck)

## 2. Create a Forced-Condition Group

For auto-assigned conditions, open the generic study link in 3 tabs:

```
http://localhost:3000/
```

To force a specific condition, use a pilot link from the admin dashboard's
**Testing** tab or manually:

```
http://localhost:3000/?conditionId=public-llm
```

Open in 3 tabs (one per participant). Repeat for each condition:

- `baseline`
- `public-llm`
- `private-llm`

## 3. Verify Participant Flow

For each participant tab:

- [ ] Recruiting parameters are removed from the browser URL (`?p=`/`?c=`
      tracking links and the three Prolific parameters are stripped after
      being read)
- [ ] Consent page accepts (all three checkboxes) and advances
- [ ] About You questionnaire (demographics) completes; entering an age under
      18 or English proficiency "None" ends participation as ineligible
- [ ] Attitudes page (AI attitudes, personality, teamwork, chat comfort,
      topic familiarity) completes
- [ ] Individual Moon Survival ranking completes (5-min timer; the timer
      turns red for the last 2 minutes and auto-completes on expiry)
- [ ] Group Intro page advances to waiting room
- [ ] Waiting room count increments
- [ ] Chat opens once the group is full
- [ ] Shared ranking edits sync across participants
- [ ] No emoji-reaction UI is offered (removed per study protocol)
- [ ] @mentions work in chat
- [ ] Timer turns red / "wrap up!" in the last 2 minutes (protected end)
- [ ] Timer ends the discussion and opens the exit survey
- [ ] Exit survey (final ranking → confidence + group dynamics →
      psychological safety + bot perception) can submit
- [ ] Debriefing page shows study explanation, the optional feedback box,
      and the compensation link (enabled after the acknowledgement checkbox)

## 4. Trigger Bot Behavior

To trigger an intervention:

- Have one participant send several longer messages
- Keep at least one participant quiet
- Wait for the first contribution-window boundary: the bot only evaluates at
  window ends, and the first window opens when the warm-up ends (default:
  3 minutes) and lasts `contributionWindowMinutes` (default: 4), so the first
  possible nudge is about 7 minutes into a 10-minute discussion — and with
  the default 2-minute protected end it is the only window that can fire
- Confirm the bot message appears

Expected behavior per condition (nudge **text is identical** across both
nudging arms — only delivery differs):

| Condition | What to verify |
|---|---|
| `baseline` | No bot messages appear at all |
| `public-llm` | Whole group sees the nudge (📢 badge); classifications recorded (check the contributions export) |
| `private-llm` | Only the dominant participant sees the nudge (🔒 badge); classifications recorded |

## 5. Verify Admin Data

In the admin dashboard:

- [ ] Sessions list updates after refresh
- [ ] Session detail (Overview → expand a session) shows condition, bot mode,
      participants (as tracking-token prefixes — no names are collected), room
      id, and counts of messages, nudges, behavior events, classifications,
      and ranking edits
- [ ] The intervention audit (mode, targets, quiet members, contribution
      split, message text) is present in the nudge-events export
      (`/api/export/interventions`) or the full JSON dump — the dashboard
      itself only shows counts
- [ ] Results tab shows the pilot session in the per-condition descriptives
- [ ] Overview-tab downloads work: **Research Data (CSV)** zip and, under
      Advanced, the **Full data dump** JSON
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
