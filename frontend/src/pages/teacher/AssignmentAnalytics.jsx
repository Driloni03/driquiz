import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  BarChart3, Loader2, ArrowLeft, Download, Trophy, Users, TrendingUp,
} from 'lucide-react'
import { getAssignmentAnalytics, exportAssignmentCsvUrl } from '../../api'

export default function AssignmentAnalytics() {
  const { assignmentId } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { load() }, [assignmentId])

  const load = async () => {
    setLoading(true)
    try {
      const result = await getAssignmentAnalytics(assignmentId)
      setData(result)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load analytics.')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (iso) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    } catch (_) { return iso }
  }

  const scoreColor = (pct) => {
    if (pct >= 80) return 'var(--success)'
    if (pct >= 60) return 'var(--accent-light)'
    if (pct >= 40) return '#fbbf24'
    return 'var(--error)'
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
        <div className="alert alert-error">⚠️ {error || 'Not found'}</div>
        <Link to="/teacher" className="btn btn-secondary"><ArrowLeft size={16} /> Back</Link>
      </div>
    )
  }

  return (
    <div className="container">
      <Link to="/teacher" className="back-link"><ArrowLeft size={14} /> Dashboard</Link>

      <div className="header">
        <h1><BarChart3 size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} /> {data.quiz_title}</h1>
        <p>Assignment analytics</p>
      </div>

      {/* Summary stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon"><Users size={20} /></div>
          <div className="stat-value">{data.total_submissions}</div>
          <div className="stat-label">Submissions</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><TrendingUp size={20} /></div>
          <div className="stat-value" style={{ color: scoreColor(data.average_pct) }}>
            {data.average_pct}%
          </div>
          <div className="stat-label">Class average</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><Trophy size={20} /></div>
          <div className="stat-value">
            {data.submissions[0]?.percentage ?? 0}%
          </div>
          <div className="stat-label">Top score</div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}><Trophy size={20} /> Submissions ({data.total_submissions})</h2>
          {data.total_submissions > 0 && (
            <a className="btn btn-secondary btn-small" href={exportAssignmentCsvUrl(assignmentId)} target="_blank" rel="noopener">
              <Download size={14} /> CSV
            </a>
          )}
        </div>

        {data.submissions.length === 0 ? (
          <p className="text-info center-text" style={{ padding: '1rem' }}>
            No submissions yet. When students take this quiz, their scores appear here.
          </p>
        ) : (
          <div className="submission-list">
            {data.submissions.map((s, i) => (
              <div key={i} className="submission-row">
                <div className="submission-rank">
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                </div>
                <div className="submission-info">
                  <div className="submission-name">{s.display_name}</div>
                  <div className="submission-time">{formatDate(s.created_at)}</div>
                </div>
                <div className="submission-score" style={{ color: scoreColor(s.percentage) }}>
                  <strong>{s.percentage}%</strong>
                  <span className="submission-fraction">{s.score}/{s.total}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2><BarChart3 size={20} /> Questions ({data.questions.length})</h2>
        <p className="text-info" style={{ marginBottom: '1rem' }}>
          Review which questions to focus on in your next lesson.
        </p>
        <ol className="question-summary-list">
          {data.questions.map((q, i) => (
            <li key={q.id} className="question-summary-row">
              <div className="question-summary-num">{i + 1}</div>
              <div className="question-summary-info">
                <div className="question-summary-text">{q.question}</div>
                <div className="question-summary-meta">
                  <strong>Answer:</strong> {q.correct_answer} · <span className={`badge badge-${q.difficulty || 'medium'}`}>{q.difficulty}</span> · {q.type.replace('_', ' ')}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
