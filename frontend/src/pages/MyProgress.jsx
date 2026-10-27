import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader2, BarChart3, Trophy, Layers, GraduationCap, Sparkles, Play, Clock, TrendingUp,
} from 'lucide-react'
import { getMyProgress, getMyLibrary, getAuthUser } from '../api'

// Personal page of a signed-in account: saved materials, results over time,
// classes joined and the flashcard decks with cards due for review.
const scoreColor = (pct) => (pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444')

const formatDate = (iso) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch (_) { return iso }
}

export default function MyProgress() {
  const user = getAuthUser()
  const [progress, setProgress] = useState(null)
  const [library, setLibrary] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([getMyProgress(), getMyLibrary()])
      .then(([p, l]) => { setProgress(p); setLibrary(l) })
      .catch((err) => setError(err.response?.data?.detail || 'Could not load your progress.'))
  }, [])

  if (error) {
    return <div className="container"><div className="alert alert-error">⚠️ {error}</div></div>
  }
  if (!progress || !library) {
    return (
      <div className="container">
        <div className="card center-text"><Loader2 size={20} className="spinner" /><p>Loading your progress...</p></div>
      </div>
    )
  }

  const attempts = progress.attempts
  const totalItems = library.quizzes.length + library.flashcard_sets.length + library.notes.length
  const dueCards = progress.flashcard_decks.reduce((sum, d) => sum + (d.due || 0), 0)

  return (
    <div className="container">
      <div className="header">
        <h1><BarChart3 size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} /> My progress</h1>
        <p>Hi {user?.name}. Everything here is saved to your account and available on any device.</p>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon"><Sparkles size={20} /></div>
          <div className="stat-value">{totalItems}</div>
          <div className="stat-label">Saved materials</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><TrendingUp size={20} /></div>
          <div className="stat-value" style={{ color: progress.average_percentage != null ? scoreColor(progress.average_percentage) : undefined }}>
            {progress.average_percentage != null ? `${progress.average_percentage}%` : '—'}
          </div>
          <div className="stat-label">Average score ({attempts.length} attempts)</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><Layers size={20} /></div>
          <div className="stat-value">{dueCards}</div>
          <div className="stat-label">Flashcards due today</div>
        </div>
      </div>

      <div className="card">
        <h2><Trophy size={18} /> Results over time</h2>
        {attempts.length === 0 ? (
          <p className="text-info">No results yet. Take one of your sets or a class assignment and it will appear here.</p>
        ) : (
          <div className="submission-list">
            {attempts.map((a, i) => (
              <div key={i} className="submission-row">
                <div className="submission-info">
                  <div className="submission-name">{a.quiz_title}</div>
                  <div className="submission-time">
                    {formatDate(a.created_at)}{a.class_name ? ` · class: ${a.class_name}` : ' · practice'}
                  </div>
                </div>
                <div className="submission-score" style={{ color: scoreColor(a.percentage) }}>
                  <strong>{a.percentage}%</strong>
                  <span className="submission-fraction">{a.score}/{a.total}</span>
                </div>
                <Link to={`/q/${a.quiz_id}`} className="btn btn-secondary btn-small" style={{ marginLeft: '0.75rem' }}>
                  <Play size={14} /> Again
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2><Layers size={18} /> Flashcard decks</h2>
        {progress.flashcard_decks.length === 0 ? (
          <p className="text-info">Study a flashcard set while signed in and your review schedule will be kept here.</p>
        ) : (
          <div className="quiz-list">
            {progress.flashcard_decks.map((d) => (
              <div key={d.set_id} className="quiz-row">
                <div className="quiz-row-main">
                  <div className="quiz-row-icon"><Layers size={14} /></div>
                  <div className="quiz-row-info">
                    <div className="quiz-row-title">{d.title}</div>
                    <div className="quiz-row-meta">{d.reviewed} cards reviewed · {d.due || 0} due now</div>
                  </div>
                </div>
                <div className="quiz-row-actions">
                  <Link to={`/flashcards/${d.set_id}`} className="btn btn-small"><Play size={14} /> Review</Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2><GraduationCap size={18} /> My classes</h2>
        {progress.classes.length === 0 ? (
          <p className="text-info">You haven't joined a class yet. <Link to="/join">Join with a code</Link>.</p>
        ) : (
          <div className="quiz-list">
            {progress.classes.map((c) => (
              <div key={c.id} className="quiz-row">
                <div className="quiz-row-main">
                  <div className="quiz-row-icon"><GraduationCap size={14} /></div>
                  <div className="quiz-row-info">
                    <div className="quiz-row-title">{c.name}</div>
                    <div className="quiz-row-meta"><Clock size={11} /> joined {formatDate(c.joined_at)} · teacher {c.teacher_name}</div>
                  </div>
                </div>
                <div className="quiz-row-actions">
                  <Link to={`/student/class/${c.id}`} state={{ studentName: user?.name }} className="btn btn-small">Open</Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="button-row" style={{ justifyContent: 'center' }}>
        <Link to="/history" className="btn btn-secondary">All my materials</Link>
        <Link to="/app" className="btn">Create something new</Link>
      </div>
    </div>
  )
}
