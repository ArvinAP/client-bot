import { useEffect, useState, Fragment } from 'react';
import NavBar from '../components/NavBar';

export default function ServerPage() {
  const base = process.env.NEXT_PUBLIC_API_URL;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null); // guildId currently saving

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${base}/guilds`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setItems(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggleClient(g) {
    const next = !g.isClient;
    // optimistic UI
    setItems((prev) => prev.map((x) => (x.guildId === g.guildId ? { ...x, isClient: next } : x)));
    setSaving(g.guildId);
    try {
      const res = await fetch(`${base}/guilds/${encodeURIComponent(g.guildId)}/client`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next, updatedBy: 'dashboard' }),
      });
      if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
    } catch (e) {
      // revert on error
      setItems((prev) => prev.map((x) => (x.guildId === g.guildId ? { ...x, isClient: g.isClient } : x)));
      alert(e.message || 'Failed to save');
    } finally {
      setSaving(null);
    }
  }

  return (
    <Fragment>
      <NavBar />
      <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 28, marginBottom: 8 }}>Servers</h1>
        <p style={{ opacity: 0.8, marginBottom: 16 }}>View servers connected to the bot and toggle client capabilities.</p>

        {loading && <p>Loading…</p>}
        {error && <p style={{ color: 'crimson' }}>Failed to load: {error}</p>}

        {!loading && !error && (
          <div style={{ display: 'grid', gap: 12 }}>
            {(items || []).length === 0 ? (
              <div style={{ opacity: 0.7 }}>No servers yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                    <th style={{ padding: 8 }}>Guild</th>
                    <th style={{ padding: 8 }}>Default Channel</th>
                    <th style={{ padding: 8 }}>Client</th>
                    <th style={{ padding: 8 }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((g) => (
                    <tr key={g.guildId} style={{ borderBottom: '1px solid #f2f2f2' }}>
                      <td style={{ padding: 8 }}>
                        <div style={{ fontWeight: 600 }}>{g.guildName || '(unnamed server)'}</div>
                        <div style={{ opacity: 0.7, fontSize: 12 }}>{g.guildId}</div>
                      </td>
                      <td style={{ padding: 8 }}>
                        {g.defaultChannelId ? (
                          <span>
                            {g.defaultChannelName ? `#${g.defaultChannelName}` : '(channel)'}
                            <span style={{ opacity: 0.6, marginLeft: 6, fontSize: 12 }}>({g.defaultChannelId})</span>
                          </span>
                        ) : (
                          <span style={{ opacity: 0.7 }}>Not set</span>
                        )}
                      </td>
                      <td style={{ padding: 8 }}>
                        <button
                          onClick={() => toggleClient(g)}
                          disabled={saving === g.guildId}
                          style={{
                            padding: '6px 10px',
                            borderRadius: 6,
                            border: '1px solid #ddd',
                            background: g.isClient ? '#e6ffed' : '#fff',
                            cursor: 'pointer',
                          }}
                        >
                          {saving === g.guildId ? 'Saving…' : g.isClient ? 'Enabled' : 'Disabled'}
                        </button>
                      </td>
                      <td style={{ padding: 8 }}>
                        <span style={{ opacity: 0.8, fontSize: 12 }}>
                          {g.updatedAt ? new Date(g.updatedAt).toLocaleString() : ''}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </main>
    </Fragment>
  );
}
