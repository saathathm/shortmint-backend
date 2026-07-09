const jwt = require('jsonwebtoken')
const supabase = require('../lib/supabase')

const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' })
    }

    const token = authHeader.split(' ')[1]

    // Verify using Supabase JWT secret
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET)

    // Fetch client row using service role (bypasses RLS)
    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', decoded.sub)
      .single()

    if (error || !client) {
      return res.status(401).json({ error: 'Client not found' })
    }

    req.user = decoded
    req.client = client
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' })
    }
    return res.status(401).json({ error: 'Invalid token' })
  }
}

module.exports = { authenticateJWT }
