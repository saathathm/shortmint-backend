const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const { authenticateJWT } = require("../middleware/auth");
const { sendMail } = require("../lib/mailer");

// Sign up with email + password
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Name, email and password are required" });
    }

    // Create Supabase auth user
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    });

    if (error) return res.status(400).json({ error: error.message });

    // Create clients row
    const { error: clientError } = await supabase.from("clients").upsert(
      {
        id: data.user.id,
        name,
        email,
        password_hash: "managed_by_supabase_auth",
        plan: "trial",
        usage_hours_used: 0,
      },
      { onConflict: "id" },
    );

    if (clientError) console.error("Client upsert error:", clientError.message);

    // Sign in to get session tokens
    const { data: session, error: signInError } =
      await supabase.auth.signInWithPassword({ email, password });
    if (signInError)
      return res.status(400).json({ error: signInError.message });

    const { data: client } = await supabase
      .from("clients")
      .select("*")
      .eq("id", data.user.id)
      .single();

    // Send welcome email — fire and forget
    sendMail({
      to: email,
      subject: "Welcome to ShortMint 🎬",
      html: `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
      <h1 style="color: #4F46E5; font-size: 24px; margin-bottom: 8px;">Welcome to ShortMint, ${name}!</h1>
      <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
        You're all set. Start turning your long videos into viral Shorts in minutes.
      </p>
      <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
        Your free trial includes <strong>15 minutes</strong> of processing — enough to try it out with a real video.
      </p>
      <a href="https://shortmint.addmora.com/dashboard"
        style="display: inline-block; margin-top: 24px; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
        Create your first Shorts →
      </a>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
      <p style="color: #9CA3AF; font-size: 13px;">
        Questions? Just reply to this email or use the chat on our site.<br/>
        — The ShortMint team
      </p>
    </div>
  `,
    }).catch((err) => console.error("Welcome email error:", err.message));

    return res.json({
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
      user: session.user,
      client,
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Sign in with email + password
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return res.status(401).json({ error: error.message });

    const { data: client } = await supabase
      .from("clients")
      .select("*")
      .eq("id", data.user.id)
      .single();

    return res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: data.user,
      client,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get current user + client data
router.get("/me", authenticateJWT, async (req, res) => {
  return res.json({ user: req.user, client: req.client });
});

// Refresh client data (after plan upgrade etc.)
router.get("/refresh-client", authenticateJWT, async (req, res) => {
  const { data: client, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", req.client.id)
    .single();
  if (error)
    return res.status(500).json({ error: "Could not refresh client data" });
  return res.json({ client });
});

// Google OAuth callback handler
router.post("/google-callback", async (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token)
      return res.status(400).json({ error: "Access token required" });

    const { data, error } = await supabase.auth.getUser(access_token);
    if (error || !data.user)
      return res.status(401).json({ error: "Invalid token" });

    // Upsert client row for Google OAuth users
    const name = data.user.user_metadata?.full_name || data.user.email;
    await supabase.from("clients").upsert(
      {
        id: data.user.id,
        name,
        email: data.user.email,
        password_hash: "managed_by_supabase_auth",
        plan: "trial",
        usage_hours_used: 0,
      },
      { onConflict: "id" },
    );

    const { data: client } = await supabase
      .from("clients")
      .select("*")
      .eq("id", data.user.id)
      .single();
    return res.json({ user: data.user, client });
  } catch (err) {
    console.error("Google callback error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Profile Update
router.patch("/profile", authenticateJWT, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });

    const { error } = await supabase
      .from("clients")
      .update({ name })
      .eq("id", req.client.id);

    if (error)
      return res.status(500).json({ error: "Failed to update profile" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/check-provider", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const { data, error } = await supabase.auth.admin.getUserByEmail(email);

    if (error || !data?.user) {
      return res.json({ provider: "email" });
    }

    const user = data.user;

    console.log('User app_metadata:', user.app_metadata)
    console.log('User identities:', user.identities)

    // Check app_metadata first
    const provider =
      user.app_metadata?.provider || user.identities?.[0]?.provider || "email";

    console.log('Provider detected:', provider)

    return res.json({ provider });
  } catch (err) {
    console.error("Check provider error:", err.message);
    return res.json({ provider: "email" });
  }
});

module.exports = router;
