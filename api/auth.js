import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
)

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const { action, email, password, full_name } = req.body

    if (!action || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' })
    }

    try {
        // SIGN UP
        if (action === 'signup') {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: { full_name: full_name || '' }
                }
            })

            if (error) {
                return res.status(400).json({ error: error.message })
            }

            return res.status(200).json({
                message: 'Account created successfully',
                user: {
                    id: data.user?.id,
                    email: data.user?.email
                },
                session: data.session
            })
        }

        // SIGN IN
        if (action === 'signin') {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password
            })

            if (error) {
                return res.status(400).json({ error: error.message })
            }

            // Get user profile with credits
            const { data: profile } = await supabase
                .from('profiles')
                .select('credits, full_name, referral_code')
                .eq('id', data.user.id)
                .single()

            return res.status(200).json({
                message: 'Signed in successfully',
                user: {
                    id: data.user.id,
                    email: data.user.email,
                    full_name: profile?.full_name || '',
                    credits: profile?.credits ?? 5,
                    referral_code: profile?.referral_code || ''
                },
                session: data.session
            })
        }

        // SIGN OUT
        if (action === 'signout') {
            const { error } = await supabase.auth.signOut()
            if (error) {
                return res.status(400).json({ error: error.message })
            }
            return res.status(200).json({ message: 'Signed out successfully' })
        }

        // GET PROFILE
        if (action === 'profile') {
            const token = req.headers.authorization?.replace('Bearer ', '')
            if (!token) {
                return res.status(401).json({ error: 'No token provided' })
            }

            const { data: { user }, error } = await supabase.auth.getUser(token)
            if (error || !user) {
                return res.status(401).json({ error: 'Invalid token' })
            }

            const { data: profile } = await supabase
                .from('profiles')
                .select('credits, full_name, referral_code, total_verifications, created_at')
                .eq('id', user.id)
                .single()

            return res.status(200).json({
                user: {
                    id: user.id,
                    email: user.email,
                    full_name: profile?.full_name || '',
                    credits: profile?.credits ?? 5,
                    referral_code: profile?.referral_code || '',
                    total_verifications: profile?.total_verifications || 0,
                    member_since: profile?.created_at
                }
            })
        }

        return res.status(400).json({ error: 'Invalid action' })

    } catch (error) {
        return res.status(500).json({ error: `Server error: ${error.message}` })
    }
}
