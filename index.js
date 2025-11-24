require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { formatFormMessage } = require("./formatter");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.login(process.env.TOKEN);

client.once("ready", () => {
    console.log(`Bot logged in as ${client.user.tag}`);
});

async function sendFormDataToDiscord(data) {
    try {
        const channelId = process.env.TARGET_CHANNEL;
        if (!channelId) throw new Error("TARGET_CHANNEL is not set");

        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) throw new Error("Target channel not found or not text-based");

        const message = formatFormMessage(data);

        // Split message into chunks (<=2000 chars) while keeping question/answer pairs together
        const MAX = 2000;
        const lines = message.split("\n");

        // Build logical blocks: pair '**Title:**' with next '-# answer' line when present
        const blocks = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("**") && i + 1 < lines.length && lines[i + 1].startsWith("-# ")) {
                blocks.push(line + "\n" + lines[i + 1]);
                i++;
            } else {
                blocks.push(line);
            }
        }

        const chunks = [];
        let buf = "";
        for (const block of blocks) {
            const addition = (buf ? "\n" : "") + block;
            if ((buf + addition).length > MAX) {
                if (buf) {
                    chunks.push(buf);
                    buf = "";
                }
                if (block.length > MAX) {
                    // As a last resort, hard-split very long single block (rare)
                    let start = 0;
                    while (start < block.length) {
                        chunks.push(block.slice(start, start + MAX));
                        start += MAX;
                    }
                } else {
                    buf = block;
                }
            } else {
                buf = buf + addition;
            }
        }
        if (buf) chunks.push(buf);

        for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
                // Add a small continuation marker before subsequent chunks
                await channel.send({ content: "(cont.)" });
            }
            await channel.send({ content: chunks[i] });
        }
        console.log(`Form submission forwarded to Discord in ${chunks.length} message(s)`);
    } catch (err) {
        console.error("Failed to send form data to Discord:", err.message);
        throw err;
    }
}

module.exports = { sendFormDataToDiscord };

// Start Express server and inject the sender
try {
    const { createServer } = require("./server");
    createServer(sendFormDataToDiscord);
} catch (e) {
    console.error("Failed to start server:", e.message);
}
