-- STAGED ONLY: run after reviewing Paystack verification and the credit debit migration.
-- An atomic, idempotent purchase credit RPC; no permissions are revoked here.
BEGIN;
CREATE TABLE IF NOT EXISTS public.credit_purchase_receipts (
  reference text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount > 0),
  package_id text NOT NULL,
  balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_purchase_reference_length CHECK (length(reference) BETWEEN 4 AND 160)
);
ALTER TABLE public.credit_purchase_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_purchase_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.credit_purchase_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.refinr_credit_purchase(
  p_user_id uuid, p_amount integer, p_reference text, p_package_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_balance integer;
  v_receipt public.credit_purchase_receipts%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount NOT IN (20, 50, 100, 300)
     OR p_reference IS NULL OR length(p_reference) NOT BETWEEN 4 AND 160
     OR p_package_id IS NULL OR length(p_package_id) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'INVALID_PURCHASE';
  END IF;

  SELECT credits INTO v_balance FROM public.profiles
    WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_NOT_FOUND'; END IF;

  SELECT * INTO v_receipt FROM public.credit_purchase_receipts
    WHERE reference = p_reference;
  IF FOUND THEN
    IF v_receipt.user_id <> p_user_id OR v_receipt.amount <> p_amount
       OR v_receipt.package_id <> p_package_id THEN
      RAISE EXCEPTION 'PURCHASE_REFERENCE_CONFLICT';
    END IF;
    RETURN v_balance; -- current balance, which may have changed since purchase
  END IF;

  -- Compatibility with historical Paystack purchases recorded before migration.
  IF EXISTS (
    SELECT 1 FROM public.credit_transactions
      WHERE description = 'paystack_' || p_reference AND type = 'purchase'
  ) THEN
    RAISE EXCEPTION 'LEGACY_PURCHASE_ALREADY_RECORDED';
  END IF;

  UPDATE public.profiles SET credits = credits + p_amount WHERE id = p_user_id;
  INSERT INTO public.credit_transactions (user_id, amount, type, description)
    VALUES (p_user_id, p_amount, 'purchase', 'paystack_' || p_reference);
  INSERT INTO public.credit_purchase_receipts
    (reference, user_id, amount, package_id, balance_after)
    VALUES (p_reference, p_user_id, p_amount, p_package_id, v_balance + p_amount);
  RETURN v_balance + p_amount;
END;
$$;
REVOKE ALL ON FUNCTION public.refinr_credit_purchase(uuid,integer,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refinr_credit_purchase(uuid,integer,text,text)
  TO service_role;
COMMIT;
