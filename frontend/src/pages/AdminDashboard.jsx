import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Loader2, Shield, Users, Sparkles, Layers, ScrollText, GraduationCap, Trash2, ExternalLink,
  History, Wrench, Search, ChevronRight, Database,
} from 'lucide-react'
import {
  adminStats, adminUsers, adminContent, adminAudit, adminMaintenance, adminCleanup,
  adminDeleteQuiz, adminDeleteFlashcards, adminDeleteNote, getAuthUser,
} from '../api'

// Administration: overview of the platform, account management, moderation
// of generated content, the log of admin actions and maintenance tasks.
// Only reachable with an admin account.
export const formatDate = (iso, withTime = false) => {
  if (!iso) return '—'
  try {
    const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z')
    return withTime
      ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch (_) { return iso }
}

export const ACTION_LABELS = {
  change_role: 'Changed the role of',
  block_user: 'Blocked',
  unblock_user: 'Unblocked',
  delete_user: 'Deleted the account of',
  delete_content: 'Deleted',
  cleanup: 'Ran cleanup:',
}
const TARGET_LABELS = { quiz: 'question set', flashcard_set: 'flashcard set', note: 'note' }

const formatBytes = (b) => {
  if (b == null) return '—'
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

const TABS = ['users', 'quizzes', 'flashcard_sets', 'notes', 'classes', 'log', 'maintenance']

export default function AdminDashboard() {
  const me = getAuthUser()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'users'
  const setTab = (t) => setParams(t === 'users' ? {} : { tab: t }, { replace: true })

  const [stats, setStats] = useState(null)
  const [users, setUsers] = useState([])
  const [content, setContent] = useState(null)
  const [log, setLog] = useState(null)
  const [maint, setMaint] = useState(null)
  const [guestDays, setGuestDays] = useState(30)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState(null)

  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = async () => {
    try {
      const [s, u, c] = await Promise.all([adminStats(), adminUsers(), adminContent()])
      setStats(s); setUsers(u); setContent(c)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load admin data.')
    }
  }
  const loadLog = async () => {
    try { setLog(await adminAudit()) } catch (err) { setError(err.response?.data?.detail || 'Could not load the log.') }
  }
  const loadMaint = async (days = guestDays) => {
    try { setMaint(await adminMaintenance(days)) } catch (err) { setError(err.response?.data?.detail || 'Could not load maintenance data.') }
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (tab === 'log') loadLog()
    if (tab === 'maintenance') loadMaint()
  }, [tab])

  const remove = async (kind, item) => {
    const label = item.title || item.name
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return
    setBusyId(item.id); setError(''); setNotice('')
    try {
      if (kind === 'quizzes') await adminDeleteQuiz(item.id)
      if (kind === 'flashcard_sets') await adminDeleteFlashcards(item.id)
      if (kind === 'notes') await adminDeleteNote(item.id)
      await load()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not delete.')
    } finally { setBusyId(null) }
  }

  const runCleanup = async (task, label) => {
    if (!window.confirm(`${label}? This cannot be undone.`)) return
    setBusyId(task); setError(''); setNotice('')
    try {
      const r = await adminCleanup(task, guestDays)
      const names = { quizzes: 'question sets', flashcard_sets: 'flashcard sets', notes: 'notes', responses: 'answers', sessions: 'sessions' }
      const parts = Object.entries(r.deleted).map(([k, v]) => `${v} ${names[k] || k}`)
      setNotice(`Cleanup finished: removed ${parts.join(', ')}.`)
      await Promise.all([loadMaint(), load()])
    } catch (err) {
      setError(err.response?.data?.detail || 'Cleanup failed.')
    } finally { setBusyId(null) }
  }

  const q = query.trim().toLowerCase()
  const filteredUsers = useMemo(() => users.filter((u) =>
    (roleFilter === 'all' || u.role === roleFilter) &&
    (statusFilter === 'all' || (statusFilter === 'blocked') === !!u.blocked_at) &&
    (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  ), [users, roleFilter, statusFilter, q])
  const filterItems = (items) => items.filter((it) =>
    !q || (it.title || it.name || '').toLowerCase().includes(q) || (it.owner || '').toLowerCase().includes(q))

  if (!stats || !content) {
    return (
      <div className="container">
        {error
          ? <div className="alert alert-error">⚠️ {error}</div>
          : <div className="card center-text"><Loader2 size={20} className="spinner" /><p>Loading...</p></div>}
      </div>
    )
  }

  const totalUsers = stats.users.student + stats.users.teacher + stats.users.admin
  const openLink = (kind, id) =>
    kind === 'quizzes' ? `/q/${id}` : kind === 'flashcard_sets' ? `/flashcards/${id}` : `/notes/${id}`

  const ContentList = ({ kind, items }) => (
    items.length === 0 ? <p className="text-info center-text">Nothing here.</p> : (
      <div className="quiz-list">
        {items.map((it) => (
          <div key={it.id} className="quiz-row">
            <div className="quiz-row-main">
              <div className="quiz-row-info">
                <div className="quiz-row-title">{it.title}</div>
                <div className="quiz-row-meta">
                  {formatDate(it.created_at)} · {it.owner ? `owner: ${it.owner}` : 'guest (no account)'}
                </div>
              </div>
            </div>
            <div className="quiz-row-actions">
              <Link to={openLink(kind, it.id)} className="btn btn-secondary btn-small"><ExternalLink size={14} /> Open</Link>
              <button className="btn btn-secondary btn-small" disabled={busyId === it.id} onClick={() => remove(kind, it)}>
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    )
  )

  const showSearch = !['log', 'maintenance'].includes(tab)

  return (
    <div className="container">
      <div className="header">
        <h1><Shield size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} /> Administration</h1>
        <p>Signed in as {me?.name} · manage accounts and content of the Drilearn platform</p>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon"><Users size={20} /></div>
          <div className="stat-value">{totalUsers}</div>
          <div className="stat-label">
            {stats.users.student} students · {stats.users.teacher} teachers · {stats.users.admin} admins
            {stats.blocked ? ` · ${stats.blocked} blocked` : ''}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><Sparkles size={20} /></div>
          <div className="stat-value">{stats.quizzes + stats.flashcard_sets + stats.notes}</div>
          <div className="stat-label">{stats.quizzes} question sets · {stats.flashcard_sets} flashcard sets · {stats.notes} notes</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><GraduationCap size={20} /></div>
          <div className="stat-value">{stats.classes}</div>
          <div className="stat-label">classes · {stats.assignments} assignments · {stats.submissions} submissions</div>
        </div>
      </div>

      <div className="tabs admin-tabs" style={{ marginBottom: '1.25rem' }}>
        <button className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}><Users size={14} /> Users ({users.length})</button>
        <button className={`tab ${tab === 'quizzes' ? 'active' : ''}`} onClick={() => setTab('quizzes')}><Sparkles size={14} /> Sets ({content.quizzes.length})</button>
        <button className={`tab ${tab === 'flashcard_sets' ? 'active' : ''}`} onClick={() => setTab('flashcard_sets')}><Layers size={14} /> Flashcards ({content.flashcard_sets.length})</button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}><ScrollText size={14} /> Notes ({content.notes.length})</button>
        <button className={`tab ${tab === 'classes' ? 'active' : ''}`} onClick={() => setTab('classes')}><GraduationCap size={14} /> Classes ({content.classes.length})</button>
        <button className={`tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}><History size={14} /> Activity log</button>
        <button className={`tab ${tab === 'maintenance' ? 'active' : ''}`} onClick={() => setTab('maintenance')}><Wrench size={14} /> Maintenance</button>
      </div>

      {showSearch && (
        <div className="admin-toolbar">
          <div style={{ position: 'relative', flex: '1 1 220px' }}>
            <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
            <input
              className="input" style={{ paddingLeft: '2.2rem', width: '100%' }}
              placeholder={tab === 'users' ? 'Search by name or email' : 'Search by title or owner'}
              value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search"
            />
          </div>
          {tab === 'users' && (
            <>
              <select className="select" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
                <option value="all">All roles</option>
                <option value="student">Students</option>
                <option value="teacher">Teachers</option>
                <option value="admin">Admins</option>
              </select>
              <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
                <option value="all">Any status</option>
                <option value="active">Active</option>
                <option value="blocked">Blocked</option>
              </select>
            </>
          )}
        </div>
      )}

      {tab === 'users' && (
        filteredUsers.length === 0 ? <p className="text-info center-text">No accounts match.</p> : (
          <div className="quiz-list">
            {filteredUsers.map((u) => (
              <div key={u.id} className="quiz-row admin-user-row" onClick={() => navigate(`/admin/users/${u.id}`)}
                   role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/users/${u.id}`)}>
                <div className="quiz-row-main">
                  <div className="quiz-row-info">
                    <div className="quiz-row-title">
                      {u.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>· {u.email}</span>
                      <span className="admin-badges">
                        <span className="badge badge-medium">{u.role}</span>
                        {u.blocked_at && <span className="badge badge-hard">blocked</span>}
                        {u.id === me?.id && <span className="badge badge-easy">you</span>}
                      </span>
                    </div>
                    <div className="quiz-row-meta">
                      joined {formatDate(u.created_at)} · last sign-in {formatDate(u.last_sign_in)} ·
                      {' '}{u.quizzes} sets · {u.flashcard_sets} flashcards · {u.notes} notes · {u.classes} classes
                    </div>
                  </div>
                </div>
                <div className="quiz-row-actions">
                  <span className="btn btn-secondary btn-small">Manage <ChevronRight size={14} /></span>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'quizzes' && <ContentList kind="quizzes" items={filterItems(content.quizzes)} />}
      {tab === 'flashcard_sets' && <ContentList kind="flashcard_sets" items={filterItems(content.flashcard_sets)} />}
      {tab === 'notes' && <ContentList kind="notes" items={filterItems(content.notes)} />}
      {tab === 'classes' && (
        <div className="quiz-list">
          {filterItems(content.classes).map((c) => (
            <div key={c.id} className="quiz-row">
              <div className="quiz-row-main">
                <div className="quiz-row-info">
                  <div className="quiz-row-title">{c.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>· code {c.code}</span></div>
                  <div className="quiz-row-meta">{formatDate(c.created_at)} · teacher: {c.owner || '—'} · {c.students} students</div>
                </div>
              </div>
              <div className="quiz-row-actions">
                <Link to={`/teacher/class/${c.id}`} className="btn btn-secondary btn-small"><ExternalLink size={14} /> Open</Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'log' && (
        !log ? <div className="card center-text"><Loader2 size={18} className="spinner" /></div> :
        log.length === 0 ? <p className="text-info center-text">No administrator actions yet.</p> : (
          <div className="admin-log">
            {log.map((a) => (
              <div key={a.id} className="admin-log-row">
                <div className="admin-log-time">{formatDate(a.created_at, true)}</div>
                <div className="admin-log-main">
                  <div>
                    <strong>{a.admin_name}</strong> {ACTION_LABELS[a.action] || a.action}{' '}
                    {a.action === 'delete_content' && `${TARGET_LABELS[a.target_type] || a.target_type} `}
                    {a.target_type === 'user' && a.target_id && a.action !== 'delete_user'
                      ? <Link to={`/admin/users/${a.target_id}`}>{a.target_label}</Link>
                      : <span>{a.target_label}</span>}
                  </div>
                  {a.details && <div className="admin-log-details">{a.details}</div>}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'maintenance' && (
        !maint ? <div className="card center-text"><Loader2 size={18} className="spinner" /></div> : (
          <>
            <div className="admin-maint-grid">
              <div className="card">
                <h3>Unclaimed guest material</h3>
                <div className="admin-maint-count">{maint.guest.quizzes + maint.guest.flashcard_sets + maint.guest.notes}</div>
                <p>
                  Created without an account more than{' '}
                  <select className="select" style={{ width: 'auto', padding: '0.2rem 0.4rem', display: 'inline-block' }}
                          value={guestDays} aria-label="Age in days"
                          onChange={(e) => { const d = Number(e.target.value); setGuestDays(d); loadMaint(d) }}>
                    {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>{' '}
                  days ago and never claimed: {maint.guest.quizzes} sets, {maint.guest.flashcard_sets} flashcard sets,
                  {' '}{maint.guest.notes} notes. Sets used in a class, a live session or by a signed-in student are kept.
                </p>
                <button className="btn btn-secondary btn-small" disabled={busyId === 'guest_content' || maint.guest.quizzes + maint.guest.flashcard_sets + maint.guest.notes === 0}
                        onClick={() => runCleanup('guest_content', `Delete unclaimed guest material older than ${guestDays} days`)}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
              <div className="card">
                <h3>Old assignment answers</h3>
                <div className="admin-maint-count">{maint.old_responses}</div>
                <p>Individual answers older than 90 days. Scores stay in the results; only the per-question detail is removed.</p>
                <button className="btn btn-secondary btn-small" disabled={busyId === 'old_responses' || maint.old_responses === 0}
                        onClick={() => runCleanup('old_responses', 'Delete assignment answers older than 90 days')}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
              <div className="card">
                <h3>Expired sign-in sessions</h3>
                <div className="admin-maint-count">{maint.expired_sessions}</div>
                <p>Session tokens older than 30 days. They no longer work, so removing them changes nothing for users.</p>
                <button className="btn btn-secondary btn-small" disabled={busyId === 'expired_sessions' || maint.expired_sessions === 0}
                        onClick={() => runCleanup('expired_sessions', 'Delete expired sessions')}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
            <div className="card">
              <h2><Database size={18} /> Database · {formatBytes(maint.database_bytes)}</h2>
              <table className="admin-table">
                <thead><tr><th>Table</th><th>Rows</th></tr></thead>
                <tbody>
                  {Object.entries(maint.tables).map(([t, n]) => <tr key={t}><td><code>{t}</code></td><td>{n}</td></tr>)}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </div>
  )
}
