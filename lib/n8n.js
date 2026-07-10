const axios = require('axios')

const n8n = axios.create({
  baseURL: process.env.N8N_BASE_URL,
  timeout: 30000,
})

const processVideo = (videoUrl, clientId, style, videoId, startSeconds, endSeconds, videoInfo) =>
  n8n.post('/webhook/process-video',
    {
      video_url: videoUrl,
      client_id: clientId,
      style,
      video_id: videoId,
      start_seconds: startSeconds || 0,
      end_seconds: endSeconds || null,
      video_info: videoInfo || null
    }
  )

const processUploadedVideo = (filePath, clientId, style, videoInfo) =>
  n8n.post('/webhook/process-video', { file_path: filePath, client_id: clientId, style, video_info: videoInfo })

const checkStatus = (videoId) =>
  n8n.get(`/webhook/check-status?video_id=${videoId}`)

const publishClip = (clipId, clientId, platform) =>
  n8n.post('/webhook/publish-clip', { clip_id: clipId, client_id: clientId, platform })

const applyCustomBg = (clipId, clientId, bgImageBase64) =>
  n8n.post('/webhook/apply-custom-bg', { clip_id: clipId, client_id: clientId, bg_image: bgImageBase64 })

module.exports = { processVideo, processUploadedVideo, checkStatus, publishClip, applyCustomBg }
