import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader2, Shield, Users, Sparkles, Layers, ScrollText, GraduationCap, Trash2, ExternalLink,
} from 'lucide-react'
import {
  adminStats, adminUsers, adminSetRole, adminContent,
  adminDeleteQuiz, adminDeleteFlashcards, adminDeleteNote, getAuthUser,
} from '../api'

// Administration: overview of the platform, account roles and moderation of
// the content users have generated. Only reachable with an admin account.
const formatDate = (iso) => {
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
  catch (_) { return iso }
}

export default function AdminDashboard() {
  const me = getAuthUser()
  const [tab, setTab] = useState('users')
  const [stats, setStats] = useState(null)
  const [users, setUsers] = useState([])
  const [content, setContent] = useState(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  const load = async () => {
    try {
      const [s, u, c] = await Promise.all([adminStats(), adminUsers(), adminContent()])
      setStats(s); setUsers(u); setContent(c)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load admin data.')
    }
  }
  useEffect(() => { load() }, [])

  const changeRole = async (u, role) => {
    setBusyId(u.id); setError('')
    try { await adminSetRole(u.id, role); await load() }
    catch (err) { setError(err.response?.data?.detail || 'Could not change the role.') }
    finally { setBusyId(null) }
  }

  const remove = async (kind, item) => {
    const label = item.title || item.name
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return
    setBusyId(item.id); setError('')
    try {
      if (kind === 'quizzes') await adminDeleteQuiz(item.id)
      if (kind === 'flashcard_sets') await adminDeleteFlashcards(item.id)
      if (kind === 'notes') await adminDeleteNote(item.id)
      await load()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not delete.')
    } finally { setBusyId(null) }
  }

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
    items.length === 0 ? <p className="text-info center-text">Nothing here yet.</p> : (
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

  return (
    <div className="container">
      <div className="header">
        <h1><Shield size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} /> Administration</h1>
        <p>Signed in as {me?.name} · manage accounts and content of the Drilearn platform</p>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon"><Users size={20} /></div>
          <div className="stat-value">{totalUsers}</div>
          <div className="stat-label">{stats.users.student} students · {stats.users.teacher} teachers · {stats.users.admin} admins</div>
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

      <div className="tabs" style={{ marginBottom: '1.25rem' }}>
        <button className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}><Users size={14} /> Users ({users.length})</button>
        <button className={`tab ${tab === 'quizzes' ? 'active' : ''}`} onClick={() => setTab('quizzes')}><Sparkles size={14} /> Sets ({content.quizzes.length})</button>
        <button className={`tab ${tab === 'flashcard_sets' ? 'active' : ''}`} onClick={() => setTab('flashcard_sets')}><Layers size={14} /> Flashcards ({content.flashcard_sets.length})</button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}><ScrollText size={14} /> Notes ({content.notes.length})</button>
        <button className={`tab ${tab === 'classes' ? 'active' : ''}`} onClick={() => setTab('classes')}><GraduationCap size={14} /> Classes ({content.classes.length})</button>
      </div>

      {tab === 'users' && (
        <div className="quiz-list">
          {users.map((u) => (
            <div key={u.id} className="quiz-row">
              <div className="quiz-row-main">
                <div className="quiz-row-info">
                  <div className="quiz-row-title">{u.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>· {u.email}</span></div>
                  <div className="quiz-row-meta">joined {formatDate(u.created_at)} · {u.quizzes} sets · {u.classes} classes</div>
                </div>
              </div>
              <div className="quiz-row-actions">
                <select
                  className="input"
                  style={{ width: 'auto', padding: '0.35rem 0.6rem' }}
                  value={u.role}
                  disabled={busyId === u.id || u.id === me?.id}
                  onChange={(e) => changeRole(u, e.target.value)}
                  aria-label={`Role of ${u.name}`}
                >
                  <option value="student">Student</option>
                  <option value="teacher">Teacher</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'quizzes' && <ContentList kind="quizzes" items={content.quizzes} />}
      {tab === 'flashcard_sets' && <ContentList kind="flashcard_sets" items={content.flashcard_sets} />}
      {tab === 'notes' && <ContentList kind="notes" items={content.notes} />}
      {tab === 'classes' && (
        <div className="quiz-list">
          {content.classes.map((c) => (
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
    </div>
  )
}
