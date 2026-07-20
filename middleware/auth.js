const supabase = require('../lib/supabase')

const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' })
    }

    const token = authHeader.split(' ')[1]

    // Validate token using shared supabase instance
    const { data, error } = await supabase.auth.getUser(token)

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
      // Auto-create client row for new OAuth users
      const name = data.user.user_metadata?.full_name ||
        data.user.user_metadata?.name ||
        data.user.email

      const { data: newClient, error: createError } = await supabase
        .from('clients')
        .upsert({
          id: data.user.id,
          name,
          email: data.user.email,
          password_hash: 'managed_by_supabase_auth',
          plan: 'trial',
          usage_hours_used: 0,
        }, { onConflict: 'id' })
        .select()
        .single()

      if (createError || !newClient) {
        return res.status(401).json({ error: 'Could not create client record' })
      }

      req.user = data.user
      req.client = newClient
      return next()
    }

    req.user = data.user
    req.client = client
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed', detail: err.message })
  }
}

module.exports = { authenticateJWT }