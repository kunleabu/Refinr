-- STAGED MIGRATION. Apply in Supabase SQL Editor only after reviewing the deployment plan.
-- This creates a service-role-only atomic debit RPC. It does NOT revoke old grants yet.
BEGIN;
CREATE TABLE IF NOT EXISTS public.credit_debit_requests (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 1000),
  description text NOT NULL,
  balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credit_debit_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_debit_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.credit_debit_requests TO service_role;

CREATE OR REPLACE FUNCTION public.refinr_debit_credits(
  p_user_id uuid, p_amount integer, p_description text, p_request_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_balance integer;
  v_previous public.credit_debit_requests%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF p_user_id IS NULL OR p_request_id IS NULL
     OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 1000
     OR p_description IS NULL OR length(p_description) NOT BETWEEN 1 AND 250 THEN
    RAISE EXCEPTION 'INVALID_DEBIT';
  END IF;

  -- Lock the profile first, so concurrent requests for one user serialize.
  SELECT credits INTO v_balance FROM public.profiles
    WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_NOT_FOUND'; END IF;

  SELECT * INTO v_previous FROM public.credit_debit_requests
    WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_previous.user_id <> p_user_id OR v_previous.amount <> p_amount
       OR v_previous.description <> p_description THEN
      RAISE EXCEPTION 'REQUEST_ID_CONFLICT';
    END IF;
    RETURN v_previous.balance_after;
  END IF;

  IF v_balance < p_amount THEN RAISE EXCEPTION 'INSUFFICIENT_CREDITS'; END IF;
  UPDATE public.profiles SET credits = credits - p_amount WHERE id = p_user_id;
  INSERT INTO public.credit_transactions (user_id, amount, type, description)
    VALUES (p_user_id, -p_amount, 'deduction', p_description);
  INSERT INTO public.credit_debit_requests
    (request_id, user_id, amount, description, balance_after)
    VALUES (p_request_id, p_user_id, p_amount, p_description, v_balance - p_amount);
  RETURN v_balance - p_amount;
END;
$$;
REVOKE ALL ON FUNCTION public.refinr_debit_credits(uuid,integer,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refinr_debit_credits(uuid,integer,text,uuid)
  TO service_role;
COMMIT;

-- SEPARATE CUTOVER (DO NOT RUN UNTIL THE NEW BACKEND IS DEPLOYED AND TESTED):
-- REVOKE UPDATE ON public.profiles FROM authenticated;
-- REVOKE INSERT, UPDATE, DELETE ON public.credit_transactions FROM authenticated;
-- DROP POLICY IF EXISTS "Users can insert own transactions" ON public.credit_transactions;
-- Regrant only safe profile-edit columns after inventorying all profile write paths.
-- Important: table-level UPDATE grants override column-level revokes; inspect both.
