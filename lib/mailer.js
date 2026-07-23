const nodemailer = require('nodemailer')

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
})

const sendMail = async ({ to, subject, html }) => {
  await transporter.sendMail({
    from: `"ShortMint" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  })
}

module.exports = { sendMail }