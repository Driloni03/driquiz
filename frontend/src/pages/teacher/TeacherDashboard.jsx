import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  GraduationCap, Plus, Loader2, Users, FileText, Copy, Check, Trash2, ArrowRight,
  BookOpen, Brain, Trophy, Star, Atom, Beaker, Code, Zap,
} from 'lucide-react'
import { listClasses, createClass, deleteClass, getAuthTeacher, listQuizzes, createLiveSession } from '../../api'

const ICON_MAP = {
  graduation: GraduationCap, book: BookOpen, brain: Brain, trophy: Trophy,
  star: Star, atom: Atom, beaker: Beaker, code: Code,
}
const getIconComponent = (id) => ICON_MAP[id] || GraduationCap

export default function TeacherDashboard() {
  const navigate = useNavigate()
  const teacher = getAuthTeacher()
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showLiveLauncher, setShowLiveLauncher] = useState(false)
  const [copiedCode, setCopiedCode] = useState(null)

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const data = await listClasses()
      setClasses(data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load classes.')
    } finally {
      setLoading(false)
    }
  }

  const remove = async (id, name) => {
    if (!confirm(`Delete "${name}"? Students and assignments are deleted too. This cannot be undone.`)) return
    try {
      await deleteClass(id)
      setClasses(prev => prev.filter(c => c.id !== id))
    } catch (err) {
      alert('Could not delete class.')
    }
  }

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode(null), 1500)
    } catch (_) {}
  }

  return (
    <div className="container">
      <div className="header">
        <h1><GraduationCap size={32} style={{ verticalAlign: 'middle', marginRight: 8 }} /> Teacher Dashboard</h1>
        <p>{teacher ? `Signed in as ${teacher.name}` : ''} · {classes.length} class{classes.length === 1 ? '' : 'es'}</p>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {!showCreate && !showLiveLauncher && (
        <div className="dashboard-actions">
          <button className="btn" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Create Class
          </button>
          <button className="btn btn-secondary" onClick={() => setShowLiveLauncher(true)}>
            <Zap size={16} /> Start Live Quiz
          </button>
        </div>
      )}

      {showCreate && (
        <CreateClassCard
          onClose={() => setShowCreate(false)}
          onCreated={(c) => { setClasses([c, ...classes]); setShowCreate(false) }}
        />
      )}

      {showLiveLauncher && (
        <LiveQuizLauncher
          onClose={() => setShowLiveLauncher(false)}
          onLaunched={(session) => navigate(`/live/host/${session.session_id}`)}
        />
      )}

      {loading && (
        <div className="card center-text">
          <Loader2 size={20} className="spinner" />
        </div>
      )}

      {!loading && classes.length === 0 && !showCreate && !showLiveLauncher && (
        <div className="card center-text">
          <p style={{ marginBottom: '1rem' }}>No classes yet.</p>
          <button className="btn" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Create your first class
          </button>
        </div>
      )}

      {!loading && classes.length > 0 && (
        <div className="quiz-list">
          {classes.map(c => (
            <div key={c.id} className="quiz-row">
              <div className="quiz-row-main">
                <div
                  className="quiz-row-icon"
                  style={{
                    background: `linear-gradient(135deg, ${c.color || '#7c3aed'}, ${c.color || '#7c3aed'}cc)`,
                    color: 'white',
                  }}
                >
                  {(() => {
                    const Icon = getIconComponent(c.icon)
                    return <Icon size={16} />
                  })()}
                </div>
                <div className="quiz-row-info">
                  <div className="quiz-row-title">{c.name}</div>
                  <div className="quiz-row-meta">
                    <Users size={11} /> {c.student_count} student{c.student_count === 1 ? '' : 's'} ·{' '}
                    <FileText size={11} /> {c.assignment_count} assignment{c.assignment_count === 1 ? '' : 's'} ·
                    Teacher: {c.teacher_name}
                  </div>
                </div>
              </div>
              <div className="quiz-row-actions">
                <button className="btn btn-secondary btn-small" onClick={() => copyCode(c.code)} title="Copy class code">
                  {copiedCode === c.code ? <><Check size={14} /> Copied</> : <><Copy size={14} /> {c.code}</>}
                </button>
                <button className="btn btn-secondary btn-small" onClick={() => remove(c.id, c.name)} title="Delete class">
                  <Trash2 size={14} />
                </button>
                <Link to={`/teacher/class/${c.id}`} className="btn btn-small">
                  Open <ArrowRight size={13} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CreateClassCard({ onClose, onCreated }) {
  const teacher = getAuthTeacher()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim()) {
      setError('Please enter a class name.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const c = await createClass(name.trim(), teacher?.name || 'Teacher')
      onCreated(c)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not create class.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2><Plus size={20} /> New class</h2>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      <div className="field">
        <label className="label">Class name</label>
        <input className="input" placeholder="e.g. Biology 101 - Spring 2026" value={name} onChange={e => setName(e.target.value)} disabled={busy} />
      </div>
      <div className="text-info" style={{ marginBottom: '1rem' }}>
        Teacher: <strong>{teacher?.name}</strong>
      </div>
      <div className="button-row">
        <button className="btn" onClick={submit} disabled={busy}>
          {busy ? <><Loader2 size={16} className="spinner" /> Creating...</> : <><Plus size={16} /> Create</>}
        </button>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  )
}

function LiveQuizLauncher({ onClose, onLaunched }) {
  const [quizzes, setQuizzes] = useState([])
  const [quizId, setQuizId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    listQuizzes()
      .then(setQuizzes)
      .catch(() => setError('Could not load your quizzes.'))
      .finally(() => setLoading(false))
  }, [])

  const launch = async () => {
    if (!quizId) {
      setError('Pick a quiz.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const sess = await createLiveSession(quizId)
      onLaunched(sess)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not start session.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2><Zap size={20} /> Start a live quiz</h2>
      <p className="text-info" style={{ marginBottom: '1rem' }}>
        Live mode supports multiple-choice and true/false questions only. Students join with a 6-character code.
      </p>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {loading ? (
        <div className="text-info"><Loader2 size={14} className="spinner" /> Loading quizzes...</div>
      ) : quizzes.length === 0 ? (
        <div className="text-info">
          No quizzes yet. <Link to="/app" style={{ color: 'var(--accent-light)' }}>Create one first</Link>.
        </div>
      ) : (
        <>
          <div className="field">
            <label className="label">Pick a quiz</label>
            <select className="select" value={quizId} onChange={e => setQuizId(e.target.value)}>
              <option value="">— Select —</option>
              {quizzes.map(q => (
                <option key={q.id} value={q.id}>
                  {q.title} ({q.num_questions} Q)
                </option>
              ))}
            </select>
          </div>
          <div className="button-row">
            <button className="btn" onClick={launch} disabled={busy || !quizId}>
              {busy ? <><Loader2 size={16} className="spinner" /> Creating...</> : <><Zap size={16} /> Launch</>}
            </button>
            <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )
}
