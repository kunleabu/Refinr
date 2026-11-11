# Credit security cutover — staged, not yet executed

## Important
The GitHub code and SQL migrations are proposals until deployed, applied, and verified.
Do not enable `REFINR_ATOMIC_CREDITS_ENABLED`, `REFINR_ATOMIC_PURCHASES_ENABLED` or `REFINR_SERVER_CHARGED_SEARCH` until the database functions exist and end-to-end tests pass.
Do not revoke profile UPDATE while the legacy debit API remains in use.

## Ordered rollout
1. Take a database backup and record current credits and transactions. Review both staged SQL migrations for compatibility with the production schema.
2. Apply `20261110000100_atomic_credit_debit_STAGED.sql` and `20261110000200_atomic_credit_purchase_STAGED.sql` in Supabase SQL Editor. This adds tables/functions but does not revoke existing permissions.
3. Confirm backend deployment, API tests, Paystack verified payment tests and database idempotency tests in a staging project. Confirm the new RPCs cannot be executed with a normal authenticated JWT.
4. Switch all three flags to true together on a tested deployment, and verify successful full search, no-results search, insufficient balance, duplicate search request ID, purchase, duplicate payment callback, and failed payment handling.
5. **Immediately restrict direct authenticated writes** in the same maintenance window:
```sql
BEGIN;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM authenticated;
REVOKE UPDATE ON TABLE public.profiles FROM authenticated;
-- Only re-enable profile editing with specific safe columns after verifying application usage:
-- GRANT UPDATE (full_name) ON TABLE public.profiles TO authenticated;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.credit_transactions;
COMMIT;
```
Check PUBLIC grants and other inherited roles too; do not assume the above alone suffices.
6. Verify signed-in users can SELECT their own credits and history but cannot PATCH `profiles.credits` or POST `credit_transactions`.
7. Test Paystack webhook retries, parallel credit requests, direct API calls, and confirm no duplicate ledger entries.

## Remaining concerns / release blockers
- Existing legacy client credit calls for verification and deep-dive still send arbitrary amount/description. The staged atomic debit API accepts those amounts; server must determine prices from trusted action identifiers before considering billing secure.
- Search charging occurs after retrieval and formatting. If response delivery fails after a successful debit, the same request ID must be reused by the caller on retry; current clients create a new ID on each new search action.
- The Paystack manual verify action takes a client-supplied user ID and must be authenticated and tied to the verified payer before release.
- The Paystack legacy path is not transactional and should be retired only after atomic purchase RPC is live.
- Inspect all direct Supabase write paths and profile columns before restricting UPDATE.
- The research-session action route is separate; it must remain disabled in production until independently secured.
- Validate server-side search authorization for all continuation and non-legacy action paths.

**Production status: NOT CERTIFIED SECURE.** Do not invite paid testers until release blockers are closed.
