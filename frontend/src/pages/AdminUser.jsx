import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Loader2, ArrowLeft, UserCog, Ban, CheckCircle2, Trash2, Sparkles, Layers, ScrollText,
  GraduationCap, Trophy, History, ExternalLink,
} from 'lucide-react'
import {
  adminUserDetail, adminSetRole, adminBlockUser, adminUnblockUser, adminDeleteUser, getAuthUser,
} from '../api'
import { formatDate, ACTION_LABELS } from './AdminDashboard'

// One account seen by an administrator: what it owns, its results and
// classes, and the actions an administrator can take on it.
export default function AdminUser() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const me = getAuthUser()
  const [u, setU] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleteContent, setDeleteContent] = useState(false)

  const load = async () => {
    try { setU(await adminUserDetail(userId)) }
    catch (err) { setError(err.response?.data?.detail || 'Could not load this account.') }
  }
  useEffect(() => { load() }, [userId])

  const act = async (fn, okText) => {
    setBusy(true); setError(''); setNotice('')
    try { await fn(); setNotice(okText); await load() }
    catch (err) { setError(err.response?.data?.detail || 'The action failed.') }
    finally { setBusy(false) }
  }

  if (!u) {
    return (
      <div className="container">
        <Link to="/admin" className="back-link"><ArrowLeft size={14} /> Administration</Link>
        {error
          ? <div className="alert alert-error">⚠️ {error}</div>
          : <div className="card center-text"><Loader2 size={20} className="spinner" /><p>Loading...</p></div>}
      </div>
    )
  }

  const isMe = u.id === me?.id
  const owned = u.quizzes.length + u.flashcard_sets.length + u.notes.length

  const removeAccount = async () => {
    const what = deleteContent
      ? `and delete their ${owned} study item(s)`
      : 'and keep their study material without an owner'
    if (!window.confirm(`Delete the account of ${u.name} ${what}? Classes they teach are deleted too. This cannot be undone.`)) return
    setBusy(true); setError('')
    try {
      await adminDeleteUser(u.id, deleteContent)
      navigate('/admin', { replace: true })
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not delete the account.')
      setBusy(false)
    }
  }

  const ItemList = ({ items, kind }) => (
    items.length === 0 ? <p className="text-info">None.</p> : (
      <div className="quiz-list">
        {items.map((it) => (
          <div key={it.id} className="quiz-row">
            <div className="quiz-row-main"><div className="quiz-row-info">
              <div className="quiz-row-title">{it.title}</div>
              <div className="quiz-row-meta">{formatDate(it.created_at)}{it.source_type ? ` · ${it.source_type}` : ''}</div>
            </div></div>
            <div className="quiz-row-actions">
              <Link to={kind === 'q' ? `/q/${it.id}` : kind === 'f' ? `/flashcards/${it.id}` : `/notes/${it.id}`}
                    className="btn btn-secondary btn-small"><ExternalLink size={14} /> Open</Link>
            </div>
          </div>
        ))}
      </div>
    )
  )

  return (
    <div className="container">
      <Link to="/admin" className="back-link"><ArrowLeft size={14} /> Administration</Link>
      <div className="header">
        <h1>
          <UserCog size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} /> {u.name}
          <span className="admin-badges">
            <span className="badge badge-medium">{u.role}</span>
            {u.blocked_at && <span className="badge badge-hard">blocked</span>}
          </span>
        </h1>
        <p>{u.email}</p>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      {u.blocked_at && (
        <div className="alert alert-error">This account was blocked on {formatDate(u.blocked_at, true)}. It cannot sign in.</div>
      )}

      <div className="card">
        <div className="admin-facts">
          <div><div className="admin-fact-label">Joined</div><div className="admin-fact-value">{formatDate(u.created_at)}</div></div>
          <div><div className="admin-fact-label">Last sign-in</div><div className="admin-fact-value">{formatDate(u.last_sign_in, true)}</div></div>
          <div><div className="admin-fact-label">Signed in on</div><div className="admin-fact-value">{u.active_sessions} device(s)</div></div>
          <div><div className="admin-fact-label">Study material</div><div className="admin-fact-value">{owned} item(s)</div></div>
          <div><div className="admin-fact-label">Results</div><div className="admin-fact-value">{u.attempts.length}</div></div>
        </div>
      </div>

      <div className="card">
        <h2><UserCog size={18} /> Manage account</h2>
        {isMe ? (
          <p className="text-info">This is your own account. Another administrator has to change it.</p>
        ) : (
          <div className="button-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="label" style={{ margin: 0 }}>Role</label>
            <select className="select" style={{ width: 'auto' }} value={u.role} disabled={busy} aria-label="Role"
                    onChange={(e) => act(() => adminSetRole(u.id, e.target.value), `Role changed to ${e.target.value}.`)}>
              <option value="student">Student</option>
              <option value="teacher">Teacher</option>
              <option value="admin">Admin</option>
            </select>
            {u.blocked_at ? (
              <button className="btn btn-secondary" disabled={busy}
                      onClick={() => act(() => adminUnblockUser(u.id), 'The account can sign in again.')}>
                <CheckCircle2 size={16} /> Unblock
              </button>
            ) : (
              <button className="btn btn-secondary" disabled={busy}
                      onClick={() => window.confirm(`Block ${u.name}? They are signed out on every device and cannot sign in until unblocked.`)
                        && act(() => adminBlockUser(u.id), 'Account blocked and signed out everywhere.')}>
                <Ban size={16} /> Block
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2><Sparkles size={18} /> Question sets ({u.quizzes.length})</h2>
        <ItemList items={u.quizzes} kind="q" />
        <h2 style={{ marginTop: '1.25rem' }}><Layers size={18} /> Flashcard sets ({u.flashcard_sets.length})</h2>
        <ItemList items={u.flashcard_sets} kind="f" />
        <h2 style={{ marginTop: '1.25rem' }}><ScrollText size={18} /> Notes ({u.notes.length})</h2>
        <ItemList items={u.notes} kind="n" />
      </div>

      <div className="card">
        <h2><Trophy size={18} /> Results ({u.attempts.length})</h2>
        {u.attempts.length === 0 ? <p className="text-info">No results.</p> : (
          <div className="submission-list">
            {u.attempts.map((a, i) => (
              <div key={i} className="submission-row">
                <div className="submission-info">
                  <div className="submission-name">{a.quiz_title || 'Deleted set'}</div>
                  <div className="submission-time">{formatDate(a.created_at)}{a.class_name ? ` · class: ${a.class_name}` : ' · practice'}</div>
                </div>
                <div className="submission-score"><strong>{a.percentage}%</strong><span className="submission-fraction">{a.score}/{a.total}</span></div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2><GraduationCap size={18} /> Classes</h2>
        {u.classes_taught.length === 0 && u.memberships.length === 0 && <p className="text-info">No classes.</p>}
        {u.classes_taught.map((c) => (
          <div key={c.id} className="quiz-row">
            <div className="quiz-row-main"><div className="quiz-row-info">
              <div className="quiz-row-title">{c.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>· code {c.code}</span></div>
              <div className="quiz-row-meta">teaches · {c.students} students</div>
            </div></div>
            <div className="quiz-row-actions">
              <Link to={`/teacher/class/${c.id}`} className="btn btn-secondary btn-small"><ExternalLink size={14} /> Open</Link>
            </div>
          </div>
        ))}
        {u.memberships.map((c) => (
          <div key={c.id} className="quiz-row">
            <div className="quiz-row-main"><div className="quiz-row-info">
              <div className="quiz-row-title">{c.name}</div>
              <div className="quiz-row-meta">student · joined {formatDate(c.joined_at)}</div>
            </div></div>
          </div>
        ))}
      </div>

      {u.actions.length > 0 && (
        <div className="card">
          <h2><History size={18} /> Administrator actions on this account</h2>
          <div className="admin-log">
            {u.actions.map((a, i) => (
              <div key={i} className="admin-log-row">
                <div className="admin-log-time">{formatDate(a.created_at, true)}</div>
                <div className="admin-log-main">
                  <div><strong>{a.admin_name}</strong> {ACTION_LABELS[a.action] || a.action} this account</div>
                  {a.details && <div className="admin-log-details">{a.details}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isMe && (
        <div className="card danger-zone">
          <h2><Trash2 size={18} /> Delete account</h2>
          <p className="text-info">
            The account, its sign-in sessions and flashcard progress are removed, and so are the classes it teaches.
            Their results are kept but are no longer linked to an account.
          </p>
          <label className="checkbox-item" style={{ margin: '0.5rem 0 1rem' }}>
            <input type="checkbox" checked={deleteContent} onChange={(e) => setDeleteContent(e.target.checked)} />
            <span>Also delete their study material ({owned} item(s)). Otherwise it is kept without an owner.</span>
          </label>
          <button className="btn btn-danger" disabled={busy} onClick={removeAccount}><Trash2 size={16} /> Delete account</button>
        </div>
      )}
    </div>
  )
}
