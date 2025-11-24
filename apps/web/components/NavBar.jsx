export default function NavBar() {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 60, background: '#fff', borderBottom: '1px solid #eee' }}>
      <nav style={{ display: 'flex', gap: 12, padding: '10px 16px', alignItems: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <a href="/" style={{ textDecoration: 'none', color: '#0366d6' }}>Dashboard</a>
        <a href="/calendar" style={{ textDecoration: 'none', color: '#0366d6' }}>Calendar</a>
        <a href="/templates" style={{ textDecoration: 'none', color: '#0366d6' }}>Templates</a>
      </nav>
    </header>
  );
}
