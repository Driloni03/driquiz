import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Loader2, CheckCircle2, XCircle, RotateCcw, BookOpen, Video as Youtube,
  Clock, ArrowLeft, Trophy, Share2, Lightbulb, X, Sparkles, Medal,
  GraduationCap, Send, Calendar,
} from 'lucide-react'
import {
  getPublicQuiz, submitToLeaderboard, getLeaderboard,
  formatTimestamp, youtubeLinkAt, streamEli5, fireConfetti,
  listClasses, createAssignment,
} from '../api'

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard', mixed: 'Mixed' }

export default function PublicQuiz() {
  const { quizId } = useParams()
  const [quiz, setQuiz] = useState(null)
  const [answers, setAnswers] = useState({})
  const [results, setResults] = useState(null)
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [showPushModal, setShowPushModal] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => { loadQuiz() }, [quizId])

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
    setAnswers(prev => ({ ...prev, [qid]: value }))
  }

  const handleSubmit = async () => {
    if (Object.keys(answers).length < quiz.questions.length) {
      if (!confirm("You haven't answered all questions. Submit anyway?")) return
    }
    setSubmitting(true)
    setError('')
    try {
      const payload = quiz.questions.map(q => ({
        question_id: q.id,
        user_answer: answers[q.id] || '',
      }))
      const data = await submitToLeaderboard(quiz.id, payload, displayName.trim() || null)
      setResults(data)
      window.scrollTo(0, 0)
      // Confetti for high scores
      if (data.percentage >= 80) {
        fireConfetti('high')
      } else if (data.percentage >= 60) {
        fireConfetti('normal')
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Error submitting quiz.')
    } finally {
      setSubmitting(false)
    }
  }

  const retake = () => {
    setAnswers({})
    setResults(null)
    setShowLeaderboard(false)
    window.scrollTo(0, 0)
  }

  const copyShareLink = async () => {
    const url = `${window.location.origin}/q/${quiz.id}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (_) {
      prompt('Copy link:', url)
    }
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
  const answeredCount = Object.values(answers).filter(a => a && a.trim()).length

  // ============= RESULTS VIEW =============
  if (results) {
    const { score, total, percentage, display_name } = results
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
            <strong>{display_name}</strong> on the leaderboard
          </div>
          <div style={{ marginTop: '1rem', fontSize: '1.1rem' }}>{message}</div>
        </div>

        <div className="button-row" style={{ marginBottom: '1.5rem', justifyContent: 'center' }}>
          <button className="btn btn-secondary" onClick={() => setShowLeaderboard(true)}>
            <Trophy size={16} /> View Leaderboard
          </button>
          <button className="btn btn-secondary" onClick={copyShareLink}>
            <Share2 size={16} /> {copied ? 'Copied!' : 'Share'}
          </button>
        </div>

        {showLeaderboard && <LeaderboardModal quizId={quiz.id} myName={display_name} onClose={() => setShowLeaderboard(false)} />}

        {results.results.map((r, idx) => (
          <ResultCard key={r.question_id} result={r} idx={idx} quiz={quiz} videoId={videoId} />
        ))}

        <div className="button-row">
          <button className="btn" onClick={retake}><RotateCcw size={18} /> Try Again</button>
          <Link to="/app" className="btn btn-secondary">Create Your Own Quiz</Link>
        </div>
      </div>
    )
  }

  // ============= QUIZ-TAKING VIEW =============
  return (
    <div className="container">
      <div className="card">
        <h2>
          <BookOpen size={20} /> {quiz.title}
          {quiz.source_type === 'youtube' && (
            <span className="badge badge-medium" style={{ marginLeft: '0.5rem' }}>
              <Youtube size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} /> YouTube
            </span>
          )}
        </h2>
        <div className="text-info" style={{ marginBottom: '0.85rem' }}>
          {answeredCount} / {quiz.questions.length} answered
        </div>

        <div className="field">
          <label className="label">Your name (optional, for leaderboard)</label>
          <input
            className="input"
            placeholder="Leave blank for a random animal name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
          />
        </div>

        <div className="button-row">
          <button className="btn btn-secondary btn-small" onClick={() => setShowLeaderboard(true)}>
            <Trophy size={14} /> View Leaderboard
          </button>
          <button className="btn btn-secondary btn-small" onClick={copyShareLink}>
            <Share2 size={14} /> {copied ? 'Copied!' : 'Share Quiz'}
          </button>
          <button className="btn btn-secondary btn-small" onClick={() => setShowPushModal(true)}>
            <GraduationCap size={14} /> Push to class
          </button>
        </div>
      </div>

      {showLeaderboard && <LeaderboardModal quizId={quiz.id} onClose={() => setShowLeaderboard(false)} />}
      {showPushModal && <PushToClassModal quizId={quiz.id} quizTitle={quiz.title} onClose={() => setShowPushModal(false)} />}

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
          {submitting ? <><Loader2 size={18} className="spinner" /> Scoring...</> : <><CheckCircle2 size={18} /> Submit Quiz</>}
        </button>
        <Link to="/" className="btn btn-secondary">Cancel</Link>
      </div>
    </div>
  )
}

/* ============================================================
   ResultCard with ELI5 button
   ============================================================ */
function ResultCard({ result: r, idx, quiz, videoId }) {
  const q = quiz.questions.find(x => x.id === r.question_id)
  const [eli5, setEli5] = useState('')
  const [eli5Loading, setEli5Loading] = useState(false)
  const abortRef = useRef(null)

  const askEli5 = async () => {
    if (eli5Loading) return
    setEli5Loading(true)
    setEli5('')
    abortRef.current = new AbortController()
    try {
      await streamEli5({
        question: r.question,
        answer: r.correct_answer,
        original_explanation: r.explanation,
        signal: abortRef.current.signal,
        onDelta: (delta) => setEli5(prev => prev + delta),
      })
    } catch (err) {
      if (err.name !== 'AbortError') setEli5('Error: ' + err.message)
    } finally {
      setEli5Loading(false)
    }
  }

  return (
    <div className={`question-card result-card ${r.is_correct ? 'correct' : 'incorrect'}`}>
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

      {!eli5 && !eli5Loading && (
        <button className="btn-ghost-small" onClick={askEli5}>
          <Lightbulb size={13} /> Explain like I'm 5
        </button>
      )}

      {(eli5 || eli5Loading) && (
        <div className="eli5-box">
          <div className="eli5-header">
            <Lightbulb size={14} /> Simpler explanation
            {eli5Loading && <Loader2 size={12} className="spinner" />}
          </div>
          <div className="eli5-text">{eli5}</div>
        </div>
      )}
    </div>
  )
}

/* ============================================================
   Leaderboard modal
   ============================================================ */
function LeaderboardModal({ quizId, myName, onClose }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const data = await getLeaderboard(quizId)
        setEntries(data.entries)
        setTitle(data.title)
      } catch (_) {}
      setLoading(false)
    })()
  }, [quizId])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><Trophy size={18} /> Leaderboard</h3>
          <button className="chat-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-subtitle">{title}</div>
        <div className="modal-body">
          {loading && <div className="center-text"><Loader2 size={20} className="spinner" /></div>}
          {!loading && entries.length === 0 && (
            <p className="text-info center-text">No entries yet. Be the first!</p>
          )}
          {!loading && entries.length > 0 && (
            <ol className="leaderboard-list">
              {entries.map((e, idx) => {
                const isMe = myName && e.display_name === myName
                return (
                  <li key={idx} className={`leaderboard-row ${isMe ? 'me' : ''}`}>
                    <div className="leaderboard-rank">
                      {idx === 0 && <Medal size={16} style={{ color: '#fbbf24' }} />}
                      {idx === 1 && <Medal size={16} style={{ color: '#d4d0e0' }} />}
                      {idx === 2 && <Medal size={16} style={{ color: '#cd7f32' }} />}
                      {idx > 2 && <span className="leaderboard-rank-num">{idx + 1}</span>}
                    </div>
                    <div className="leaderboard-name">
                      {e.display_name}
                      {isMe && <span className="leaderboard-me-tag">you</span>}
                    </div>
                    <div className="leaderboard-score">
                      <strong>{e.percentage}%</strong> <span className="text-info">({e.score}/{e.total})</span>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
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

/* ============================================================
   Push to Class modal
   ============================================================ */
function PushToClassModal({ quizId, quizTitle, onClose }) {
  const [classes, setClasses] = useState([])
  const [classId, setClassId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('23:59')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    listClasses()
      .then(setClasses)
      .catch(() => setError('Could not load classes.'))
      .finally(() => setLoading(false))
  }, [])

  const submit = async () => {
    if (!classId) {
      setError('Pick a class.')
      return
    }
    setError('')
    setBusy(true)
    try {
      let due_at = null
      if (dueDate) due_at = new Date(`${dueDate}T${dueTime}`).toISOString()
      await createAssignment(classId, quizId, due_at)
      setSuccess(true)
      setTimeout(onClose, 1500)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not assign.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3><GraduationCap size={18} /> Push to a class</h3>
          <button className="chat-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-subtitle">"{quizTitle}"</div>
        <div className="modal-body">
          {success ? (
            <div className="alert alert-success" style={{ textAlign: 'center' }}>
              ✅ Assignment created! Students in the class can now take this quiz.
            </div>
          ) : (
            <>
              {error && <div className="alert alert-error">⚠️ {error}</div>}
              {loading ? (
                <div className="center-text"><Loader2 size={20} className="spinner" /></div>
              ) : classes.length === 0 ? (
                <div className="text-info center-text" style={{ padding: '1rem' }}>
                  No classes yet. <Link to="/teacher" style={{ color: 'var(--accent-light)' }}>Create one in the teacher dashboard</Link>.
                </div>
              ) : (
                <>
                  <div className="field">
                    <label className="label">Class</label>
                    <select className="select" value={classId} onChange={e => setClassId(e.target.value)}>
                      <option value="">— Select —</option>
                      {classes.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.student_count} student{c.student_count === 1 ? '' : 's'})
                        </option>
                      ))}
                    </select>
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
                    <button className="btn" onClick={submit} disabled={busy || !classId}>
                      {busy ? <><Loader2 size={16} className="spinner" /> Assigning...</> : <><Send size={16} /> Assign to class</>}
                    </button>
                    <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

