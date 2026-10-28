# Local PostgreSQL regression tests

These preserve all 25 focused tests from the approved Phase 2A hardening review. They are separate from the unchanged 31 Phase 1 Node tests and from the manual, live Supabase staging checklist in `docs/phase2a-staging-validation.md`.

Run from the repository root:

```sh
node --test tests/*.test.mjs
./tests/postgres/run-local.sh
```

The second command needs Docker, Python 3 with venv, and package/image download access on its first run. It installs pinned test-only dependencies into an ephemeral directory, creates a new local PostgreSQL container with a random loopback-only port, bootstraps minimal Auth/roles, applies the reviewed research migration, runs 16 static checks and all 25 database tests, then removes its container/database/temporary dependencies. It does not read Supabase credentials or use the Supabase CLI. Its pinned image matches the PostgreSQL 16.15 image used in the review. No production data or users are copied. The anonymous container volume is removed by Docker's `--rm` lifecycle. Docker/pip download caches may remain.

`check_migration.py` provides database-free SQL/PLpgSQL parsing and boundary checks. `test_research_sessions.py` uses Python unittest plus psycopg, refuses non-loopback hosts and any database other than `refinr_phase2a_review`, and creates/deletes local fixture users. For an existing disposable LOCAL database only, it accepts `RESEARCH_TEST_DSN`. Never point it at a tunnel or remote Supabase project. The runner always overrides an inherited DSN to its own container.

The assertions are preserved from the review; only the migration path and explanatory module header were adapted. They cover retries/idempotency/leases with actual competing connections, exact DOI/provider/bibliographic identity, ambiguity/conflicts, lifecycle-preserving upgrades, privilege denial, ownership and deletion. One concurrency test verifies both retry connections are blocked on a held session lock before releasing them. Expiry is simulated ONLY in local test receipts. The 5-second statement timeout is test-only, not a Vercel/migration configuration change.

These tests do not simulate Supabase Auth token verification, PostgREST, existing profile/credit triggers, or the Vercel runtime. Do not run this local bootstrap/test code against Supabase staging; follow its dedicated checklist. Live staging tests are intentionally not part of the default Node or local PostgreSQL suites.

The migration is a review/validation candidate, not an authorization to deploy. Do not run `supabase db push` from a checkout linked to any production project. Remote migration execution requires separately confirmed staging identity and explicit approval.
