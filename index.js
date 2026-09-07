require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')

const authRoutes = require('./routes/auth')
const videoRoutes = require('./routes/video')
const uploadRoutes = require('./routes/upload')
const clipsRoutes = require('./routes/clips')
const stripeRoutes = require('./routes/stripe')
const settingsRoutes = require('./routes/settings')
const leadsRoutes = require('./routes/leads')
const feedbackRoutes = require('./routes/feedback')

const app = express()
const PORT = process.env.PORT || 3001

// Security headers
app.use(helmet())

// CORS
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://shorttrim.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

// Rate limiting — strict on auth, lenient on everything else
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
})

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
})

app.use('/api/auth/login', authLimiter)
app.use('/api/auth/signup', authLimiter)
app.use('/api', generalLimiter)

// Stripe webhook needs raw body — must be before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))

// JSON body parser for everything else
app.use(express.json({ limit: '10mb' }))

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'ShortTrim Backend', timestamp: new Date().toISOString() })
})

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/video', videoRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/clips', clipsRoutes)
app.use('/api/stripe', stripeRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/leads', leadsRoutes)
app.use('/api/feedback', feedbackRoutes)

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// Global error handler — never expose internal details in production
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 500MB.' })
  }
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err.message || 'Internal server error')
  res.status(500).json({ error: message })
})

const server = app.listen(PORT, () => {
  console.log(`ShortTrim backend running on port ${PORT}`)
})

// Graceful shutdown on SIGTERM (PM2 stop/restart)
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully')
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})
