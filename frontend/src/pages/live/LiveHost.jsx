import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Loader2, Users, Play, ArrowRight, CheckCircle2, XCircle, Trophy,
  Copy, Check, Zap, Eye, Award, Medal,
} from 'lucide-react'
import {
  getLiveState, startLiveSession, revealLiveQuestion, nextLiveQuestion,
} from '../../api'

const POLL_MS = 1500

export default function LiveHost() {
  const { sessionId } = useParams()
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const pollingRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const data = await getLiveState(sessionId)
        if (!cancelled) {
          setState(data)
          setError('')
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.detail || 'Could not load session.')
        }
      }
    }
    poll()
    pollingRef.current = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [sessionId])

  const start = async () => {
    setBusy(true)
    try {
      await startLiveSession(sessionId)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not start.')
    } finally {
      setBusy(false)
    }
  }

  const reveal = async () => {
    setBusy(true)
    try {
      await revealLiveQuestion(sessionId)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not reveal.')
    } finally {
      setBusy(false)
    }
  }

  const next = async () => {
    setBusy(true)
    try {
      await nextLiveQuestion(sessionId)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not advance.')
    } finally {
      setBusy(false)
    }
  }

  const copyCode = async () => {
    if (!state) return
    try {
      await navigator.clipboard.writeText(state.session.code)
      setCopiedCode(true)
      setTimeout(() => setCopiedCode(false), 1500)
    } catch (_) {}
  }

  if (!state && !error) {
    return (
      <div className="container">
        <div className="card center-text">
          <Loader2 size={20} className="spinner" />
        </div>
      </div>
    )
  }

  if (error && !state) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error}</div>
        <Link to="/teacher" className="btn btn-secondary">Back to dashboard</Link>
      </div>
    )
  }

  const { session, quiz_title, total_questions, current_question, reveal: revealData, players } = state
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score)

  // ============ LOBBY ============
  if (session.state === 'lobby') {
    return (
      <div className="container">
        <div className="header">
          <h1><Zap size={28} style={{ verticalAlign: 'middle', marginRight: 8, color: 'var(--accent-light)' }} /> {quiz_title}</h1>
          <p>{total_questions} questions · Live mode</p>
        </div>

        <div className="card">
          <div className="text-info" style={{ marginBottom: '0.75rem' }}>Tell students to go to <code>/live</code> and enter this code:</div>
          <div className="live-code-box">
            <span className="live-code-text">{session.code}</span>
            <button className="btn btn-secondary btn-small" onClick={copyCode}>
              {copiedCode ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
            </button>
          </div>
        </div>

        <div className="card">
          <h2><Users size={20} /> Players ({players.length})</h2>
          {players.length === 0 ? (
            <p className="text-info center-text" style={{ padding: '1.5rem' }}>
              Waiting for players to join...
            </p>
          ) : (
            <div className="live-players-grid">
              {players.map(p => (
                <div key={p.id} className="live-player-chip">
                  <div className="live-player-avatar">{p.player_name.charAt(0).toUpperCase()}</div>
                  <span>{p.player_name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="button-row">
          <button className="btn btn-large" onClick={start} disabled={busy || players.length === 0}>
            {busy ? <><Loader2 size={18} className="spinner" /> Starting...</> : <><Play size={18} /> Start quiz ({players.length} player{players.length === 1 ? '' : 's'})</>}
          </button>
        </div>
      </div>
    )
  }

  // ============ FINISHED ============
  if (session.state === 'finished') {
    const top3 = sortedPlayers.slice(0, 3)
    return (
      <div className="container">
        <div className="score-banner">
          <Trophy size={48} style={{ color: 'var(--accent-light)', marginBottom: '0.5rem' }} />
          <div className="score-number" style={{ fontSize: '2.5rem' }}>Game Over</div>
          <div className="score-label">{quiz_title} · {players.length} players</div>
        </div>

        {top3.length > 0 && (
          <div className="card">
            <h2><Award size={20} /> Final podium</h2>
            <div className="live-podium">
              {top3.map((p, i) => (
                <div key={p.id} className={`podium-spot podium-${i + 1}`}>
                  <div className="podium-medal">
                    {i === 0 && '🥇'}
                    {i === 1 && '🥈'}
                    {i === 2 && '🥉'}
                  </div>
                  <div className="podium-name">{p.player_name}</div>
                  <div className="podium-score">{p.score} pts</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <h2><Trophy size={20} /> All players</h2>
          <ol className="leaderboard-list">
            {sortedPlayers.map((p, i) => (
              <li key={p.id} className={`leaderboard-row ${i < 3 ? 'me' : ''}`}>
                <div className="leaderboard-rank">
                  {i === 0 && <Medal size={16} style={{ color: '#fbbf24' }} />}
                  {i === 1 && <Medal size={16} style={{ color: '#d4d0e0' }} />}
                  {i === 2 && <Medal size={16} style={{ color: '#cd7f32' }} />}
                  {i > 2 && <span className="leaderboard-rank-num">{i + 1}</span>}
                </div>
                <div className="leaderboard-name">{p.player_name}</div>
                <div className="leaderboard-score">
                  <strong>{p.score}</strong> <span className="text-info">pts</span>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="button-row">
          <Link to="/teacher" className="btn">Back to Dashboard</Link>
        </div>
      </div>
    )
  }

  // ============ QUESTION (active) or REVEAL ============
  const isReveal = session.state === 'reveal'
  const totalAnswered = revealData?.answer_distribution?.reduce((s, d) => s + d.count, 0) || 0

  return (
    <div className="container">
      <div className="live-host-header">
        <div className="live-host-meta">
          Question {(session.current_question_index + 1)} of {total_questions} · {quiz_title}
        </div>
        <div className="live-host-progress">
          <div className="live-host-progress-fill" style={{ width: `${((session.current_question_index + 1) / total_questions) * 100}%` }} />
        </div>
      </div>

      {current_question && (
        <div className="card live-question-card">
          <div className="live-question-text">{current_question.question}</div>

          {current_question.type === 'multiple_choice' && current_question.options && (
            <div className="live-options-grid">
              {current_question.options.map((opt, i) => {
                const isCorrect = isReveal && opt === revealData.correct_answer
                const dist = revealData?.answer_distribution?.find(d => d.answer === opt)
                const count = dist ? dist.count : 0
                return (
                  <div key={i} className={`live-option ${isReveal ? (isCorrect ? 'correct' : 'wrong') : ''}`}>
                    <div className="live-option-text">{opt}</div>
                    {isReveal && (
                      <div className="live-option-stat">
                        {isCorrect && <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />}
                        <span>{count} {count === 1 ? 'answer' : 'answers'}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {current_question.type === 'true_false' && (
            <div className="live-options-grid">
              {['True', 'False'].map(opt => {
                const isCorrect = isReveal && opt === revealData.correct_answer
                const dist = revealData?.answer_distribution?.find(d => d.answer === opt)
                const count = dist ? dist.count : 0
                return (
                  <div key={opt} className={`live-option ${isReveal ? (isCorrect ? 'correct' : 'wrong') : ''}`}>
                    <div className="live-option-text">{opt}</div>
                    {isReveal && (
                      <div className="live-option-stat">
                        {isCorrect && <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />}
                        <span>{count} {count === 1 ? 'answer' : 'answers'}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {!isReveal && (
            <div className="live-answer-stats">
              <Users size={14} /> {totalAnswered}/{players.length} answered
            </div>
          )}

          {isReveal && revealData?.explanation && (
            <div className="explanation" style={{ marginTop: '1rem' }}>
              <strong>Explanation:</strong> {revealData.explanation}
            </div>
          )}
        </div>
      )}

      {/* Mini leaderboard during play */}
      <div className="card">
        <h2><Trophy size={20} /> Top players</h2>
        <ol className="leaderboard-list">
          {sortedPlayers.slice(0, 5).map((p, i) => (
            <li key={p.id} className="leaderboard-row">
              <div className="leaderboard-rank">
                <span className="leaderboard-rank-num">{i + 1}</span>
              </div>
              <div className="leaderboard-name">{p.player_name}</div>
              <div className="leaderboard-score">
                <strong>{p.score}</strong> <span className="text-info">pts</span>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="button-row">
        {!isReveal ? (
          <button className="btn btn-large" onClick={reveal} disabled={busy}>
            {busy ? <><Loader2 size={18} className="spinner" /> ...</> : <><Eye size={18} /> Reveal answer</>}
          </button>
        ) : (
          <button className="btn btn-large" onClick={next} disabled={busy}>
            {busy ? <><Loader2 size={18} className="spinner" /> ...</> : (
              session.current_question_index + 1 >= total_questions
                ? <>End game <Trophy size={18} /></>
                : <>Next question <ArrowRight size={18} /></>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
