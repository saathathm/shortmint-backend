const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { publishClip, applyCustomBg } = require('../lib/n8n')
const { authenticateJWT } = require('../middleware/auth')

// Publish clip to YouTube/Facebook
router.post('/publish', authenticateJWT, async (req, res) => {
  try {
    const { clip_id, platform } = req.body
    const client = req.client

    if (!clip_id || !platform) return res.status(400).json({ error: 'clip_id and platform are required' })
    if (!['youtube', 'facebook', 'both'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be youtube, facebook, or both' })
    }

    // Verify clip belongs to this client
    const { data: clip, error } = await supabase
      .from('clips')
      .select('id, client_id, publish_status')
      .eq('id', clip_id)
      .eq('client_id', client.id)
      .single()

    if (error || !clip) return res.status(404).json({ error: 'Clip not found' })
    if (clip.publish_status === 'published') return res.status(400).json({ error: 'Clip already published' })

    // Check platform credentials
    if ((platform === 'youtube' || platform === 'both') && !client.youtube_access_token) {
      return res.status(403).json({ error: 'YouTube account not connected. Please connect it in Settings.' })
    }
    if ((platform === 'facebook' || platform === 'both') && !client.facebook_access_token) {
      return res.status(403).json({ error: 'Facebook account not connected. Please connect it in Settings.' })
    }

    const { data } = await publishClip(clip_id, client.id, platform)
    return res.json(data)
  } catch (err) {
    console.error('Publish error:', err)
    return res.status(500).json({ error: 'Failed to publish. Please try again.' })
  }
})

// Apply custom background to a clip
router.post('/custom-bg', authenticateJWT, async (req, res) => {
  try {
    const { clip_id, bg_image } = req.body
    const client = req.client

    if (!clip_id || !bg_image) return res.status(400).json({ error: 'clip_id and bg_image are required' })

    // Verify clip belongs to this client
    const { data: clip, error } = await supabase
      .from('clips')
      .select('id, client_id')
      .eq('id', clip_id)
      .eq('client_id', client.id)
      .single()

    if (error || !clip) return res.status(404).json({ error: 'Clip not found' })

    const { data } = await applyCustomBg(clip_id, client.id, bg_image)
    return res.json(data)
  } catch (err) {
    console.error('Custom BG error:', err)
    return res.status(500).json({ error: 'Failed to apply background. Please try again.' })
  }
})

// Update clip title/description
router.patch('/:clipId', authenticateJWT, async (req, res) => {
  try {
    const { clipId } = req.params
    const { title, description } = req.body

    const { data, error } = await supabase
      .from('clips')
      .update({ title, description })
      .eq('id', clipId)
      .eq('client_id', req.client.id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: 'Failed to update clip' })
    return res.json({ clip: data })
  } catch (err) {
    console.error('Update clip error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// Poll clip for custom_bg_url (used by UI after applying custom BG)
router.get('/:clipId/bg-status', authenticateJWT, async (req, res) => {
  try {
    const { clipId } = req.params
    const { data, error } = await supabase
      .from('clips')
      .select('preview_url, custom_bg_url')
      .eq('id', clipId)
      .eq('client_id', req.client.id)
      .single()

    if (error) return res.status(404).json({ error: 'Clip not found' })
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
