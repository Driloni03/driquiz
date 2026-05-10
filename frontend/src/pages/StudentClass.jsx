import { useState, useEffect } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import {
  GraduationCap, FileText, Clock, Calendar, Loader2, ArrowLeft, Play, ArrowRight,
} from 'lucide-react'
import { getClass } from '../api'

const STORAGE_STUDENT = 'driquiz_student_name'

export default function StudentClass() {
  const { classId } = useParams()
  const location = useLocation()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const studentName = location.state?.studentName || localStorage.getItem(STORAGE_STUDENT) || 'Student'

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

  const isPastDue = (iso) => {
    if (!iso) return false
    return new Date(iso) < new Date()
  }

  const formatDueDate = (iso) => {
    if (!iso) return null
    try {
      const d = new Date(iso)
      const now = new Date()
      const diffDays = Math.ceil((d - now) / (1000 * 60 * 60 * 24))
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      if (diffDays === 0) return `Due today ${timeStr}`
      if (diffDays === 1) return `Due tomorrow ${timeStr}`
      if (diffDays > 0 && diffDays < 7) return `Due in ${diffDays} days`
      if (diffDays < 0) return `Past due (${dateStr})`
      return `Due ${dateStr}`
    } catch (_) { return iso }
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
        <Link to="/join" className="btn btn-secondary"><ArrowLeft size={16} /> Try again</Link>
      </div>
    )
  }

  const { class: cls, assignments } = data

  return (
    <div className="container">
      <Link to="/join" className="back-link"><ArrowLeft size={14} /> Join another class</Link>

      <div className="header">
        <h1><GraduationCap size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} /> {cls.name}</h1>
        <p>Welcome, <strong>{studentName}</strong> · Teacher: {cls.teacher_name}</p>
      </div>

      <div className="card">
        <h2><FileText size={20} /> Assignments</h2>

        {assignments.length === 0 ? (
          <p className="text-info center-text" style={{ padding: '1rem' }}>
            No assignments yet. Your teacher hasn't posted any quizzes.
          </p>
        ) : (
          <div className="assignment-list">
            {assignments.map(a => {
              const pastDue = isPastDue(a.due_at)
              return (
                <div key={a.id} className={`assignment-row ${pastDue ? 'past-due' : ''}`}>
                  <div className="assignment-main">
                    <div className="assignment-title">{a.quiz_title}</div>
                    <div className="assignment-meta">
                      {a.num_questions} questions
                      {a.due_at && (
                        <span className={pastDue ? 'due-past' : 'due-future'}>
                          {' · '}<Calendar size={11} /> {formatDueDate(a.due_at)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="assignment-actions">
                    <Link to={`/assignment/${a.id}`} state={{ studentName }} className="btn btn-small">
                      <Play size={14} /> {pastDue ? 'View' : 'Take'}
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
