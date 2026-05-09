import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader2, CheckCircle2, XCircle, RotateCcw, BookOpen, Video, Clock, ArrowLeft } from 'lucide-react'
import { getPublicQuiz, submitQuiz, formatTimestamp, youtubeLinkAt } from '../api'

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard', mixed: 'Mixed' }

export default function PublicQuiz() {
  const { quizId } = useParams()
  const [quiz, setQuiz] = useState(null)
  const [answers, setAnswers] = useState({})
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadQuiz()
  }, [quizId])

  const loadQuiz = async () => {
    setLoading(true)
    try {
      const data = await getPublicQuiz(quizId)
      setQuiz(data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Quiz not found.')
    } finally {
      setLoading(false)
    }
  }

  const handleAnswer = (qid, value) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }))
  }

  const handleSubmit = async () => {
    if (Object.keys(answers).length < quiz.questions.length) {
      if (!confirm("You haven't answered all questions. Submit anyway?")) return
    }
    setSubmitting(true)
    setError('')
    try {
      const payload = quiz.questions.map((q) => ({
        question_id: q.id,
        user_answer: answers[q.id] || '',
      }))
      const data = await submitQuiz(quiz.id, payload)
      setResults(data)
      window.scrollTo(0, 0)
    } catch (err) {
      setError(err.response?.data?.detail || 'Error submitting quiz.')
    } finally {
      setSubmitting(false)
    }
  }

  const retake = () => {
    setAnswers({})
    setResults(null)
    window.scrollTo(0, 0)
  }

  if (loading) {
    return (
      <div className="container">
        <div className="card center-text">
          <Loader2 size={24} className="spinner" />
          <p>Loading quiz...</p>
        </div>
      </div>
    )
  }

  if (error || !quiz) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error || 'Quiz not found'}</div>
        <Link to="/" className="btn btn-secondary">
          <ArrowLeft size={16} /> Back to home
        </Link>
      </div>
    )
  }

  const videoId = quiz.youtube_video_id
  const answeredCount = Object.values(answers).filter((a) => a && a.trim()).length

  // Results view
  if (results) {
    const { score, total, percentage } = results
    const message =
      percentage >= 80 ? '🎉 Excellent!' :
      percentage >= 60 ? '👍 Good job!' :
      percentage >= 40 ? '📖 Keep practicing' : '💪 Keep studying!'
    return (
      <div className="container">
        <div className="score-banner">
          <div className="score-number">{percentage}%</div>
          <div className="score-label">{score} out of {total} correct</div>
          <div style={{ marginTop: '1rem', fontSize: '1.1rem' }}>{message}</div>
        </div>
        {results.results.map((r, idx) => {
          const q = quiz.questions.find((x) => x.id === r.question_id)
          return (
            <div key={r.question_id} className={`question-card result-card ${r.is_correct ? 'correct' : 'incorrect'}`}>
              <div className="question-header">
                <span className="question-number">Question {idx + 1}</span>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <TimestampLink videoId={videoId} seconds={r.timestamp_seconds} />
                  <div className={`result-icon ${r.is_correct ? 'correct' : 'incorrect'}`}>
                    {r.is_correct ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                    {r.is_correct ? 'Correct' : 'Incorrect'}
                  </div>
                </div>
              </div>
              <div className="question-text">{r.question}</div>
              {q && q.options && (
                <div>
                  {q.options.map((opt, i) => {
                    let cls = 'option'
                    if (opt === r.correct_answer) cls += ' correct'
                    else if (opt === r.user_answer && !r.is_correct) cls += ' incorrect'
                    return <div key={i} className={cls}><span>{opt}</span></div>
                  })}
                </div>
              )}
              {q && !q.options && (
                <>
                  <div className="text-info" style={{ marginTop: '0.5rem' }}><strong>Your answer:</strong> {r.user_answer || '(blank)'}</div>
                  <div className="text-info"><strong>Correct answer:</strong> {r.correct_answer}</div>
                </>
              )}
              <div className="explanation">
                <strong>Explanation:</strong> {r.explanation}
                {r.source_chunk && <div className="source-quote">"{r.source_chunk}"</div>}
              </div>
            </div>
          )
        })}
        <div className="button-row">
          <button className="btn" onClick={retake}><RotateCcw size={18} /> Try Again</button>
          <Link to="/app" className="btn btn-secondary">Create Your Own Quiz</Link>
        </div>
      </div>
    )
  }

  // Quiz-taking view
  return (
    <div className="container">
      <div className="card">
        <h2>
          <BookOpen size={20} /> {quiz.title}
          {quiz.source_type === 'youtube' && (
            <span className="badge badge-medium" style={{ marginLeft: '0.5rem' }}>
              <Video size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} /> YouTube
            </span>
          )}
        </h2>
        <div className="text-info">{answeredCount} / {quiz.questions.length} answered · Shared quiz</div>
      </div>

      {quiz.questions.map((q, idx) => (
        <div key={q.id} className="question-card">
          <div className="question-header">
            <span className="question-number">Question {idx + 1} / {quiz.questions.length}</span>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <TimestampLink videoId={videoId} seconds={q.timestamp_seconds} />
              <span className={`badge badge-${q.difficulty}`}>{DIFFICULTY_LABELS[q.difficulty] || q.difficulty}</span>
            </div>
          </div>
          <div className="question-text">{q.question}</div>
          {q.type === 'multiple_choice' && q.options && (
            <div>
              {q.options.map((opt, i) => (
                <label key={i} className={`option ${answers[q.id] === opt ? 'selected' : ''}`}>
                  <input type="radio" name={q.id} checked={answers[q.id] === opt} onChange={() => handleAnswer(q.id, opt)} />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          )}
          {q.type === 'true_false' && (
            <div>
              {['True', 'False'].map((opt) => (
                <label key={opt} className={`option ${answers[q.id] === opt ? 'selected' : ''}`}>
                  <input type="radio" name={q.id} checked={answers[q.id] === opt} onChange={() => handleAnswer(q.id, opt)} />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          )}
          {q.type === 'short_answer' && (
            <input className="input" placeholder="Type your answer..." value={answers[q.id] || ''} onChange={(e) => handleAnswer(q.id, e.target.value)} />
          )}
        </div>
      ))}

      <div className="button-row">
        <button className="btn" onClick={handleSubmit} disabled={submitting}>
          {submitting ? <><Loader2 size={18} className="spinner" /> Scoring...</> : <><CheckCircle2 size={18} /> Submit Quiz</>}
        </button>
        <Link to="/" className="btn btn-secondary">Cancel</Link>
      </div>
    </div>
  )
}

function TimestampLink({ videoId, seconds }) {
  if (videoId == null || seconds == null) return null
  const url = youtubeLinkAt(videoId, seconds)
  return (
    <a className="timestamp-link" href={url} target="_blank" rel="noopener noreferrer" title="Open at this timestamp">
      <Clock size={13} /> {formatTimestamp(seconds)}
    </a>
  )
}
