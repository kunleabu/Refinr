module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const { action, amount, description } = req.body
    const token = req.headers.authorization?.replace('Bearer ', '')

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

        if (action === 'deduct') {
            const creditAmount = amount || 1

            if (profile.credits < creditAmount) {
                return res.status(400).json({
                    error: 'Insufficient credits. Please purchase more credits to continue verifying.',
                    credits: profile.credits
                })
            }

            // Deduct credits
           // Deduct credits
const updateResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
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
console.log('Update response status:', updateResponse.status)
console.log('Update response data:', JSON.stringify(updateData))

if (!updateResponse.ok || !updateData || updateData.length === 0) {
    return res.status(500).json({ 
        error: 'Could not update credits',
        details: JSON.stringify(updateData),
        status: updateResponse.status
    })
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
        return res.status(500).json({ error: `Server error: ${error.message}` })
    }
}
