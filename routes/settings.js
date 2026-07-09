const express = require('express')
const router = express.Router()
const axios = require('axios')
const supabase = require('../lib/supabase')
const { authenticateJWT } = require('../middleware/auth')

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const REDIRECT_URI = `${process.env.FRONTEND_URL}/api/settings/youtube-callback`

// Get YouTube OAuth URL (frontend calls this to get the redirect URL)
router.get('/youtube-connect-url', authenticateJWT, async (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube'
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: req.client.id
  })

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  return res.json({ auth_url: authUrl })
})

// YouTube OAuth callback - handles the redirect from Google
router.get('/youtube-callback', async (req, res) => {
  const { code, state: clientId, error } = req.query

  if (error || !code || !clientId) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?youtube=error`)
  }

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })

    const { access_token, refresh_token, expires_in } = tokenRes.data

    // Get YouTube channel ID
    const channelRes = await axios.get(
      'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',
      { headers: { Authorization: `Bearer ${access_token}` } }
    )
    const channelId = channelRes.data.items?.[0]?.id || ''

    // Save to Supabase
    const expiry = new Date(Date.now() + expires_in * 1000).toISOString()
    await supabase.from('clients').update({
      youtube_access_token: access_token,
      youtube_refresh_token: refresh_token,
      youtube_token_expiry: expiry,
      youtube_channel_id: channelId
    }).eq('id', clientId)

    return res.redirect(`${process.env.FRONTEND_URL}/settings?youtube=connected`)
  } catch (err) {
    console.error('YouTube callback error:', err.message)
    return res.redirect(`${process.env.FRONTEND_URL}/settings?youtube=error`)
  }
})

// Disconnect YouTube
router.post('/youtube-disconnect', authenticateJWT, async (req, res) => {
  await supabase.from('clients').update({
    youtube_access_token: null,
    youtube_refresh_token: null,
    youtube_token_expiry: null,
    youtube_channel_id: null
  }).eq('id', req.client.id)

  return res.json({ success: true })
})

module.exports = router
