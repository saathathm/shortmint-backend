const supabase = require("../lib/supabase");

const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Missing or invalid authorization header" });
    }

    const token = authHeader.split(" ")[1];

    // Validate via Supabase auth server – handles signature verification,
    // expiry, and key rotation without requiring SUPABASE_JWT_SECRET locally.
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      const msg =
        error?.message?.toLowerCase().includes("expired")
          ? "Token expired"
          : "Invalid token";
      return res.status(401).json({ error: msg });
    }

    const user = data.user;

    // Fetch client row
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("id", user.id)
      .single();

    if (clientError || !client) {
      return res.status(401).json({ error: "Account not found" });
    }

    req.user = {
      id: user.id,
      email: user.email,
      app_metadata: user.app_metadata || {},
    };
    req.client = client;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
};

module.exports = { authenticateJWT };
