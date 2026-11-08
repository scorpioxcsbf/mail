import { useEffect, useState, useCallback, useRef } from 'react';
import { Mail, Plus, Copy, RefreshCw, Trash2, Sun, Moon, Clock, Inbox, ArrowLeft, Check, AlertTriangle } from 'lucide-react';

const KEY = 'mehdi-mail:inboxes';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const api = async (url, opt = {}, token) => {
  const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { status: r.status });
  return d;
};
const fmt = ms => { if (ms <= 0) return 'Expired'; const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return `${h ? h + 'h ' : ''}${m}m ${String(s % 60).padStart(2, '0')}s`; };

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [inboxes, setInboxes] = useState(load);
  const [active, setActive] = useState(() => load()[0]?.address || null);
  const [messages, setMessages] = useState([]);
  const [open, setOpen] = useState(null);
  const [user, setUser] = useState('');
  const [domain, setDomain] = useState('');
  const [ttl, setTtl] = useState(60);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const [dark, setDark] = useState(() => localStorage.getItem('mehdi-mail:theme') !== 'light');
  const [spin, setSpin] = useState(false);
  const cur = inboxes.find(i => i.address === active);
  const curRef = useRef(cur); curRef.current = cur;

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('mehdi-mail:theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(inboxes)); }, [inboxes]);
  useEffect(() => { api('/api/config').then(c => { setCfg(c); setDomain(c.domains[0] || ''); setTtl(c.defaultTtl); }).catch(() => setErr('Cannot reach the server')); }, []);
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(t); }, []);

  const drop = useCallback(a => { setInboxes(l => { const n = l.filter(i => i.address !== a); setActive(x => x === a ? n[0]?.address || null : x); return n; }); setOpen(null); }, []);
  const refresh = useCallback(async () => {
    const c = curRef.current; if (!c) { setMessages([]); return; }
    setSpin(true);
    try { setMessages(await api(`/api/addresses/${encodeURIComponent(c.address)}/messages`, {}, c.token)); setErr(''); }
    catch (e) { if (e.status === 401) drop(c.address); else setErr(e.message); }
    setTimeout(() => setSpin(false), 400);
  }, [drop]);
  useEffect(() => { setOpen(null); refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [active, refresh]); // auto-refresh every 5s

  async function create(e) {
    e.preventDefault(); setErr('');
    try {
      const r = await api('/api/addresses', { method: 'POST', body: JSON.stringify({ username: user, domain, ttlMinutes: ttl }) });
      setInboxes(l => [r, ...l]); setActive(r.address); setUser('');
    } catch (x) { setErr(x.message); }
  }
  const copy = () => { navigator.clipboard.writeText(cur.address); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  async function remove() {
    if (!confirm(`Delete ${cur.address} and all its messages?`)) return;
    try { await api(`/api/addresses/${encodeURIComponent(cur.address)}`, { method: 'DELETE' }, cur.token); } catch {}
    drop(cur.address);
  }
  async function read(id) { try { setOpen(await api(`/api/addresses/${encodeURIComponent(cur.address)}/messages/${id}`, {}, cur.token)); } catch (e) { setErr(e.message); } }
  const left = cur ? cur.expiresAt - tick : 0;

  return (
    <div className="app">
      <aside className={'side' + (open ? ' hide-m' : '')}>
        <div className="brand"><Mail size={22} /><span>MEHDI <b>MAIL</b></span>
          <button className="ico" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? <Sun size={18} /> : <Moon size={18} />}</button></div>
        {cfg && !cfg.ready && <div className="warn"><AlertTriangle size={16} /> Server has no domain configured. Set DOMAINS in .env.</div>}
        <form onSubmit={create} className="new">
          <div className="row"><input value={user} onChange={e => setUser(e.target.value)} placeholder="username (blank = random)" maxLength={32} />
            <select value={domain} onChange={e => setDomain(e.target.value)}>{cfg?.domains.map(d => <option key={d} value={d}>@{d}</option>)}</select></div>
          <div className="row"><label className="ttl"><Clock size={14} /> Expires in
            <input type="number" min="1" max={cfg?.maxTtl || 1440} value={ttl} onChange={e => setTtl(e.target.value)} /> min</label>
            <button className="btn" disabled={!cfg?.ready}><Plus size={16} /> Create</button></div>
        </form>
        <div className="list">{inboxes.map(i => (
          <button key={i.address} className={'addr' + (i.address === active ? ' on' : '')} onClick={() => setActive(i.address)}>
            <Inbox size={16} /><span>{i.address}</span><small>{fmt(i.expiresAt - tick)}</small></button>))}
          {!inboxes.length && <p className="muted">No inboxes yet. Create one above.</p>}</div>
      </aside>

      <main>
        {err && <div className="err">{err}</div>}
        {!cur ? <div className="empty"><Mail size={56} /><h2>Your disposable inbox</h2><p>Create an address to start receiving real email.</p></div> : <>
          <header className="bar">
            <div className="who"><strong>{cur.address}</strong><span className="count"><Clock size={13} /> {fmt(left)}</span></div>
            <div className="acts">
              <button className="btn ghost" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy'}</button>
              <button className="btn ghost" onClick={refresh}><RefreshCw size={16} className={spin ? 'spin' : ''} /> Refresh</button>
              <button className="btn danger" onClick={remove}><Trash2 size={16} /> Delete</button></div>
          </header>
          <div className="panes">
            <section className={'msgs' + (open ? ' hide-m' : '')}>
              {messages.map(m => (
                <button key={m.id} className={'msg' + (open?.id === m.id ? ' on' : '')} onClick={() => read(m.id)}>
                  <div className="top"><b>{m.sender}</b><time>{new Date(m.receivedAt).toLocaleString()}</time></div>
                  <div className="sub">{m.subject}</div><div className="pre">{m.preview}</div></button>))}
              {!messages.length && <div className="empty small"><RefreshCw size={28} /><p>Waiting for incoming mail…</p><span className="muted">Checks automatically every 5 seconds.</span></div>}
            </section>
            <section className={'reader' + (open ? '' : ' hide-m')}>
              {open ? <>
                <button className="back ico" onClick={() => setOpen(null)}><ArrowLeft size={18} /> Back</button>
                <h2>{open.subject}</h2>
                <div className="meta"><span><b>From:</b> {open.sender}</span><span><b>Date:</b> {new Date(open.receivedAt).toLocaleString()}</span></div>
                {open.html
                  ? <iframe title="mail" sandbox="" srcDoc={`<base target="_blank"><style>body{font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#222;margin:12px}a{color:#0a66ff}</style>${open.html}`} />
                  : <pre className="plain">{open.text}</pre>}
              </> : <div className="empty small"><Mail size={28} /><p>Select a message to read it</p></div>}
            </section>
          </div></>}
      </main>
    </div>
  );
}
