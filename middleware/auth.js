const jwt = require("jsonwebtoken");
const supabase = require("../lib/supabase");

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Missing or invalid authorization header" });
    }

    const token = authHeader.split(" ")[1];

    // Verify signature + expiry — jwt.verify throws on any failure
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    } catch (e) {
      const msg = e.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
      return res.status(401).json({ error: msg });
    }

    if (!decoded?.sub) {
      return res.status(401).json({ error: "Invalid token" });
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
    return res.status(401).json({ error: "Authentication failed" });
  }
};

module.exports = { authenticateJWT };
