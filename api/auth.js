export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { action, email, password, full_name, refresh_token, access_token, provider } = req.body

  if (!action) {
    return res.status(400).json({ error: 'Missing action' })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

  const serviceHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
  }

  try {

    // ── GOOGLE OAUTH ───────────────────────────────────────
    if (action === 'signin' && provider === 'google' && access_token) {
      // Verify the token and get user from Supabase
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${access_token}`, 'apikey': SUPABASE_ANON_KEY }
      })
      const userData = await userRes.json()

      if (!userData.id) {
        return res.status(401).json({ error: 'Invalid Google token' })
      }

      // Check if profile exists
      const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userData.id}&select=credits,full_name,referral_code`,
        { headers: serviceHeaders }
      )
      const profiles = await profileRes.json()
      let profile = profiles[0]

      // Create profile if first time Google signin
      if (!profile) {
        const referralCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase()
        const displayName = userData.user_metadata?.full_name || userData.email?.split('@')[0] || ''
        await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
          method: 'POST',
          headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
          body: JSON.stringify({
            id: userData.id,
            email: userData.email,
            full_name: displayName,
            credits: 5,
            referral_code: referralCode
          })
        })
        profile = { credits: 5, full_name: displayName, referral_code: referralCode }
      }

      return res.status(200).json({
        message: 'Signed in with Google',
        user: {
          id: userData.id,
          email: userData.email,
          full_name: profile.full_name || '',
          credits: profile.credits ?? 5,
          referral_code: profile.referral_code || ''
        }
      })
    }

    // ── EMAIL/PASSWORD VALIDATION ──────────────────────────
    if (action === 'signup' || (action === 'signin' && !provider)) {
      if (!email || !password) {
        return res.status(400).json({ error: 'Missing required fields' })
      }
    }

    // ── SIGNUP ─────────────────────────────────────────────
    if (action === 'signup') {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password, data: { full_name: full_name || '' } })
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

    // ── EMAIL SIGNIN ───────────────────────────────────────
    if (action === 'signin') {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password })
      })
      const data = await response.json()
      if (data.error || !data.access_token) {
        return res.status(400).json({ error: data.error_description || data.error || 'Invalid email or password' })
      }
      const profileResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${data.user.id}&select=credits,full_name,referral_code`,
        { headers: { 'Authorization': `Bearer ${data.access_token}`, 'apikey': SUPABASE_ANON_KEY } }
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
        session: { access_token: data.access_token, refresh_token: data.refresh_token }
      })
    }

    // ── REFRESH ────────────────────────────────────────────
    if (action === 'refresh') {
      if (!refresh_token) return res.status(400).json({ error: 'Missing refresh token' })
      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token })
      })
      const data = await response.json()
      if (data.error || !data.access_token) {
        return res.status(401).json({ error: 'Session expired. Please sign in again.' })
      }
      return res.status(200).json({
        session: { access_token: data.access_token, refresh_token: data.refresh_token }
      })
    }

    // ── SIGNOUT ────────────────────────────────────────────
    if (action === 'signout') {
      const token = req.headers.authorization?.replace('Bearer ', '')
      if (token) {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY }
        })
      }
      return res.status(200).json({ message: 'Signed out successfully' })
    }

    // ── PROFILE ────────────────────────────────────────────
    if (action === 'profile') {
      const token = req.headers.authorization?.replace('Bearer ', '')
      if (!token) return res.status(401).json({ error: 'No token provided' })
      const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY }
      })
      if (!userResponse.ok) return res.status(401).json({ error: 'Invalid token' })
      const user = await userResponse.json()
      const profileResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=credits,full_name,referral_code,total_verifications,created_at`,
        { headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY } }
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
