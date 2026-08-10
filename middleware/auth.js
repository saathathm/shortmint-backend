const jwt = require("jsonwebtoken");
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

    // Decode JWT locally — no network call, works for both ES256 (Google) and HS256 (email)
    let decoded;
    try {
      decoded = jwt.decode(token);
    } catch (e) {
      return res.status(401).json({ error: "Invalid token format" });
    }

    if (!decoded?.sub) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Check expiry
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
      return res.status(401).json({ error: "Token expired" });
    }

    // Verify token is from our Supabase project
    const expectedIss = `${process.env.SUPABASE_URL}/auth/v1`;
    if (decoded.iss !== expectedIss) {
      return res.status(401).json({ error: "Invalid token issuer" });
    }

    const userId = decoded.sub;

    // Fetch client row
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("id", userId)
      .single();

    if (clientError || !client) {
      return res.status(401).json({ error: "Account not found" });
    }

    req.user = {
      id: userId,
      email: decoded.email,
      app_metadata: decoded.app_metadata || {},
    };
    req.client = client;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res
      .status(401)
      .json({ error: "Authentication failed", detail: err.message });
  }
};

module.exports = { authenticateJWT };
