const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const { authenticateJWT } = require('../middleware/auth')

const uploadDir = process.env.UPLOAD_DIR || '/root/.n8n-files/uploads'
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

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
  if (allowed.includes(ext)) cb(null, true)
  else cb(new Error(`Unsupported file format. Please upload: ${allowed.join(', ')}`), false)
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 }
})

// POST /api/upload/video — upload file, return metadata only (no processing)
router.post('/video', authenticateJWT, upload.single('video'), async (req, res) => {
  try {
    const client = req.client
    if (!req.file) return res.status(400).json({ error: 'No video file provided' })

    // Check plan
    if (client.plan === 'cancelled') {
      fs.unlinkSync(req.file.path)
      return res.status(403).json({ error: 'Your account has been cancelled.' })
    }

    // Get video metadata using ffprobe
    let duration = 0
    let title = req.file.originalname.replace(/\.[^/.]+$/, '')

    try {
      const ffprobeOut = execSync(
        `ffprobe -v quiet -print_format json -show_format "${req.file.path}"`,
        { encoding: 'utf8', timeout: 30000 }
      )
      const metadata = JSON.parse(ffprobeOut)
      duration = Math.floor(parseFloat(metadata.format?.duration || 0))
      if (metadata.format?.tags?.title) title = metadata.format.tags.title
    } catch (e) {
      console.warn('ffprobe failed:', e.message)
    }

    // Return upload info — processing happens separately via /api/video/process
    return res.json({
      upload_id: req.file.filename,
      file_path: req.file.path,
      file_name: req.file.originalname,
      duration,
      title,
      size: req.file.size
    })
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    console.error('Upload error:', err)
    return res.status(500).json({ error: err.message || 'Upload failed. Please try again.' })
  }
})

// DELETE /api/upload/:uploadId — delete uploaded file
router.delete('/:uploadId', authenticateJWT, async (req, res) => {
  try {
    const { uploadId } = req.params

    // Security — only allow deleting files belonging to this client
    if (!uploadId.startsWith(req.client.id)) {
      return res.status(403).json({ error: 'Not allowed' })
    }

    const filePath = path.join(uploadDir, uploadId)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      return res.json({ success: true })
    }

    return res.json({ success: true }) // already gone
  } catch (err) {
    console.error('Delete upload error:', err)
    return res.status(500).json({ error: 'Failed to delete file.' })
  }
})

module.exports = router