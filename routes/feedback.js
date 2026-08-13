const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");
const { authenticateJWT } = require("../middleware/auth");
const { sendMail } = require("../lib/mailer");

router.post("/", authenticateJWT, async (req, res) => {
  try {
    const { video_id, rating, comment } = req.body;
    const clientId = req.client.id;

    if (!rating) return res.status(400).json({ error: "Rating is required" });

    const { error } = await supabase.from("feedback").insert({
      client_id: clientId,
      video_id: video_id || null,
      rating,
      comment: comment || null,
    });

    if (error) {
      console.error("Feedback save error:", error.message);
      return res.status(500).json({ error: "Failed to save feedback" });
    }

    // Notify you only for bad feedback
    if (rating === "bad") {
      sendMail({
        to: "hello@shorttrim.com",
        subject: `⚠️ Bad feedback from ${req.client.email}`,
        html: `
          <div style="font-family: sans-serif; padding: 24px;">
            <h2 style="color: #EF4444;">Bad Feedback Received</h2>
            <p><strong>User:</strong> ${req.client.name} (${req.client.email})</p>
            <p><strong>Video ID:</strong> ${video_id || "N/A"}</p>
            <p><strong>Comment:</strong> ${comment || "No comment left"}</p>
          </div>
        `,
      }).catch((err) => console.error("Feedback email error:", err.message));
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Feedback error:", err.message);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

router.get("/:videoId", authenticateJWT, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("feedback")
      .select("id")
      .eq("client_id", req.client.id)
      .eq("video_id", req.params.videoId)
      .maybeSingle();

    if (error) {
      console.error("Feedback check error:", error.message);
      return res.json({ exists: false });
    }

    return res.json({ exists: !!data });
  } catch (err) {
    console.error("Feedback check error:", err.message);
    return res.json({ exists: false });
  }
});

module.exports = router;
