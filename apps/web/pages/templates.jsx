import { useEffect, useMemo, useState, Fragment } from 'react';
import NavBar from '../components/NavBar';

export default function TemplatesPage() {
  const base = process.env.NEXT_PUBLIC_API_URL;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', timeZone: '', remindOffsetMinutes: '', mentionHere: false });

  async function fetchTemplates() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${base}/templates`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setItems(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchTemplates(); }, []);

  async function onCreate(e) {
    e.preventDefault();
    if (!form.name.trim()) { alert('Name is required'); return; }
    try {
      setBusy(true);
      const payload = {
        name: form.name,
        description: form.description || undefined,
        timeZone: form.timeZone || undefined,
        remindOffsetMinutes: form.remindOffsetMinutes !== '' ? Number(form.remindOffsetMinutes) : undefined,
        mentionHere: !!form.mentionHere,
      };
      const res = await fetch(`${base}/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setForm({ name: '', description: '', timeZone: '', remindOffsetMinutes: '', mentionHere: false });
      await fetchTemplates();
    } catch (err) {
      alert(err.message || 'Failed to create template');
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id) {
    if (!confirm('Delete this template?')) return;
    try {
      await fetch(`${base}/templates/${id}`, { method: 'DELETE' });
      await fetchTemplates();
    } catch (_) { alert('Failed to delete'); }
  }

  return (
    <Fragment>
      <NavBar />
      <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>Templates</h1>

        <form onSubmit={onCreate} style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr auto', alignItems: 'end', marginBottom: 16 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 12, opacity: 0.8 }}>Name*</label>
            <input value={form.name} onChange={(e)=>setForm({ ...form, name: e.target.value })} placeholder="Playtest" required style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 12, opacity: 0.8 }}>Time Zone</label>
            <input value={form.timeZone} onChange={(e)=>setForm({ ...form, timeZone: e.target.value })} placeholder="Asia/Manila" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 12, opacity: 0.8 }}>Remind Offset (min)</label>
            <input type="number" min="0" value={form.remindOffsetMinutes} onChange={(e)=>setForm({ ...form, remindOffsetMinutes: e.target.value })} placeholder="15" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 12, opacity: 0.8 }}>Description</label>
            <input value={form.description} onChange={(e)=>setForm({ ...form, description: e.target.value })} placeholder="Default description" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={form.mentionHere} onChange={(e)=>setForm({ ...form, mentionHere: e.target.checked })} />
            @here
          </label>
          <button type="submit" disabled={busy} style={{ padding: '10px 14px', borderRadius: 6, border: '1px solid #ddd', background: busy ? '#eee' : '#f7f7f7', cursor: busy ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Creating…' : 'Create Template'}
          </button>
        </form>

        {loading && <p>Loading…</p>}
        {error && <p style={{ color: 'crimson' }}>Failed to load: {error}</p>}

        {!loading && !error && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {items.map((t) => (
              <li key={t.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div style={{ opacity: 0.8, fontSize: 12 }}>{t.updatedAt ? new Date(t.updatedAt).toLocaleString() : ''}</div>
                </div>
                <div style={{ marginTop: 6, fontSize: 13 }}>
                  <div style={{ opacity: 0.8 }}>TZ: {t.timeZone || '—'} | Offset: {typeof t.remindOffsetMinutes === 'number' ? `${t.remindOffsetMinutes}m` : '—'} | {t.mentionHere ? '@here' : ''}</div>
                  {t.description ? (<div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{t.description}</div>) : null}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button onClick={()=>onDelete(t.id)} style={{ border: '1px solid #e00', background: '#ffecec', color: '#900', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </Fragment>
  );
}
