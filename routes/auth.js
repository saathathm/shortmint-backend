const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { authenticateJWT } = require('../middleware/auth')

// Sign up with email + password
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' })
    }

    // Create Supabase auth user
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name }
    })

    if (error) return res.status(400).json({ error: error.message })

    // Create clients row
    const { error: clientError } = await supabase.from('clients').upsert({
      id: data.user.id,
      name,
      email,
      password_hash: 'managed_by_supabase_auth',
      plan: 'trial',
      usage_hours_used: 0,
    }, { onConflict: 'id' })

    if (clientError) console.error('Client upsert error:', clientError.message)

    // Sign in to get session tokens
    const { data: session, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) return res.status(400).json({ error: signInError.message })

    const { data: client } = await supabase.from('clients').select('*').eq('id', data.user.id).single()

    return res.json({
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
      user: session.user,
      client
    })
  } catch (err) {
    console.error('Signup error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// Sign in with email + password
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return res.status(401).json({ error: error.message })

    const { data: client } = await supabase.from('clients').select('*').eq('id', data.user.id).single()

    return res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: data.user,
      client
    })
  } catch (err) {
    console.error('Login error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// Get current user + client data
router.get('/me', authenticateJWT, async (req, res) => {
  return res.json({ user: req.user, client: req.client })
})

// Refresh client data (after plan upgrade etc.)
router.get('/refresh-client', authenticateJWT, async (req, res) => {
  const { data: client, error } = await supabase.from('clients').select('*').eq('id', req.client.id).single()
  if (error) return res.status(500).json({ error: 'Could not refresh client data' })
  return res.json({ client })
})

// Google OAuth callback handler
router.post('/google-callback', async (req, res) => {
  try {
    const { access_token } = req.body
    if (!access_token) return res.status(400).json({ error: 'Access token required' })

    const { data, error } = await supabase.auth.getUser(access_token)
    if (error || !data.user) return res.status(401).json({ error: 'Invalid token' })

    // Upsert client row for Google OAuth users
    const name = data.user.user_metadata?.full_name || data.user.email
    await supabase.from('clients').upsert({
      id: data.user.id,
      name,
      email: data.user.email,
      password_hash: 'managed_by_supabase_auth',
      plan: 'trial',
      usage_hours_used: 0,
    }, { onConflict: 'id' })

    const { data: client } = await supabase.from('clients').select('*').eq('id', data.user.id).single()
    return res.json({ user: data.user, client })
  } catch (err) {
    console.error('Google callback error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
