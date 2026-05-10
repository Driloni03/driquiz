import { useState, useEffect, useRef } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import {
  Loader2, CheckCircle2, XCircle, Trophy, Zap, Users, Clock, Medal,
} from 'lucide-react'
import { getLiveState, submitLiveAnswer, fireConfetti } from '../../api'

const POLL_MS = 1500
const STORAGE_PLAYER = 'driquiz_live_player_name'

export default function LivePlay() {
  const { sessionId } = useParams()
  const location = useLocation()
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [lastAnswered, setLastAnswered] = useState(null)
  const pollingRef = useRef(null)
  const lastConfettiRef = useRef(-1)

  const playerId = location.state?.playerId
  const playerName = location.state?.playerName || localStorage.getItem(STORAGE_PLAYER) || 'Player'

  useEffect(() => {
    if (!playerId) {
      setError('Player ID missing — please rejoin via the code.')
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const data = await getLiveState(sessionId, playerId)
        if (!cancelled) {
          setState(data)
          setError('')
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.detail || 'Could not connect to game.')
        }
      }
    }
    poll()
    pollingRef.current = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [sessionId, playerId])

  // Confetti when finished and player is in top 3
  useEffect(() => {
    if (state?.session?.state === 'finished' && lastConfettiRef.current !== state.session.current_question_index) {
      lastConfettiRef.current = state.session.current_question_index
      const sorted = [...(state.players || [])].sort((a, b) => b.score - a.score)
      const myRank = sorted.findIndex(p => p.id === playerId)
      if (myRank >= 0 && myRank < 3) {
        fireConfetti('high')
      }
    }
  }, [state, playerId])

  const submit = async (answer) => {
    if (submitting || !state || state.session.state !== 'question') return
    setSubmitting(true)
    try {
      const data = await submitLiveAnswer(sessionId, playerId, state.session.current_question_index, answer)
      setLastAnswered({ answer, isCorrect: data.is_correct, points: data.points, qIndex: state.session.current_question_index })
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not submit.')
    } finally {
      setSubmitting(false)
    }
  }

  if (error && !state) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error}</div>
        <Link to="/live" className="btn btn-secondary">Try again</Link>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="container">
        <div className="card center-text">
          <Loader2 size={20} className="spinner" />
          <p style={{ marginTop: '0.75rem' }}>Connecting...</p>
        </div>
      </div>
    )
  }

  const { session, quiz_title, current_question, reveal, players, student_answer, total_questions } = state
  const me = players.find(p => p.id === playerId)
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score)
  const myRank = sortedPlayers.findIndex(p => p.id === playerId) + 1

  // ============ LOBBY ============
  if (session.state === 'lobby') {
    return (
      <div className="container">
        <div className="header">
          <h1><Zap size={28} style={{ verticalAlign: 'middle', marginRight: 8, color: 'var(--accent-light)' }} /> {quiz_title}</h1>
          <p>Hi <strong>{playerName}</strong> · Waiting for teacher to start...</p>
        </div>

        <div className="card center-text" style={{ padding: '2rem 1rem' }}>
          <div className="live-waiting-pulse">
            <Loader2 size={32} className="spinner" style={{ color: 'var(--accent-light)' }} />
          </div>
          <p style={{ marginTop: '1rem', fontSize: '1.05rem' }}>Get ready!</p>
          <div className="text-info" style={{ marginTop: '0.5rem' }}>
            <Users size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {players.length} player{players.length === 1 ? '' : 's'} in lobby
          </div>
        </div>
      </div>
    )
  }

  // ============ FINISHED ============
  if (session.state === 'finished') {
    return (
      <div className="container">
        <div className="score-banner">
          <Trophy size={48} style={{ color: 'var(--accent-light)', marginBottom: '0.5rem' }} />
          <div className="score-number" style={{ fontSize: '2.5rem' }}>
            #{myRank}
          </div>
          <div className="score-label">{me?.score ?? 0} points · {playerName}</div>
          {myRank === 1 && <div style={{ marginTop: '1rem', fontSize: '1.2rem' }}>🥇 You won!</div>}
          {myRank === 2 && <div style={{ marginTop: '1rem', fontSize: '1.2rem' }}>🥈 Second place!</div>}
          {myRank === 3 && <div style={{ marginTop: '1rem', fontSize: '1.2rem' }}>🥉 Third place!</div>}
        </div>

        <div className="card">
          <h2><Trophy size={20} /> Leaderboard</h2>
          <ol className="leaderboard-list">
            {sortedPlayers.map((p, i) => {
              const isMe = p.id === playerId
              return (
                <li key={p.id} className={`leaderboard-row ${isMe ? 'me' : ''}`}>
                  <div className="leaderboard-rank">
                    {i === 0 && <Medal size={16} style={{ color: '#fbbf24' }} />}
                    {i === 1 && <Medal size={16} style={{ color: '#d4d0e0' }} />}
                    {i === 2 && <Medal size={16} style={{ color: '#cd7f32' }} />}
                    {i > 2 && <span className="leaderboard-rank-num">{i + 1}</span>}
                  </div>
                  <div className="leaderboard-name">
                    {p.player_name}
                    {isMe && <span className="leaderboard-me-tag">you</span>}
                  </div>
                  <div className="leaderboard-score">
                    <strong>{p.score}</strong> <span className="text-info">pts</span>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>

        <div className="button-row">
          <Link to="/" className="btn btn-secondary">Home</Link>
        </div>
      </div>
    )
  }

  // ============ QUESTION ============
  const isReveal = session.state === 'reveal'
  const myAnswer = student_answer?.answer
  const myCorrect = student_answer?.is_correct

  return (
    <div className="container">
      <div className="live-host-header">
        <div className="live-host-meta">
          Question {session.current_question_index + 1} of {total_questions}
        </div>
        <div className="live-host-progress">
          <div className="live-host-progress-fill" style={{ width: `${((session.current_question_index + 1) / total_questions) * 100}%` }} />
        </div>
      </div>

      {/* Score banner */}
      <div className="live-score-bar">
        <div>
          <strong>{playerName}</strong> · #{myRank}
        </div>
        <div className="live-score-points">
          {me?.score ?? 0} pts
        </div>
      </div>

      {current_question && (
        <div className="card live-question-card">
          <div className="live-question-text">{current_question.question}</div>

          {!myAnswer && !isReveal && (
            <>
              {current_question.type === 'multiple_choice' && current_question.options && (
                <div className="live-options-grid">
                  {current_question.options.map((opt, i) => (
                    <button
                      key={i}
                      className="live-option-btn"
                      onClick={() => submit(opt)}
                      disabled={submitting}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              {current_question.type === 'true_false' && (
                <div className="live-options-grid">
                  {['True', 'False'].map(opt => (
                    <button
                      key={opt}
                      className="live-option-btn"
                      onClick={() => submit(opt)}
                      disabled={submitting}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {myAnswer && !isReveal && (
            <div className="card center-text" style={{ padding: '1.5rem', background: 'var(--bg-soft)', marginTop: '1rem' }}>
              <CheckCircle2 size={28} style={{ color: 'var(--accent-light)' }} />
              <p style={{ marginTop: '0.5rem' }}>Answer locked in. Waiting for others...</p>
              <div className="text-info">You picked: <strong>{myAnswer}</strong></div>
            </div>
          )}

          {isReveal && (
            <div className={`card ${myCorrect ? 'live-result-correct' : 'live-result-wrong'}`} style={{ marginTop: '1rem', padding: '1.5rem', textAlign: 'center' }}>
              {myCorrect ? (
                <>
                  <CheckCircle2 size={32} style={{ color: 'var(--success)' }} />
                  <h3 style={{ marginTop: '0.5rem', color: 'var(--success)' }}>Correct!</h3>
                  {lastAnswered?.qIndex === session.current_question_index && lastAnswered?.points > 0 && (
                    <div style={{ marginTop: '0.25rem', fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent-light)' }}>
                      +{lastAnswered.points} pts
                    </div>
                  )}
                </>
              ) : (
                <>
                  <XCircle size={32} style={{ color: 'var(--error)' }} />
                  <h3 style={{ marginTop: '0.5rem', color: 'var(--error)' }}>{myAnswer ? 'Incorrect' : 'No answer'}</h3>
                  <div className="text-info" style={{ marginTop: '0.5rem' }}>
                    Correct: <strong>{reveal?.correct_answer}</strong>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Live leaderboard mini */}
      <div className="card">
        <h2><Trophy size={20} /> Top 3</h2>
        <ol className="leaderboard-list">
          {sortedPlayers.slice(0, 3).map((p, i) => {
            const isMe = p.id === playerId
            return (
              <li key={p.id} className={`leaderboard-row ${isMe ? 'me' : ''}`}>
                <div className="leaderboard-rank">
                  <span className="leaderboard-rank-num">{i + 1}</span>
                </div>
                <div className="leaderboard-name">
                  {p.player_name}
                  {isMe && <span className="leaderboard-me-tag">you</span>}
                </div>
                <div className="leaderboard-score">
                  <strong>{p.score}</strong>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
