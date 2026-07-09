const { createClient } = require('@supabase/supabase-js')

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const supabase = require('../lib/supabase')

const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' })
    }

    const token = authHeader.split(' ')[1]

    // Use Supabase to validate token — works for both HS256 and ES256
    const { data, error } = await supabaseAuth.auth.getUser(token)

    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    // Fetch client row
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', data.user.id)
      .single()

    if (clientError || !client) {
      return res.status(401).json({ error: 'Client not found' })
    }

    req.user = data.user
    req.client = client
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed', detail: err.message })
  }
}

module.exports = { authenticateJWT }