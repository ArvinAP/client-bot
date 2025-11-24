import { useEffect, useMemo, useState, Fragment } from 'react';
import NavBar from '../components/NavBar';
import Head from 'next/head';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';

export default function CalendarPage() {
  const [items, setItems] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState({ title: '', type: '', startsAt: '', endsAt: '', timeZone: '', description: '', remindOffsetMinutes: '', mentionHere: false });
  const [busy, setBusy] = useState(false);

  function applyTemplateDefaultsByName(name) {
    if (!name) return;
    const t = (templates || []).find(x => (x.name || '').toLowerCase() === String(name).toLowerCase());
    if (!t) return;
    setForm((prev) => ({
      ...prev,
      // Only fill if empty to avoid overwriting user-entered values
      description: prev.description || (t.description || ''),
      timeZone: prev.timeZone || (t.timeZone || ''),
      remindOffsetMinutes: prev.remindOffsetMinutes !== '' ? prev.remindOffsetMinutes : (typeof t.remindOffsetMinutes === 'number' ? String(t.remindOffsetMinutes) : ''),
      mentionHere: prev.mentionHere || !!t.mentionHere,
    }));
  }

  const base = process.env.NEXT_PUBLIC_API_URL;

  async function fetchEvents() {
    try {
      setLoading(true);
      setError(null);
      const [resE, resT] = await Promise.all([
        fetch(`${base}/events`, { cache: 'no-store' }),
        fetch(`${base}/templates`, { cache: 'no-store' }),
      ]);
      if (!resE.ok) throw new Error(`HTTP ${resE.status}`);
      if (!resT.ok) throw new Error(`HTTP ${resT.status}`);
      const jsonE = await resE.json();
      const jsonT = await resT.json();
      setItems(Array.isArray(jsonE.items) ? jsonE.items : []);
      setTemplates(Array.isArray(jsonT.items) ? jsonT.items : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchEvents();
  }, []);

  const events = useMemo(() => {
    return items
      .filter((it) => it.startsAt)
      .map((it) => ({
        id: it.id,
        title: it.title || 'Event',
        start: it.startsAt,
        end: it.endsAt || undefined,
        allDay: false,
      }));
  }, [items]);

  const selected = useMemo(() => items.find((x) => x.id === selectedId) || null, [items, selectedId]);
  const [edit, setEdit] = useState(false);
  const [editForm, setEditForm] = useState({ title: '', type: '', startsAt: '', endsAt: '', timeZone: '', description: '' });

  useEffect(() => {
    if (selected) {
      setEdit(false);
      setEditForm({
        title: selected.title || '',
        type: selected.type || '',
        startsAt: selected.startsAt ? new Date(selected.startsAt).toISOString().slice(0,16) : '', // yyyy-MM-ddTHH:mm
        endsAt: selected.endsAt ? new Date(selected.endsAt).toISOString().slice(0,16) : '',
        timeZone: selected.timeZone || '',
        description: selected.description || '',
      });
    }
  }, [selected]);

  function onEventClick(info) {
    const id = info?.event?.id;
    if (id) setSelectedId(id);
  }

  async function onCreate(e) {
    e.preventDefault();
    if (!form.title || !form.startsAt) {
      alert('Title and Starts At are required');
      return;
    }
    try {
      setBusy(true);
      const payload = {
        title: form.title,
        type: form.type || undefined,
        startsAt: new Date(form.startsAt).toISOString(),
        description: form.description || undefined,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : undefined,
        timeZone: form.timeZone || undefined,
        remindOffsetMinutes: form.remindOffsetMinutes !== '' ? Number(form.remindOffsetMinutes) : undefined,
        mentionHere: form.mentionHere === true ? true : undefined,
      };
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setForm({ title: '', type: '', startsAt: '', endsAt: '', timeZone: '', description: '', remindOffsetMinutes: '', mentionHere: false });
      await fetchEvents();
    } catch (err) {
      alert(err.message || 'Failed to create event');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Fragment>
      <NavBar />
      <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <Head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.10/index.global.min.css"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@fullcalendar/daygrid@6.1.10/index.global.min.css"
        />
      </Head>

      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Calendar</h1>

      {/* Create Event Form */}
      <form onSubmit={onCreate} style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr  auto', alignItems: 'end', marginBottom: 16 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Type (optional)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={form.type} onChange={(e)=>setForm({ ...form, type: e.target.value })} style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6, minWidth: 180 }}>
              <option value="">— Select Template —</option>
              {(templates||[]).map(t => (
                <option key={t.id} value={t.name}>{t.name}</option>
              ))}
            </select>
            <button type="button" onClick={()=>applyTemplateDefaultsByName(form.type)} style={{ border: '1px solid #ddd', background: '#f7f7f7', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Apply Defaults</button>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Title*</label>
          <input value={form.title} onChange={(e)=>setForm({ ...form, title: e.target.value })} placeholder="Playtest" required style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Starts At* (local)</label>
          <input type="datetime-local" value={form.startsAt} onChange={(e)=>setForm({ ...form, startsAt: e.target.value })} required style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Ends At (optional)</label>
          <input type="datetime-local" value={form.endsAt} onChange={(e)=>setForm({ ...form, endsAt: e.target.value })} style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Time Zone (optional)</label>
          <input value={form.timeZone} onChange={(e)=>setForm({ ...form, timeZone: e.target.value })} placeholder="Asia/Manila" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Description</label>
          <input value={form.description} onChange={(e)=>setForm({ ...form, description: e.target.value })} placeholder="Internal testing" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, opacity: 0.8 }}>Remind Offset (min)</label>
          <input type="number" min="0" value={form.remindOffsetMinutes} onChange={(e)=>setForm({ ...form, remindOffsetMinutes: e.target.value })} placeholder="15" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={form.mentionHere} onChange={(e)=>setForm({ ...form, mentionHere: e.target.checked })} />
          @here
        </label>
        <button type="submit" disabled={busy} style={{ padding: '10px 14px', borderRadius: 6, border: '1px solid #ddd', background: busy ? '#eee' : '#f7f7f7', cursor: busy ? 'not-allowed' : 'pointer' }}>
          {busy ? 'Creating…' : 'Create Event'}
        </button>
      </form>

      {loading && <p>Loading…</p>}
      {error && (
        <p style={{ color: 'crimson' }}>Failed to load events: {error}</p>
      )}
      {!loading && !error && (
        <FullCalendar
          plugins={[dayGridPlugin]}
          initialView="dayGridMonth"
          events={events}
          eventClick={onEventClick}
          height={700}
          displayEventTime={false}
        />
      )}

      {/* Modal */}
      {selected && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
        }} onClick={() => setSelectedId(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', color: '#111', width: 'min(720px, 92vw)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}
          >
            <div style={{ padding: 16, borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>{selected.type ? `${selected.type} — ` : ''}{selected.title || 'Event'}</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                {!edit && (
                  <button onClick={() => setEdit(true)} style={{ border: '1px solid #ddd', background: '#f7f7f7', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Edit</button>
                )}
                {edit && (
                  <button onClick={() => setEdit(false)} style={{ border: '1px solid #ddd', background: '#f7f7f7', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Cancel</button>
                )}
                <button onClick={() => setSelectedId(null)} style={{ border: '1px solid #ddd', background: '#f7f7f7', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Close</button>
              </div>
            </div>
            <div style={{ padding: 16, maxHeight: '70vh', overflow: 'auto' }}>
              {!edit ? (
                <>
                  <div style={{ marginBottom: 12, fontSize: 14, color: '#444' }}>
                    <div><strong>Starts:</strong> {selected.startsAt ? new Date(selected.startsAt).toLocaleString() : 'Unknown'}</div>
                    {selected.endsAt ? (<div><strong>Ends:</strong> {new Date(selected.endsAt).toLocaleString()}</div>) : null}
                    {selected.timeZone ? (<div><strong>Time Zone:</strong> {selected.timeZone}</div>) : null}
                  </div>
                  {selected.description ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {selected.description}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.7 }}>No description</div>
                  )}
                  <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                    <button
                      onClick={async () => {
                        try {
                          await fetch(`${base}/events/${selected.id}/remind`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({}),
                          });
                          await fetchEvents();
                        } catch (e) { alert('Failed to remind now'); }
                      }}
                      style={{ border: '1px solid #06c', background: '#e7f1ff', color: '#024', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}
                    >
                      Remind Now
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm('Delete this event?')) return;
                        try {
                          await fetch(`${base}/events/${selected.id}`, { method: 'DELETE' });
                          setSelectedId(null);
                          await fetchEvents();
                        } catch (e) { alert('Failed to delete'); }
                      }}
                      style={{ border: '1px solid #e00', background: '#ffecec', color: '#900', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>
                </>
              ) : (
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const payload = {
                      title: editForm.title,
                      type: editForm.type || '',
                      startsAt: editForm.startsAt ? new Date(editForm.startsAt).toISOString() : undefined,
                      endsAt: editForm.endsAt ? new Date(editForm.endsAt).toISOString() : null,
                      timeZone: editForm.timeZone || null,
                      description: editForm.description || '',
                    };
                    const res = await fetch(`${base}/events/${selected.id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(payload),
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    setEdit(false);
                    await fetchEvents();
                  } catch (err) {
                    alert(err.message || 'Failed to update');
                  }
                }} style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'grid', gap: 6, gridTemplateColumns: '1fr 1fr' }}>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>Type</label>
                      <input value={editForm.type} onChange={(e)=>setEditForm({ ...editForm, type: e.target.value })} placeholder="Meeting / Playtest / Raid" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
                    </div>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>Title</label>
                      <input value={editForm.title} onChange={(e)=>setEditForm({ ...editForm, title: e.target.value })} style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
                    </div>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>Time Zone</label>
                      <input value={editForm.timeZone} onChange={(e)=>setEditForm({ ...editForm, timeZone: e.target.value })} placeholder="Asia/Manila" style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
                    </div>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>Starts At</label>
                      <input type="datetime-local" value={editForm.startsAt} onChange={(e)=>setEditForm({ ...editForm, startsAt: e.target.value })} style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
                    </div>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <label style={{ fontSize: 12, opacity: 0.8 }}>Ends At</label>
                      <input type="datetime-local" value={editForm.endsAt} onChange={(e)=>setEditForm({ ...editForm, endsAt: e.target.value })} style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <label style={{ fontSize: 12, opacity: 0.8 }}>Description</label>
                    <textarea value={editForm.description} onChange={(e)=>setEditForm({ ...editForm, description: e.target.value })} rows={4} style={{ padding: 8, border: '1px solid #ddd', borderRadius: 6 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" style={{ border: '1px solid #0a0', background: '#eaffea', color: '#060', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Save</button>
                    <button type="button" onClick={() => setEdit(false)} style={{ border: '1px solid #ddd', background: '#f7f7f7', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
      </main>
    </Fragment>
  );
}
