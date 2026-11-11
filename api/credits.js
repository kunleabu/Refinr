export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const { action, amount, description } = req.body || {}
    // Reject negative, fractional, non-numeric and oversized deductions before any database access.
    // Never trust the client to provide a safe debit amount.
    if (action === 'deduct' && (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000)) {
        return res.status(400).json({ error: 'Invalid credit amount' })
    }
    // Never accept a caller-selected debit price. Derive it from a recognized operation.
    // This guards the legacy endpoint and the feature-gated atomic path alike.
    if (action === 'deduct') {
        const verification = typeof description === 'string'
            ? /^Reference verification \\(([1-9][0-9]*) references\\)$/.exec(description)
            : null
        const expected = verification
            ? (() => {
                const count = Number(verification[1])
                if (!Number.isSafeInteger(count) || count > 10000) return null
                return count <= 20 ? 1 : count <= 50 ? 2 : count <= 100 ? 3 : 4
            })()
            : typeof description === 'string' && description.startsWith('Search by idea: ') && description.length <= 66
                ? 2
                : typeof description === 'string' && description.startsWith('Deep dive analysis — ') && description.length <= 250
                    ? 10
                    : null
        if (expected === null || amount !== expected) {
            return res.status(400).json({ error: 'Invalid credit operation or amount' })
        }
    }
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')
    const token = match?.[1]

    if (!token) return res.status(401).json({ error: 'Not authenticated' })

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

    try {
        // Verify token and get user
        const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'apikey': SUPABASE_ANON_KEY
            }
        })

        if (!userResponse.ok) {
            return res.status(401).json({ error: 'Invalid token' })
        }

        const user = await userResponse.json()
        const userId = user.id

        // Get current credits
        const profileResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=credits`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'apikey': SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json'
                }
            }
        )

        const profiles = await profileResponse.json()
        const profile = profiles[0]

        if (!profile) {
            return res.status(500).json({ error: 'Could not fetch profile' })
        }

        if (action === 'deduct' && process.env.REFINR_ATOMIC_CREDITS_ENABLED === 'true') {
            const requestId = req.body?.requestId
            if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
                return res.status(400).json({ error: 'A valid request ID is required' })
            }
            if (typeof description !== 'string' || !description.trim() || description.length > 250) {
                return res.status(400).json({ error: 'Invalid credit description' })
            }
            const serviceKey = process.env.SUPABASE_SERVICE_KEY
            if (!serviceKey) return res.status(503).json({ error: 'Credits temporarily unavailable' })
            const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refinr_debit_credits`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${serviceKey}`,
                    'apikey': serviceKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    p_user_id: userId, p_amount: amount,
                    p_description: description.trim(), p_request_id: requestId
                })
            })
            if (!rpc.ok) {
                const detail = await rpc.json().catch(() => ({}))
                if (detail.message === 'INSUFFICIENT_CREDITS') {
                    return res.status(400).json({ error: 'Insufficient credits' })
                }
                if (detail.message === 'REQUEST_ID_CONFLICT') {
                    return res.status(409).json({ error: 'Request ID already used for a different operation' })
                }
                console.error('Atomic credit debit failed:', rpc.status, detail.code)
                return res.status(503).json({ error: 'Credit operation unavailable. Please try again.' })
            }
            const balance = await rpc.json()
            return res.status(200).json({ success: true, credits: balance })
        }

        if (action === 'deduct') {
            const creditAmount = amount

            if (profile.credits < creditAmount) {
                return res.status(400).json({
                    error: 'Insufficient credits. Please purchase more credits to continue verifying.',
                    credits: profile.credits
                })
            }

            // Deduct credits
           // Deduct credits
const updateResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&credits=eq.${profile.credits}`,
    {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'apikey': SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify({ credits: profile.credits - creditAmount })
    }
)

const updateData = await updateResponse.json()
if (!updateResponse.ok) {
    return res.status(503).json({ error: 'Could not update credits. Please retry.' })
}
if (!Array.isArray(updateData) || updateData.length !== 1) {
    // Another request changed the balance after it was read; never overwrite it.
    return res.status(409).json({ error: 'Credit balance changed. Please retry.' })
}

            // Log transaction
            await fetch(`${SUPABASE_URL}/rest/v1/credit_transactions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'apikey': SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                    user_id: userId,
                    amount: -creditAmount,
                    type: 'deduction',
                    description: description || 'Verification'
                })
            })

            return res.status(200).json({
                success: true,
                credits: profile.credits - creditAmount
            })
        }

        if (action === 'balance') {
            return res.status(200).json({ credits: profile.credits })
        }

        return res.status(400).json({ error: 'Invalid action' })

    } catch (error) {
        console.error('Credits API error:', error.message)
        return res.status(503).json({ error: 'Credits temporarily unavailable. Please try again.' })
    }
}
