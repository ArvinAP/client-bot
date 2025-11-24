import { useEffect, useMemo, useState, Fragment } from 'react';
import NavBar from '../components/NavBar';

export default function Home() {
  const base = process.env.NEXT_PUBLIC_API_URL;
  const [events, setEvents] = useState([]);
  const [subs, setSubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function fetchAll() {
    try {
      setLoading(true);
      setError(null);
      const [eRes, sRes] = await Promise.all([
        fetch(`${base}/events`, { cache: 'no-store' }),
        fetch(`${base}/submissions`, { cache: 'no-store' }),
      ]);
      if (!eRes.ok) throw new Error(`Events HTTP ${eRes.status}`);
      if (!sRes.ok) throw new Error(`Submissions HTTP ${sRes.status}`);
      const eJson = await eRes.json();
      const sJson = await sRes.json();
      setEvents(Array.isArray(eJson.items) ? eJson.items : []);
      setSubs(Array.isArray(sJson.items) ? sJson.items : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchAll(); }, []);

  const upcoming = useMemo(() => {
    const nowIso = new Date().toISOString();
    return (events || [])
      .filter((e) => e.startsAt && e.startsAt >= nowIso)
      .sort((a,b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, 10);
  }, [events]);

  const recentSubs = useMemo(() => {
    return (subs || []).slice(0, 10);
  }, [subs]);

  return (
    <Fragment>
      <NavBar />
      <main style={{padding: 24, fontFamily: 'system-ui, sans-serif'}}>
      <h1 style={{fontSize: 28, marginBottom: 8}}>Dashboard</h1>
      <p style={{opacity: 0.8, marginBottom: 16}}>This dashboard shows upcoming events and the latest collected form submissions.</p>

      {loading && <p>Loading…</p>}
      {error && <p style={{ color: 'crimson' }}>Failed to load: {error}</p>}

      {!loading && !error && (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr' }}>
          <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
            <h2 style={{fontSize: 18, margin: 0, marginBottom: 8}}>Upcoming Events</h2>
            {upcoming.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No upcoming events</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {upcoming.map((e) => (
                  <li key={e.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600 }}>{e.type ? `${e.type} — ` : ''}{e.title || 'Event'}</div>
                    <div style={{ opacity: 0.8, fontSize: 13 }}>
                      {e.startsAt ? new Date(e.startsAt).toLocaleString() : 'Unknown'} {e.timeZone ? `(${e.timeZone})` : ''}
                    </div>
                    {e.description ? (
                      <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontSize: 13 }}>{e.description}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
            <h2 style={{fontSize: 18, margin: 0, marginBottom: 8}}>Recent Form Submissions</h2>
            {recentSubs.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No submissions</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {recentSubs.map((s) => (
                  <li key={s.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                      <div style={{ fontWeight: 600 }}>{s.title || 'Submission'}</div>
                      <div style={{ opacity: 0.8, fontSize: 12 }}>{s.receivedAt ? new Date(s.receivedAt).toLocaleString() : ''}</div>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13, color: '#333' }}>
                      {s.data ? (
                        <div style={{ display: 'grid', gap: 4 }}>
                          {Object.entries(s.data).slice(0, 5).map(([k,v]) => (
                            <div key={k}>
                              <span style={{ opacity: 0.7 }}>{k}:</span> {String(v)}
                            </div>
                          ))}
                          {Object.keys(s.data).length > 5 ? (
                            <div style={{ opacity: 0.6, fontSize: 12 }}>(+{Object.keys(s.data).length - 5} more)</div>
                          ) : null}
                        </div>
                      ) : (
                        <div style={{ opacity: 0.7 }}>No data</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      </main>
    </Fragment>
  );
}
