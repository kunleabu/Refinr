const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
)

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const { action, amount, description } = req.body
    const token = req.headers.authorization?.replace('Bearer ', '')

    if (!token) return res.status(401).json({ error: 'Not authenticated' })

    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token)
        if (authError || !user) return res.status(401).json({ error: 'Invalid token' })

        const { data: profile } = await supabase
            .from('profiles')
            .select('credits')
            .eq('id', user.id)
            .single()

        if (!profile) return res.status(500).json({ error: 'Could not fetch credits' })

        if (action === 'deduct') {
            const creditAmount = amount || 1
            if (profile.credits < creditAmount) {
                return res.status(400).json({ error: 'Insufficient credits', credits: profile.credits })
            }

            await supabase
                .from('profiles')
                .update({ credits: profile.credits - creditAmount })
                .eq('id', user.id)

            await supabase
                .from('credit_transactions')
                .insert({
                    user_id: user.id,
                    amount: -creditAmount,
                    type: 'deduction',
                    description: description || 'Verification'
                })

            return res.status(200).json({ success: true, credits: profile.credits - creditAmount })
        }

        if (action === 'balance') {
            return res.status(200).json({ credits: profile.credits })
        }

        return res.status(400).json({ error: 'Invalid action' })

    } catch (error) {
        return res.status(500).json({ error: `Server error: ${error.message}` })
    }
}
