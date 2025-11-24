require("dotenv").config();
const express = require("express");
/**
 * Creates and starts the Express server.
 * @param {(data: object) => Promise<void>} sendFormDataToDiscord
 */
function createServer(sendFormDataToDiscord) {
    const app = express();
    app.use(express.json());

    app.post("/webhook/form", async (req, res) => {
        try {
            const body = req.body || {};

            // Only require Email; accept and forward all other fields as-is
            const required = [
                "Email",
            ];

            const missing = required.filter((k) => !body[k] || String(body[k]).trim() === "");
            if (missing.length) {
                return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(", ")}` });
            }

            await sendFormDataToDiscord(body);
            return res.status(200).json({ success: true });
        } catch (err) {
            console.error("/webhook/form error:", err.message);
            return res.status(500).json({ success: false, error: "Internal Server Error" });
        }
    });

    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => {
        console.log(`Express listening on port ${port}`);
    });

    return app;
}

module.exports = { createServer };
