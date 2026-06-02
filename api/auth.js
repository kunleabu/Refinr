export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const { action, email, password, full_name } = req.body

    if (!action || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' })
    }

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

    try {
        if (action === 'signup') {
            const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY
                },
                body: JSON.stringify({
                    email,
                    password,
                    data: { full_name: full_name || '' }
                })
            })

            const data = await response.json()

            if (data.error || data.msg) {
                return res.status(400).json({ error: data.error?.message || data.msg || 'Signup failed' })
            }

            return res.status(200).json({
                message: 'Account created successfully',
                user: { id: data.user?.id, email: data.user?.email },
                session: data.session
            })
        }

        if (action === 'signin') {
            const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY
                },
                body: JSON.stringify({ email, password })
            })

            const data = await response.json()

            if (data.error || !data.access_token) {
                return res.status(400).json({ error: data.error_description || data.error || 'Invalid email or password' })
            }

            // Get profile with credits
            const profileResponse = await fetch(
                `${SUPABASE_URL}/rest/v1/profiles?id=eq.${data.user.id}&select=credits,full_name,referral_code`,
                {
                    headers: {
                        'Authorization': `Bearer ${data.access_token}`,
                        'apikey': SUPABASE_ANON_KEY
                    }
                }
            )

            const profiles = await profileResponse.json()
            const profile = profiles[0]

            return res.status(200).json({
                message: 'Signed in successfully',
                user: {
                    id: data.user.id,
                    email: data.user.email,
                    full_name: profile?.full_name || '',
                    credits: profile?.credits ?? 5,
                    referral_code: profile?.referral_code || ''
                },
                session: {
                    access_token: data.access_token,
                    refresh_token: data.refresh_token
                }
            })
        }

        if (action === 'signout') {
            const token = req.headers.authorization?.replace('Bearer ', '')
            if (token) {
                await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'apikey': SUPABASE_ANON_KEY
                    }
                })
            }
            return res.status(200).json({ message: 'Signed out successfully' })
        }

        if (action === 'profile') {
            const token = req.headers.authorization?.replace('Bearer ', '')
            if (!token) return res.status(401).json({ error: 'No token provided' })

            const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'apikey': SUPABASE_ANON_KEY
                }
            })

            if (!userResponse.ok) return res.status(401).json({ error: 'Invalid token' })

            const user = await userResponse.json()

            const profileResponse = await fetch(
                `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=credits,full_name,referral_code,total_verifications,created_at`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'apikey': SUPABASE_ANON_KEY
                    }
                }
            )

            const profiles = await profileResponse.json()
            const profile = profiles[0]

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
