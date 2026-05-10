import { useState, useEffect } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import {
  Loader2, CheckCircle2, XCircle, RotateCcw, BookOpen, Video as Youtube,
  Clock, ArrowLeft, Calendar, Trophy,
} from 'lucide-react'
import {
  getAssignment, submitAssignment, formatTimestamp, youtubeLinkAt, fireConfetti,
} from '../api'

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard', mixed: 'Mixed' }
const STORAGE_STUDENT = 'driquiz_student_name'

export default function AssignmentTake() {
  const { assignmentId } = useParams()
  const location = useLocation()
  const [bundle, setBundle] = useState(null)
  const [answers, setAnswers] = useState({})
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const studentName = location.state?.studentName || localStorage.getItem(STORAGE_STUDENT) || ''

  useEffect(() => { load() }, [assignmentId])

  const load = async () => {
    setLoading(true)
    try {
      const data = await getAssignment(assignmentId)
      setBundle(data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Assignment not found.')
    } finally {
      setLoading(false)
    }
  }

  const handleAnswer = (qid, value) => {
    setAnswers(prev => ({ ...prev, [qid]: value }))
  }

  const handleSubmit = async () => {
    if (!studentName.trim()) {
      alert('Please join the class first to identify yourself.')
      return
    }
    if (Object.keys(answers).length < bundle.quiz.questions.length) {
      if (!confirm("You haven't answered all questions. Submit anyway?")) return
    }
    setSubmitting(true)
    setError('')
    try {
      const payload = bundle.quiz.questions.map(q => ({
        question_id: q.id,
        user_answer: answers[q.id] || '',
      }))
      const data = await submitAssignment(assignmentId, studentName, payload)
      setResults(data)
      window.scrollTo(0, 0)
      if (data.percentage >= 80) fireConfetti('high')
      else if (data.percentage >= 60) fireConfetti('normal')
    } catch (err) {
      setError(err.response?.data?.detail || 'Error submitting.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="container">
        <div className="card center-text"><Loader2 size={20} className="spinner" /></div>
      </div>
    )
  }

  if (error || !bundle) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error || 'Not found'}</div>
        <Link to="/join" className="btn btn-secondary"><ArrowLeft size={16} /> Back</Link>
      </div>
    )
  }

  const { assignment, quiz, class: cls } = bundle
  const videoId = quiz.youtube_video_id
  const pastDue = assignment.due_at && new Date(assignment.due_at) < new Date()

  // RESULTS VIEW
  if (results) {
    const { score, total, percentage, student_name } = results
    const message =
      percentage >= 80 ? '🎉 Excellent!' :
      percentage >= 60 ? '👍 Good job!' :
      percentage >= 40 ? '📖 Keep practicing' : '💪 Keep studying!'

    return (
      <div className="container">
        <div className="score-banner">
          <div className="score-number">{percentage}%</div>
          <div className="score-label">{score} out of {total} correct</div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.95rem', color: 'var(--accent-light)' }}>
            <strong>{student_name}</strong> · {cls.name}
          </div>
          <div style={{ marginTop: '1rem', fontSize: '1.1rem' }}>{message}</div>
        </div>

        {results.results.map((r, idx) => {
          const q = quiz.questions.find(x => x.id === r.question_id)
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
                    let cls2 = 'option'
                    if (opt === r.correct_answer) cls2 += ' correct'
                    else if (opt === r.user_answer && !r.is_correct) cls2 += ' incorrect'
                    return <div key={i} className={cls2}><span>{opt}</span></div>
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
          <Link to={`/student/class/${cls.id}`} className="btn btn-secondary">
            <ArrowLeft size={16} /> Back to class
          </Link>
        </div>
      </div>
    )
  }

  // QUIZ-TAKING VIEW
  const answeredCount = Object.values(answers).filter(a => a && a.trim()).length

  return (
    <div className="container">
      <Link to={`/student/class/${cls.id}`} className="back-link"><ArrowLeft size={14} /> Back to class</Link>

      <div className="card">
        <h2>
          <BookOpen size={20} /> {quiz.title}
          {quiz.source_type === 'youtube' && (
            <span className="badge badge-medium" style={{ marginLeft: '0.5rem' }}>
              <Youtube size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} /> YouTube
            </span>
          )}
        </h2>
        <div className="text-info">
          {cls.name} · Submitting as <strong>{studentName || '...'}</strong>
        </div>
        {assignment.due_at && (
          <div className={`text-info ${pastDue ? 'due-past' : 'due-future'}`} style={{ marginTop: '0.5rem' }}>
            <Calendar size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} />
            {pastDue ? 'Past due ' : 'Due '}
            {new Date(assignment.due_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        <div className="text-info" style={{ marginTop: '0.5rem' }}>
          {answeredCount} / {quiz.questions.length} answered
        </div>
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
              {['True', 'False'].map(opt => (
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
          {submitting ? <><Loader2 size={18} className="spinner" /> Submitting...</> : <><Trophy size={18} /> Submit Assignment</>}
        </button>
        <Link to={`/student/class/${cls.id}`} className="btn btn-secondary">Cancel</Link>
      </div>
    </div>
  )
}

function TimestampLink({ videoId, seconds }) {
  if (videoId == null || seconds == null) return null
  return (
    <a className="timestamp-link" href={youtubeLinkAt(videoId, seconds)} target="_blank" rel="noopener noreferrer">
      <Clock size={13} /> {formatTimestamp(seconds)}
    </a>
  )
}
