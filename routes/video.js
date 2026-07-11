const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { processVideo } = require('../lib/n8n')
const { authenticateJWT } = require('../middleware/auth')

// Platform tier access control
const PLATFORM_TIERS = {
  trial: ['youtube', 'upload'],
  starter: ['youtube', 'upload'],
  growth: ['youtube', 'facebook', 'instagram', 'upload'],
  pro: ['youtube', 'facebook', 'instagram', 'vimeo', 'tiktok', 'rumble', 'loom', 'dropbox', 'upload'],
}

const PLATFORM_PATTERNS = [
  {
    name: 'youtube', pattern: /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  },
  {
    name: 'facebook', pattern: /(?:https?:\/\/)?(?:www\.|web\.|m\.)?facebook\.com\/(?:.*\/videos\/|watch\/?\?v=|reel\/|share\/r\/|share\/v\/)([0-9a-zA-Z_-]+)|(?:https?:\/\/)?fb\.watch\/([0-9a-zA-Z_-]+)/
  },
  {
    name: 'instagram', pattern: /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/
  },
  {
    name: 'vimeo', pattern: /vimeo\.com\/(?:video\/)?(\d+)/
  },
  {
    name: 'tiktok', pattern: /(?:tiktok\.com\/@[\w.]+\/video\/|vm\.tiktok\.com\/|vt\.tiktok\.com\/)([A-Za-z0-9]+)/
  },
  {
    name: 'rumble', pattern: /rumble\.com\/(?:v|embed)\/([a-zA-Z0-9_-]+)/
  },
  {
    name: 'loom', pattern: /loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/
  },
  {
    name: 'dropbox', pattern: /dropbox\.com\/s\/([a-zA-Z0-9]+)/
  },
]

const detectPlatform = (url) => {
  try { new URL(url) } catch { return null }
  const match = PLATFORM_PATTERNS.find(p => p.pattern.test(url))
  return match?.name || null
}

// POST /api/video/process
router.post('/process', authenticateJWT, async (req, res) => {
  try {
    const { video_url, style, start_seconds, end_seconds, video_info } = req.body
    const client = req.client

    // Validate inputs
    if (!video_url) {
      return res.status(400).json({ error: 'Please enter a video URL.' })
    }
    if (!style || !['crop', 'blur', 'custom'].includes(style)) {
      return res.status(400).json({ error: 'Please select a valid style: crop, blur, or custom.' })
    }

    // Validate URL format
    try { new URL(video_url) } catch {
      return res.status(400).json({ error: 'Please enter a valid video URL.' })
    }

    // Detect platform
    const platform = detectPlatform(video_url)
    if (!platform) {
      return res.status(400).json({
        error: 'This URL is not supported. Please use a YouTube, Facebook, Instagram, Vimeo, TikTok, Rumble, Loom, or Dropbox link.'
      })
    }

    // Check plan is active
    if (client.plan === 'cancelled') {
      return res.status(403).json({
        error: 'Your account is inactive. Please contact support at hello@addmora.com.'
      })
    }

    // Check platform access
    const allowedPlatforms = PLATFORM_TIERS[client.plan] || PLATFORM_TIERS['trial']
    if (!allowedPlatforms.includes(platform)) {
      const planNeeded = Object.entries(PLATFORM_TIERS).find(([, platforms]) =>
        platforms.includes(platform)
      )?.[0]
      return res.status(403).json({
        error: `${platform.charAt(0).toUpperCase() + platform.slice(1)} is not available on your ${client.plan} plan. Upgrade to ${planNeeded || 'a higher plan'} to use this platform.`,
        upgrade_required: true
      })
    }

    // Check usage limit
    const hoursUsed = parseFloat(client.usage_hours_used) || 0
    const hoursLimit = parseFloat(client.usage_hours_limit) || 0
    if (hoursUsed >= hoursLimit) {
      return res.status(403).json({
        error: `You've used all ${hoursLimit} hours in your ${client.plan} plan this month. Upgrade to get more hours.`,
        upgrade_required: true
      })
    }

    // Validate selected range usage
    if (start_seconds !== undefined && end_seconds !== undefined) {
      const selectedHours = (end_seconds - start_seconds) / 3600
      const hoursRemaining = hoursLimit - hoursUsed
      if (selectedHours > hoursRemaining) {
        return res.status(403).json({
          error: `This selection uses ${selectedHours.toFixed(2)} hrs but you only have ${hoursRemaining.toFixed(2)} hrs remaining. Adjust the range or upgrade your plan.`,
          upgrade_required: true
        })
      }
    } else if (video_info?.duration) {
      const fullHours = parseFloat(video_info.duration) / 3600
      const hoursRemaining = hoursLimit - hoursUsed
      if (fullHours > hoursRemaining) {
        return res.status(403).json({
          error: `This video uses ${fullHours.toFixed(2)} hrs but you only have ${hoursRemaining.toFixed(2)} hrs remaining. Upgrade your plan.`,
          upgrade_required: true
        })
      }
    }

    // Create video row immediately
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .insert({
        client_id: client.id,
        youtube_url: video_url,
        style,
        status: 'pending',
        title: video_info?.title || null,
        duration_minutes: video_info?.duration ? parseFloat(video_info.duration) / 60 : null,
        video_id: video_info?.id || null,
      })
      .select()
      .single()

    if (videoError || !video) {
      console.error('Failed to create video row:', videoError?.message)
      return res.status(500).json({ error: 'Failed to start processing. Please try again.', message: videoError?.message || null })
    }

    // Fire n8n webhook without waiting
    processVideo(video_url, client.id, style, video.id, start_seconds, end_seconds, video_info).catch((err) => {
      console.log('n8n connection closed (expected):', err.message)
    })

    // Return immediately with video_id
    return res.json({
      status: 'processing',
      video_id: video.id
    })

  } catch (err) {
    console.error('Process video error:', err)
    return res.status(500).json({ error: 'Something went wrong. Please try again.', message: err.message || null })
  }
})

const { execSync } = require('child_process')

// GET /api/video/info?url=...
router.get('/info', authenticateJWT, async (req, res) => {
  try {
    const { url } = req.query
    if (!url) return res.status(400).json({ error: 'URL is required' })

    try { new URL(url) } catch {
      return res.status(400).json({ error: 'Invalid URL format' })
    }

    const output = execSync(
      `yt-dlp --no-playlist --dump-json "${url}"`,
      { encoding: 'utf8', timeout: 30000 }
    )

    const data = JSON.parse(output)

    return res.json({
      title: data.title || 'Untitled',
      duration: data.duration || 0,
      thumbnail: data.thumbnail || null,
      webpage_url: data.webpage_url || url,
      id: data.id || null,
      platform: data.extractor_key?.toLowerCase() || 'unknown'
    })
  } catch (err) {
    console.error('Video info error:', err.message)
    if (err.message?.includes('private') || err.message?.includes('login')) {
      return res.status(400).json({ error: 'This video is private or requires login.', message: err.message || null })
    }
    if (err.message?.includes('not found') || err.message?.includes('404')) {
      return res.status(400).json({ error: 'Video not found. Please check the URL.', message: err.message || null })
    }
    return res.status(400).json({ error: 'Could not fetch video info. Check the URL and try again.', message: err.message || null })
  }
})

// GET /api/video/status/:videoId
router.get('/status/:videoId', authenticateJWT, async (req, res) => {
  try {
    const { videoId } = req.params

    const { data: video, error: vError } = await supabase
      .from('videos')
      .select('*')
      .eq('id', videoId)
      .eq('client_id', req.client.id)
      .single()

    if (vError || !video) {
      return res.status(404).json({ error: 'Video not found.' })
    }

    if (video.status === 'completed') {
      const { data: clips } = await supabase
        .from('clips')
        .select('*')
        .eq('video_id', videoId)
        .order('clip_number', { ascending: true })

      return res.json({
        video_id: video.id,
        status: video.status,
        title: video.title,
        style: video.style,
        error_message: null,
        clips: clips || []
      })
    }

    return res.json({
      video_id: video.id,
      status: video.status,
      title: video.title || null,
      style: video.style,
      error_message: video.status === 'failed' ? video.error_message : null,
      clips: []
    })

  } catch (err) {
    console.error('Status error:', err)
    return res.status(500).json({ error: 'Failed to check status.', message: err.message || null })
  }
})

// GET /api/video/history
router.get('/history', authenticateJWT, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('videos')
      .select('*, clips(id, publish_status)')
      .eq('client_id', req.client.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) return res.status(500).json({ error: 'Failed to load history.', message: error.message || null })
    return res.json({ videos: data })
  } catch (err) {
    console.error('History error:', err)
    return res.status(500).json({ error: 'Internal server error.', message: err.message || null })
  }
})

// GET /api/video/results/:videoId
router.get('/results/:videoId', authenticateJWT, async (req, res) => {
  try {
    const { videoId } = req.params

    const { data: video, error: vError } = await supabase
      .from('videos')
      .select('*')
      .eq('id', videoId)
      .eq('client_id', req.client.id)
      .single()

    if (vError || !video) return res.status(404).json({ error: 'Video not found.', message: vError?.message || null })

    const { data: clips } = await supabase
      .from('clips')
      .select('*')
      .eq('video_id', videoId)
      .order('batch_id', { ascending: false })
      .order('clip_number', { ascending: true })

    return res.json({ video, clips: clips || [] })
  } catch (err) {
    console.error('Results error:', err)
    return res.status(500).json({ error: 'Internal server error.', message: err.message || null })
  }
})

// DELETE /api/video/:videoId
router.delete('/:videoId', authenticateJWT, async (req, res) => {
  try {
    const { videoId } = req.params

    // Verify ownership
    const { data: video } = await supabase
      .from('videos')
      .select('id')
      .eq('id', videoId)
      .eq('client_id', req.client.id)
      .single()

    if (!video) return res.status(404).json({ error: 'Video not found.' })

    // Delete clips first (cascade)
    await supabase.from('clips').delete().eq('video_id', videoId)
    await supabase.from('videos').delete().eq('id', videoId)

    return res.json({ success: true })
  } catch (err) {
    console.error('Delete error:', err)
    return res.status(500).json({ error: 'Failed to delete video.', message: err.message || null })
  }
})



module.exports = router