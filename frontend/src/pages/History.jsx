import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Sparkles, FileText, Video, Clock, Share2, Play } from 'lucide-react'
import { listQuizzes } from '../api'

export default function History() {
  const [quizzes, setQuizzes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState(null)

  useEffect(() => {
    loadQuizzes()
  }, [])

  const loadQuizzes = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listQuizzes()
      setQuizzes(data)
    } catch (err) {
      setError('Could not load quiz history.')
    } finally {
      setLoading(false)
    }
  }

  const copyShareLink = async (quizId) => {
    const url = `${window.location.origin}/q/${quizId}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(quizId)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (_) {
      prompt('Copy this share link:', url)
    }
  }

  const formatDate = (iso) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    } catch (_) { return iso }
  }

  const sourceIcon = (type) => {
    if (type === 'youtube') return <Video size={14} />
    if (type === 'pdf') return <FileText size={14} />
    return <Sparkles size={14} />
  }

  return (
    <div className="container">
      <div className="header">
        <h1>Your quizzes</h1>
        <p>{quizzes.length} {quizzes.length === 1 ? 'quiz' : 'quizzes'} saved · Click to retake or share</p>
      </div>

      {loading && (
        <div className="card center-text">
          <Loader2 size={24} className="spinner" />
          <p>Loading...</p>
        </div>
      )}

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {!loading && quizzes.length === 0 && (
        <div className="card center-text">
          <p style={{ marginBottom: '1rem' }}>No quizzes yet.</p>
          <Link to="/app" className="btn">
            <Sparkles size={16} /> Create your first quiz
          </Link>
        </div>
      )}

      {!loading && quizzes.length > 0 && (
        <div className="quiz-list">
          {quizzes.map((q) => (
            <div key={q.id} className="quiz-row">
              <div className="quiz-row-main">
                <div className="quiz-row-icon">{sourceIcon(q.source_type)}</div>
                <div className="quiz-row-info">
                  <div className="quiz-row-title">{q.title}</div>
                  <div className="quiz-row-meta">
                    <Clock size={11} /> {formatDate(q.created_at)} · {q.num_questions} questions · {q.source_type}
                  </div>
                </div>
              </div>
              <div className="quiz-row-actions">
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => copyShareLink(q.id)}
                  title="Copy public share link"
                >
                  <Share2 size={14} />
                  {copiedId === q.id ? 'Copied!' : 'Share'}
                </button>
                <Link to={`/q/${q.id}`} className="btn btn-small">
                  <Play size={14} /> Take
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
