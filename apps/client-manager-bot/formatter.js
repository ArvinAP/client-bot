function safe(v) {
  return (v === undefined || v === null || String(v).trim() === "") ? "N/A" : String(v);
}

function formatFormMessage(data) {
  const lines = [];
  const formTitle = (data && data._meta && data._meta.formTitle) ? String(data._meta.formTitle) : "";
  if (formTitle) {
    lines.push(`**Form:** ${safe(formTitle)}`);
  }

  function pushQA(label, value) {
    lines.push(`**${label}:**`);
    const parts = String(value).split("\n");
    parts.forEach((p) => lines.push(`-# ${p}`));
  }

  const keys = Object.keys(data || {}).filter((k) => k !== "_meta");
  keys.sort((a, b) => {
    if (a === "Email") return -1;
    if (b === "Email") return 1;
    return a.localeCompare(b);
  });

  keys.forEach((key) => {
    const raw = data[key];
    let val;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      val = "N/A";
    } else if (Array.isArray(raw)) {
      val = raw.join(", ");
    } else if (typeof raw === "object") {
      try {
        const parts = [];
        Object.keys(raw).forEach((k) => {
          const rv = Array.isArray(raw[k]) ? raw[k].join(", ") : String(raw[k]);
          parts.push(`${k}: ${rv}`);
        });
        val = parts.length ? parts.join("\n") : JSON.stringify(raw);
      } catch (_) {
        try { val = JSON.stringify(raw); } catch { val = String(raw); }
      }
    } else {
      val = String(raw);
    }
    const display = safe(val);
    // Skip fields that are not provided (empty or marked Unknown)
    if (display === "N/A" || String(display).trim().toLowerCase() === "unknown") {
      return;
    }
    pushQA(key, display);
  });

  // Render with no extra blank lines
  return lines.join("\n");
}

module.exports = { formatFormMessage };
