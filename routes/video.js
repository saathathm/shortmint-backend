const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { processVideo, checkStatus } = require('../lib/n8n')
const { authenticateJWT } = require('../middleware/auth')

// Start processing a video URL
router.post('/process', authenticateJWT, async (req, res) => {
  try {
    const { video_url, style } = req.body
    const client = req.client

    if (!video_url) return res.status(400).json({ error: 'video_url is required' })
    if (!style || !['crop', 'blur', 'custom'].includes(style)) {
      return res.status(400).json({ error: 'style must be crop, blur, or custom' })
    }

    // Check plan is active
    if (client.plan === 'cancelled') {
      return res.status(403).json({ error: 'Your account has been cancelled. Please contact support.' })
    }

    // Check usage limit
    if (client.usage_hours_used >= client.usage_hours_limit) {
      return res.status(403).json({ error: 'You have reached your monthly usage limit. Please upgrade your plan.' })
    }

    // Call n8n webhook
    const { data } = await processVideo(video_url, client.id, style)
    return res.json(data)
  } catch (err) {
    console.error('Process video error:', err)
    return res.status(500).json({ error: 'Failed to start processing. Please try again.' })
  }
})

// Check processing status
router.get('/status/:videoId', authenticateJWT, async (req, res) => {
  try {
    const { videoId } = req.params
    const { data } = await checkStatus(videoId)
    return res.json(data)
  } catch (err) {
    console.error('Check status error:', err)
    return res.status(500).json({ error: 'Failed to check status' })
  }
})

// Get video history
router.get('/history', authenticateJWT, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('videos')
      .select('*, clips(id, publish_status)')
      .eq('client_id', req.client.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) return res.status(500).json({ error: 'Failed to load history' })
    return res.json({ videos: data })
  } catch (err) {
    console.error('History error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// Get video results (clips for a specific video)
router.get('/results/:videoId', authenticateJWT, async (req, res) => {
  try {
    const { videoId } = req.params

    const { data: video, error: vError } = await supabase
      .from('videos')
      .select('*')
      .eq('id', videoId)
      .eq('client_id', req.client.id)
      .single()

    if (vError || !video) return res.status(404).json({ error: 'Video not found' })

    const { data: clips, error: cError } = await supabase
      .from('clips')
      .select('*')
      .eq('video_id', videoId)
      .order('batch_id', { ascending: false })
      .order('clip_number', { ascending: true })

    if (cError) return res.status(500).json({ error: 'Failed to load clips' })
    return res.json({ video, clips })
  } catch (err) {
    console.error('Results error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
