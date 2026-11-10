# Production database verification (read-only)

Run the SQL below in the **production Supabase project's SQL Editor**. It only reads PostgreSQL catalog metadata; it does not create, change, or delete data. Do not paste credentials, service-role keys, or user records into chat. Share only the query results.

This is a prerequisite, **not** evidence that the research migration has been deployed. The existing `20261007000100_research_sessions_phase2a.sql` is explicitly marked as an unexecuted review proposal.

```sql
-- 1. Presence of the core billing and research tables.
SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relkind AS object_kind, c.relrowsecurity AS rls_enabled
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('profiles', 'credit_transactions',
                    'research_sessions', 'research_retrievals',
                    'research_session_papers', 'research_paper_aliases')
  AND c.relkind IN ('r','p')
ORDER BY c.relname;

-- 2. Non-sensitive column definitions needed to design an atomic debit.
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('profiles', 'credit_transactions')
  AND column_name IN ('id', 'user_id', 'credits', 'amount', 'type',
                      'description', 'created_at', 'request_id')
ORDER BY table_name, ordinal_position;

-- 3. Function names/signatures only (not function bodies).
SELECT p.proname AS function_name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
       p.prosecdef AS security_definer
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'research_%'
       OR p.proname IN ('create_research_session', 'begin_research_pull',
                       'complete_research_pull', 'deduct_credits',
                       'charge_credits', 'consume_credits'))
ORDER BY p.proname;

-- 4. Credit table constraints and indexes (names and definitions only).
SELECT t.relname AS table_name, con.conname AS constraint_name,
       pg_catalog.pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname IN ('profiles', 'credit_transactions')
ORDER BY t.relname, con.conname;

-- 5. Credit-table triggers, without accessing customer data.
SELECT event_object_table AS table_name, trigger_name,
       event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table IN ('profiles', 'credit_transactions')
ORDER BY event_object_table, trigger_name;
```

## Decision gate

- If the research tables are absent, do **not** enable production research sessions.
- Do **not** deploy a credit RPC until the balance and ledger schemas, permissions, constraints, and existing triggers are reviewed.
- The existing client-driven credit deduction followed by search is **not** a complete authorization boundary. Full-search authorization, idempotent debit, and a failure policy must be designed together.
- After review: add a transaction-safe, idempotent database function; connect it to server-controlled search; test retries, concurrent calls, zero results, provider failure, and auth expiry before rollout.
