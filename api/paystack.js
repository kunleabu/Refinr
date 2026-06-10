import crypto from 'crypto';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Credit packages with both NGN and USD pricing
const PACKAGES = {
  pack_20:  { credits: 20,  ngn: 200000,  usd: 200,  label: '20 credits'  }, // ₦2,000 / $2
  pack_50:  { credits: 50,  ngn: 400000,  usd: 400,  label: '50 credits'  }, // ₦4,000 / $4
  pack_100: { credits: 100, ngn: 700000,  usd: 700,  label: '100 credits' }, // ₦7,000 / $7
  pack_300: { credits: 300, ngn: 1500000, usd: 1500, label: '300 credits' }, // ₦15,000 / $15
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paystack-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};

  // ── 1. INITIALIZE PAYMENT ──────────────────────────────────────────────────
  if (action === 'initialize') {
    const { package_id, email, user_id, currency } = req.body;

    if (!package_id || !email || !user_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const pkg = PACKAGES[package_id];
    if (!pkg) return res.status(400).json({ error: 'Invalid package' });

    // Use USD for international users, NGN for Nigerian users
    const useCurrency = currency === 'USD' ? 'USD' : 'NGN';
    const amount = useCurrency === 'USD' ? pkg.usd : pkg.ngn;

    try {
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          amount,
          currency: useCurrency,
          metadata: {
            user_id,
            package_id,
            credits: pkg.credits,
            custom_fields: [
              { display_name: 'Package', variable_name: 'package', value: pkg.label }
            ]
          },
          callback_url: 'https://refinr-murex.vercel.app',
        }),
      });

      const data = await response.json();

      if (!data.status) {
        return res.status(500).json({ error: data.message || 'Paystack initialization failed' });
      }

      return res.status(200).json({
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
      });

    } catch (err) {
      console.error('Paystack init error:', err);
      return res.status(500).json({ error: 'Failed to initialize payment' });
    }
  }

  // ── 2. VERIFY PAYMENT (manual recovery) ────────────────────────────────────
  if (action === 'verify') {
    const { reference, user_id } = req.body;

    if (!reference || !user_id) {
      return res.status(400).json({ error: 'Missing reference or user_id' });
    }

    try {
      const ptRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      });
      const ptData = await ptRes.json();

      if (!ptData.status || ptData.data.status !== 'success') {
        return res.status(400).json({ error: 'Payment not successful or not found' });
      }

      const meta = ptData.data.metadata;

      if (meta.user_id !== user_id) {
        return res.status(403).json({ error: 'Reference does not match your account' });
      }

      const credited = await creditUser(user_id, meta.credits, reference, meta.package_id);
      if (!credited.success) {
        return res.status(500).json({ error: credited.error });
      }

      return res.status(200).json({
        success: true,
        credits_added: meta.credits,
        new_balance: credited.new_balance
      });

    } catch (err) {
      console.error('Verify error:', err);
      return res.status(500).json({ error: 'Verification failed' });
    }
  }

  // ── 3. WEBHOOK ──────────────────────────────────────────────────────────────
  if (req.headers['x-paystack-signature']) {
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;

    if (event.event === 'charge.success') {
      const { metadata, status } = event.data;
      if (status !== 'success') return res.status(200).end();
      const { user_id, credits, package_id } = metadata;
      if (!user_id || !credits) return res.status(200).end();
      await creditUser(user_id, credits, event.data.reference, package_id);
    }

    return res.status(200).end();
  }

  return res.status(400).json({ error: 'Unknown action' });
}

// ── SHARED: Add credits to Supabase (idempotent) ───────────────────────────
async function creditUser(user_id, credits, reference, package_id) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Prefer': 'return=representation',
  };

  try {
    // Duplicate check — never credit the same reference twice
    const dupCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/credit_transactions?description=eq.paystack_${reference}&select=id`,
      { headers }
    );
    const dupData = await dupCheck.json();
    if (dupData && dupData.length > 0) {
      const profile = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}&select=credits`,
        { headers }
      );
      const profileData = await profile.json();
      return { success: true, new_balance: profileData[0]?.credits ?? 0 };
    }

    // Get current credits
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}&select=credits`,
      { headers }
    );
    const profileData = await profileRes.json();
    if (!profileData || profileData.length === 0) {
      return { success: false, error: 'User not found' };
    }

    const newBalance = (profileData[0].credits || 0) + parseInt(credits);

    // Update balance
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ credits: newBalance }),
    });

    // Log transaction
    await fetch(`${SUPABASE_URL}/rest/v1/credit_transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id,
        amount: parseInt(credits),
        type: 'purchase',
        description: `paystack_${reference}`,
      }),
    });

    return { success: true, new_balance: newBalance };

  } catch (err) {
    console.error('creditUser error:', err);
    return { success: false, error: err.message };
  }
}
