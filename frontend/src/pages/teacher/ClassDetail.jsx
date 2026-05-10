import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Users, FileText, Plus, Trash2, BarChart3, Download, Copy, Check,
  Loader2, ArrowLeft, Clock, GraduationCap, X, Calendar,
} from 'lucide-react'
import {
  getClass, deleteAssignment, createAssignment, listQuizzes, exportClassCsvUrl,
} from '../../api'

export default function ClassDetail() {
  const { classId } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAddAssignment, setShowAddAssignment] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)

  useEffect(() => { load() }, [classId])

  const load = async () => {
    setLoading(true)
    try {
      const result = await getClass(classId)
      setData(result)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load class.')
    } finally {
      setLoading(false)
    }
  }

  const removeAssignment = async (id, title) => {
    if (!confirm(`Remove assignment "${title}"? Submissions stay but it disappears from students' lists.`)) return
    try {
      await deleteAssignment(id)
      load()
    } catch (_) {
      alert('Could not delete.')
    }
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(data.class.code)
      setCopiedCode(true)
      setTimeout(() => setCopiedCode(false), 1500)
    } catch (_) {}
  }

  const formatDate = (iso) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    } catch (_) { return '' }
  }

  const formatDueDate = (iso) => {
    if (!iso) return null
    try {
      const d = new Date(iso)
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch (_) { return iso }
  }

  const isPastDue = (iso) => {
    if (!iso) return false
    return new Date(iso) < new Date()
  }

  if (loading) {
    return (
      <div className="container">
        <div className="card center-text"><Loader2 size={20} className="spinner" /></div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error || 'Class not found'}</div>
        <Link to="/teacher" className="btn btn-secondary"><ArrowLeft size={16} /> Back</Link>
      </div>
    )
  }

  const { class: cls, members, assignments } = data

  return (
    <div className="container">
      <Link to="/teacher" className="back-link"><ArrowLeft size={14} /> Dashboard</Link>

      <div className="header">
        <h1>{cls.name}</h1>
        <p>Teacher: {cls.teacher_name} · Created {formatDate(cls.created_at)}</p>
      </div>

      <div className="card">
        <h2><GraduationCap size={20} /> Class code</h2>
        <p className="text-info" style={{ marginBottom: '0.85rem' }}>
          Share this code with students. They join at <code>/join</code> and enter this code.
        </p>
        <div className="class-code-box">
          <span className="class-code-text">{cls.code}</span>
          <button className="btn btn-secondary btn-small" onClick={copyCode}>
            {copiedCode ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
          </button>
        </div>
      </div>

      <div className="card">
        <h2><Users size={20} /> Students ({members.length})</h2>
        {members.length === 0 ? (
          <p className="text-info">No students yet. Share the class code so they can join.</p>
        ) : (
          <div className="member-list">
            {members.map((m, i) => (
              <div key={i} className="member-row">
                <div className="member-avatar">{m.student_name.charAt(0).toUpperCase()}</div>
                <div className="member-info">
                  <div className="member-name">{m.student_name}</div>
                  <div className="member-joined">Joined {formatDate(m.joined_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ margin: 0 }}><FileText size={20} /> Assignments ({assignments.length})</h2>
          {assignments.length > 0 && (
            <a className="btn btn-secondary btn-small" href={exportClassCsvUrl(classId)} target="_blank" rel="noopener">
              <Download size={14} /> Gradebook CSV
            </a>
          )}
        </div>

        {!showAddAssignment && (
          <button className="btn btn-block" onClick={() => setShowAddAssignment(true)} style={{ marginBottom: '1rem' }}>
            <Plus size={16} /> Add Assignment
          </button>
        )}

        {showAddAssignment && (
          <AddAssignmentForm
            classId={classId}
            onClose={() => setShowAddAssignment(false)}
            onAdded={() => { setShowAddAssignment(false); load() }}
          />
        )}

        {assignments.length === 0 && !showAddAssignment && (
          <p className="text-info center-text" style={{ padding: '1rem' }}>
            No assignments yet. Push a quiz to this class above.
          </p>
        )}

        {assignments.length > 0 && (
          <div className="assignment-list">
            {assignments.map(a => (
              <div key={a.id} className="assignment-row">
                <div className="assignment-main">
                  <div className="assignment-title">{a.quiz_title}</div>
                  <div className="assignment-meta">
                    {a.num_questions} questions · {a.submission_count} submission{a.submission_count === 1 ? '' : 's'}
                    {a.due_at && (
                      <span className={isPastDue(a.due_at) ? 'due-past' : 'due-future'}>
                        {' · '}<Calendar size={11} /> Due {formatDueDate(a.due_at)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="assignment-actions">
                  <Link to={`/teacher/assignment/${a.id}/analytics`} className="btn btn-small">
                    <BarChart3 size={14} /> Analytics
                  </Link>
                  <button className="btn btn-secondary btn-small" onClick={() => removeAssignment(a.id, a.quiz_title)} title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AddAssignmentForm({ classId, onClose, onAdded }) {
  const [quizzes, setQuizzes] = useState([])
  const [quizId, setQuizId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('23:59')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadingQuizzes, setLoadingQuizzes] = useState(true)

  useEffect(() => {
    listQuizzes()
      .then(setQuizzes)
      .catch(() => setError('Could not load your quizzes.'))
      .finally(() => setLoadingQuizzes(false))
  }, [])

  const submit = async () => {
    if (!quizId) {
      setError('Pick a quiz.')
      return
    }
    setError('')
    setBusy(true)
    try {
      let due_at = null
      if (dueDate) {
        due_at = new Date(`${dueDate}T${dueTime}`).toISOString()
      }
      await createAssignment(classId, quizId, due_at)
      onAdded()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not create assignment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adder-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <strong>New assignment</strong>
        <button className="chat-close" onClick={onClose}><X size={16} /></button>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div className="field">
        <label className="label">Pick a quiz</label>
        {loadingQuizzes ? (
          <div className="text-info"><Loader2 size={14} className="spinner" /> Loading quizzes...</div>
        ) : quizzes.length === 0 ? (
          <div className="text-info">
            No quizzes yet. <Link to="/app" style={{ color: 'var(--accent-light)' }}>Create one first</Link>.
          </div>
        ) : (
          <select className="select" value={quizId} onChange={e => setQuizId(e.target.value)}>
            <option value="">— Select —</option>
            {quizzes.map(q => (
              <option key={q.id} value={q.id}>
                {q.title} ({q.num_questions} Q)
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="row">
        <div className="field">
          <label className="label">Due date (optional)</label>
          <input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} disabled={busy} />
        </div>
        <div className="field">
          <label className="label">Due time</label>
          <input className="input" type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} disabled={busy || !dueDate} />
        </div>
      </div>

      <div className="button-row">
        <button className="btn" onClick={submit} disabled={busy || !quizId}>
          {busy ? <><Loader2 size={16} className="spinner" /> Adding...</> : <><Plus size={16} /> Add</>}
        </button>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  )
}
