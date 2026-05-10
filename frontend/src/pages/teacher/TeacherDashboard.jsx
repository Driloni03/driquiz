import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  GraduationCap, Plus, Loader2, Users, FileText, Copy, Check, Trash2, ArrowRight,
} from 'lucide-react'
import { listClasses, createClass, deleteClass } from '../../api'

const STORAGE_TEACHER = 'driquiz_teacher_name'

export default function TeacherDashboard() {
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [copiedCode, setCopiedCode] = useState(null)

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const data = await listClasses()
      setClasses(data)
    } catch (err) {
      setError('Could not load classes.')
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
        <p>{classes.length} class{classes.length === 1 ? '' : 'es'} · Create classes, push quizzes, view analytics</p>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {!showCreate && (
        <button className="btn btn-block" onClick={() => setShowCreate(true)} style={{ marginBottom: '1.5rem' }}>
          <Plus size={18} /> Create New Class
        </button>
      )}

      {showCreate && <CreateClassCard onClose={() => setShowCreate(false)} onCreated={(c) => { setClasses([c, ...classes]); setShowCreate(false) }} />}

      {loading && (
        <div className="card center-text">
          <Loader2 size={20} className="spinner" />
        </div>
      )}

      {!loading && classes.length === 0 && !showCreate && (
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
                <div className="quiz-row-icon"><GraduationCap size={16} /></div>
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
  const [name, setName] = useState('')
  const [teacherName, setTeacherName] = useState(localStorage.getItem(STORAGE_TEACHER) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim() || !teacherName.trim()) {
      setError('Both fields required.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const c = await createClass(name.trim(), teacherName.trim())
      localStorage.setItem(STORAGE_TEACHER, teacherName.trim())
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
      <div className="field">
        <label className="label">Teacher name</label>
        <input className="input" placeholder="Your name" value={teacherName} onChange={e => setTeacherName(e.target.value)} disabled={busy} />
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
