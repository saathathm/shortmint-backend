const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const supabase = require('../lib/supabase')
const { processUploadedVideo } = require('../lib/n8n')
const { authenticateJWT } = require('../middleware/auth')

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || '/root/.n8n-files/uploads'
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// Multer config - accept video files up to 500MB
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const uniqueName = `${req.client.id}-${Date.now()}${ext}`
    cb(null, uniqueName)
  }
})

const fileFilter = (req, file, cb) => {
  const allowed = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']
  const ext = path.extname(file.originalname).toLowerCase()
  if (allowed.includes(ext)) {
    cb(null, true)
  } else {
    cb(new Error(`Unsupported file format. Please upload: ${allowed.join(', ')}`), false)
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
})

// Upload video file and trigger processing
router.post('/video', authenticateJWT, upload.single('video'), async (req, res) => {
  try {
    const client = req.client

    if (!req.file) return res.status(400).json({ error: 'No video file provided' })

    const { style } = req.body
    if (!style || !['crop', 'blur', 'custom'].includes(style)) {
      fs.unlinkSync(req.file.path)
      return res.status(400).json({ error: 'style must be crop, blur, or custom' })
    }

    // Check plan and usage
    if (client.plan === 'cancelled') {
      fs.unlinkSync(req.file.path)
      return res.status(403).json({ error: 'Your account has been cancelled.' })
    }

    if (client.usage_hours_used >= client.usage_hours_limit) {
      fs.unlinkSync(req.file.path)
      return res.status(403).json({ error: 'You have reached your monthly usage limit.' })
    }

    // Get video metadata using ffprobe
    let videoInfo = { title: req.file.originalname, duration: 0, id: path.basename(req.file.filename, path.extname(req.file.filename)) }
    try {
      const ffprobeOut = execSync(
        `ffprobe -v quiet -print_format json -show_format "${req.file.path}"`,
        { encoding: 'utf8' }
      )
      const metadata = JSON.parse(ffprobeOut)
      videoInfo.duration = parseFloat(metadata.format?.duration || 0)
      videoInfo.title = metadata.format?.tags?.title || req.file.originalname
    } catch (e) {
      console.warn('ffprobe failed, using defaults:', e.message)
    }

    // Trigger n8n processing with file path
    const { data } = await processUploadedVideo(req.file.path, client.id, style, videoInfo)
    return res.json(data)
  } catch (err) {
    // Clean up file on error
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    console.error('Upload error:', err)
    return res.status(500).json({ error: err.message || 'Upload failed. Please try again.' })
  }
})

module.exports = router
