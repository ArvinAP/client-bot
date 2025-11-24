function safe(v) {
  return (v === undefined || v === null || String(v).trim() === "") ? "" : String(v);
}

function formatFormMessage(data) {
  const lines = [];
  const reserved = new Set(["_meta", "guildId", "channelId"]);

  function pushQA(label, value) {
    lines.push(`**${label}:**`);
    const parts = String(value).split("\n");
    parts.forEach((p) => lines.push(`-# ${p}`));
  }

  // Only include fields that have values; skip reserved/metadata keys
  Object.keys(data || {}).forEach((key) => {
    if (reserved.has(key)) return;
    const val = safe(data[key]);
    if (!val) return; // skip empty
    pushQA(key, val);
  });

  // If nothing was included, at least echo a receipt line
  if (!lines.length) {
    lines.push("**Submission Received:**");
    lines.push("-# (no non-empty fields)");
  }

  return lines.join("\n");
}

module.exports = { formatFormMessage };
