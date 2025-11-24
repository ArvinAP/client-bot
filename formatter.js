function safe(v) {
  return (v === undefined || v === null || String(v).trim() === "") ? "N/A" : String(v);
}

function formatFormMessage(data) {
  const email = safe(data["Email"]);
  const discord = safe(data["Discord username or other contact"]);
  const org = safe(data["What is the name of your game and company/team name "]);
  const tz = safe(data["What country or timezone are you in?"]);
  const name = safe(data["What is the name you want to be called?"]);

  const lines = [];

  function pushQA(label, value) {
    lines.push(`**${label}:**`);
    const parts = String(value).split("\n");
    parts.forEach((p) => lines.push(`-# ${p}`));
  }

  pushQA("Email", email);
  pushQA("Discord Username", discord);
  pushQA("Game / Company", org);
  pushQA("Timezone", tz);
  pushQA("Preferred Name", name);

  const known = new Set([
    "Email",
    "Discord username or other contact",
    "What is the name of your game and company/team name ",
    "What country or timezone are you in?",
    "What is the name you want to be called?",
  ]);

  // Append any extra fields that are not part of the known set
  Object.keys(data).forEach((key) => {
    if (!known.has(key)) {
      const v = safe(data[key]);
      lines.push(`**${key}:**`);
      String(v).split("\n").forEach((p) => lines.push(`-# ${p}`));
    }
  });

  // Render with no extra blank lines
  return lines.join("\n");
}

module.exports = { formatFormMessage };
