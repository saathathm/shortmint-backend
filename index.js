require('dotenv').config()
const express = require('express')
const cors = require('cors')

const authRoutes = require('./routes/auth')
const videoRoutes = require('./routes/video')
const uploadRoutes = require('./routes/upload')
const clipsRoutes = require('./routes/clips')
const stripeRoutes = require('./routes/stripe')
const settingsRoutes = require('./routes/settings')

const app = express()
const PORT = process.env.PORT || 3001

// CORS
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://shortmint.addmora.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

// Stripe webhook needs raw body — must be before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))

// JSON body parser for everything else
app.use(express.json({ limit: '10mb' }))

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'ShortMint Backend', timestamp: new Date().toISOString() })
})

const jwt = require('jsonwebtoken')

app.post('/api/debug/token', async (req, res) => {
  const { token } = req.body
  try {
    const decoded = jwt.decode(token)
    res.json({ 
      decoded,
      secret_length: process.env.SUPABASE_JWT_SECRET?.length,
      secret_first_10: process.env.SUPABASE_JWT_SECRET?.substring(0, 10)
    })
  } catch (e) {
    res.json({ error: e.message })
  }
})

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/video', videoRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/clips', clipsRoutes)
app.use('/api/stripe', stripeRoutes)
app.use('/api/settings', settingsRoutes)

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 500MB.' })
  }
  res.status(500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`ShortMint backend running on port ${PORT}`)
})
