const jwt = require("jsonwebtoken");

const authenticateAffiliate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.affiliate = jwt.verify(token, process.env.AFFILIATE_JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

module.exports = { authenticateAffiliate };
