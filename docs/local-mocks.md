# Local setup with mock integrations

Requires Docker Desktop running Linux containers. On Windows, run from the repo:

```powershell
powershell -ExecutionPolicy Bypass -File infra/start-local.ps1
```

Open http://localhost:3000/local-demo.html for three fresh mock Prolific links,
or http://localhost:3000 for direct participants. Admin is http://localhost:3003.
All published ports bind to 127.0.0.1. Data lives in separate `gdm-local` Docker volumes.

The local-only Node preload intercepts Anthropic and Prolific fetch requests.
It cannot load unless GDM_ENV=development. Production source and workflow are unchanged.
AI classification is deterministic keyword matching, nudges are templated, and
moderation (if enabled) flags the literal `[mock-abuse]` marker. Prolific submission
IDs and participant IDs must be the same 24-character hexadecimal string, with
study ID `aaaaaaaaaaaaaaaaaaaaaaaa`. The demo page generates these automatically.
Return, bonus preparation and payment actions return simulated successes.
Mock Prolific API state is not a full Prolific emulator: submission lookups always
report ACTIVE, while the app persists outcomes and action history in its local DB.
Unknown external integration routes return errors rather than contacting the real API.

The startup script fills empty completion and exit URLs with the local demo page.
Existing settings are preserved. Real study credentials are unnecessary.

Stop without deleting data:

```powershell
cd infra
docker compose -p gdm-local --env-file .env -f docker-compose.yml -f docker-compose.local.yml down
```

Test the mock boundary with `node --test infra/local-mocks.test.cjs`.
