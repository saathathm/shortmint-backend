const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendMail } = require('../lib/mailer')

router.post('/', async (req, res) => {
  try {
    const { email, content_type } = req.body

    if (!email) return res.status(400).json({ error: 'Email is required' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' })
    }

    // Save to Supabase
    const { error } = await supabase.from('leads').upsert(
      { email, content_type },
      { onConflict: 'email' }
    )

    if (error) {
      console.error('Lead save error:', error.message)
      return res.status(500).json({ error: 'Failed to save. Please try again.' })
    }

    // Notify you
    sendMail({
      to: 'hello@shorttrim.com',
      subject: `New lead: ${email}`,
      html: `
        <div style="font-family: sans-serif; padding: 24px;">
          <h2 style="color: #4F46E5;">New ShortMint Lead</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Content type:</strong> ${content_type || 'Not specified'}</p>
        </div>
      `
    }).catch(err => console.error('Lead email error:', err.message))

    // Send welcome email to lead
    sendMail({
      to: email,
      subject: 'Thanks for your interest in ShortMint 👋',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
          <h1 style="color: #4F46E5; font-size: 22px; margin-bottom: 8px;">Thanks for reaching out!</h1>
          <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
            We got your message and we'll be in touch soon with tips, updates, and creator resources.
          </p>
          <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
            In the meantime — did you know ShortMint has a free trial? No card needed.
          </p>
          <a href="https://shorttrim.com/signup"
            style="display: inline-block; margin-top: 20px; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
            Try ShortMint free →
          </a>
          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
          <p style="color: #9CA3AF; font-size: 13px;">
            — The ShortMint team
          </p>
        </div>
      `
    }).catch(err => console.error('Lead welcome email error:', err.message))

    return res.json({ success: true })
  } catch (err) {
    console.error('Lead error:', err.message)
    return res.status(500).json({ error: 'Something went wrong.' })
  }
})

module.exports = router