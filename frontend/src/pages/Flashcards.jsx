import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Loader2, ArrowLeft, ArrowRight, RotateCcw, Check, X, Brain,
  Trophy, Layers, BookOpen,
} from 'lucide-react'
import { getFlashcardSet } from '../api'

/* SM-2 spaced repetition algorithm
   quality: 0 (forgot), 3 (hard), 4 (good), 5 (easy)
*/
function applySM2(card, quality) {
  let { ease = 2.5, interval = 0, reps = 0 } = card
  if (quality < 3) {
    reps = 0
    interval = 1
  } else {
    if (reps === 0) interval = 1
    else if (reps === 1) interval = 6
    else interval = Math.round(interval * ease)
    reps += 1
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)))
  return { ...card, ease, interval, reps, last_quality: quality }
}

const STORAGE_KEY = (id) => `driquiz_flashcard_progress_${id}`

export default function Flashcards() {
  const { setId } = useParams()
  const [set, setSet] = useState(null)
  const [cards, setCards] = useState([])
  const [queue, setQueue] = useState([])  // indices of cards still to study this session
  const [reviewedCount, setReviewedCount] = useState(0)
  const [stats, setStats] = useState({ easy: 0, good: 0, hard: 0, again: 0 })
  const [flipped, setFlipped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => { load() }, [setId])

  const load = async () => {
    setLoading(true)
    try {
      const data = await getFlashcardSet(setId)
      setSet(data)
      // Load saved progress for SM-2 ease/interval if exists
      let savedCards = data.cards
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY(setId)) || 'null')
        if (saved && Array.isArray(saved.cards) && saved.cards.length === data.cards.length) {
          savedCards = data.cards.map((c, i) => ({ ...c, ...saved.cards[i] }))
        }
      } catch (_) {}
      setCards(savedCards)
      // Initial queue: cards in order, with reps=0 cards prioritized first (new cards first)
      const indices = savedCards.map((_, i) => i)
      indices.sort((a, b) => (savedCards[a].reps || 0) - (savedCards[b].reps || 0))
      setQueue(indices)
      setReviewedCount(0)
      setStats({ easy: 0, good: 0, hard: 0, again: 0 })
      setFlipped(false)
      setDone(false)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load flashcards.')
    } finally {
      setLoading(false)
    }
  }

  const persist = (newCards) => {
    try {
      localStorage.setItem(STORAGE_KEY(setId), JSON.stringify({
        cards: newCards.map(c => ({ ease: c.ease, interval: c.interval, reps: c.reps })),
      }))
    } catch (_) {}
  }

  const grade = useCallback((quality) => {
    if (queue.length === 0) return
    const idx = queue[0]
    const updatedCard = applySM2(cards[idx], quality)
    const newCards = [...cards]
    newCards[idx] = updatedCard
    setCards(newCards)
    persist(newCards)

    // Stats
    setStats(prev => {
      const next = { ...prev }
      if (quality === 0) next.again += 1
      else if (quality === 3) next.hard += 1
      else if (quality === 4) next.good += 1
      else if (quality === 5) next.easy += 1
      return next
    })

    // Re-queue: if forgot, push back to be seen again this session
    let newQueue = queue.slice(1)
    if (quality === 0) newQueue.push(idx)  // back of queue, will be reviewed again
    if (quality === 3 && Math.random() < 0.5) newQueue.push(idx)  // 50% chance to review hard ones again

    setQueue(newQueue)
    setReviewedCount(prev => prev + 1)
    setFlipped(false)

    if (newQueue.length === 0) {
      setDone(true)
    }
  }, [queue, cards, setId])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (loading || done || !cards.length) return
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        setFlipped(f => !f)
      } else if (flipped) {
        if (e.key === '1') grade(0)
        else if (e.key === '2') grade(3)
        else if (e.key === '3') grade(4)
        else if (e.key === '4') grade(5)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [flipped, loading, done, cards, grade])

  if (loading) {
    return (
      <div className="container">
        <div className="card center-text">
          <Loader2 size={24} className="spinner" />
          <p>Loading flashcards...</p>
        </div>
      </div>
    )
  }

  if (error || !set) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error || 'Set not found'}</div>
        <Link to="/" className="btn btn-secondary"><ArrowLeft size={16} /> Back</Link>
      </div>
    )
  }

  if (done) {
    return (
      <div className="container">
        <div className="score-banner">
          <Trophy size={48} style={{ color: 'var(--accent-light)', marginBottom: '0.5rem' }} />
          <div className="score-number" style={{ fontSize: '3rem' }}>Done!</div>
          <div className="score-label">Reviewed {reviewedCount} cards</div>
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.9rem' }}>
            <div><strong style={{ color: '#4ade80' }}>{stats.easy}</strong> easy</div>
            <div><strong style={{ color: 'var(--accent-light)' }}>{stats.good}</strong> good</div>
            <div><strong style={{ color: '#fbbf24' }}>{stats.hard}</strong> hard</div>
            <div><strong style={{ color: '#f87171' }}>{stats.again}</strong> forgot</div>
          </div>
        </div>
        <div className="button-row">
          <button className="btn" onClick={load}><RotateCcw size={18} /> Study Again</button>
          <Link to="/app" className="btn btn-secondary">Create New</Link>
          <Link to="/history" className="btn btn-secondary">History</Link>
        </div>
      </div>
    )
  }

  const current = cards[queue[0]]
  const totalCards = cards.length
  const progress = Math.round((reviewedCount / totalCards) * 100)

  return (
    <div className="container">
      <div className="card">
        <h2><Layers size={20} /> {set.title}</h2>
        <div className="text-info">
          Card {Math.min(reviewedCount + 1, totalCards)} of {totalCards} · {queue.length} remaining
        </div>
        <div className="progress-bar" style={{ marginTop: '0.75rem' }}>
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className={`flashcard ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped(f => !f)}>
        <div className="flashcard-inner">
          <div className="flashcard-face flashcard-front">
            <div className="flashcard-label">Question</div>
            <div className="flashcard-text">{current.front}</div>
            <div className="flashcard-hint">Click or press Space to flip</div>
          </div>
          <div className="flashcard-face flashcard-back">
            <div className="flashcard-label">Answer</div>
            <div className="flashcard-text">{current.back}</div>
            <div className="flashcard-hint">How well did you know this?</div>
          </div>
        </div>
      </div>

      {flipped ? (
        <div className="grade-row">
          <button className="grade-btn grade-again" onClick={(e) => { e.stopPropagation(); grade(0) }}>
            <X size={18} />
            <div>
              <div className="grade-label">Again</div>
              <div className="grade-key">1</div>
            </div>
          </button>
          <button className="grade-btn grade-hard" onClick={(e) => { e.stopPropagation(); grade(3) }}>
            <div>
              <div className="grade-label">Hard</div>
              <div className="grade-key">2</div>
            </div>
          </button>
          <button className="grade-btn grade-good" onClick={(e) => { e.stopPropagation(); grade(4) }}>
            <div>
              <div className="grade-label">Good</div>
              <div className="grade-key">3</div>
            </div>
          </button>
          <button className="grade-btn grade-easy" onClick={(e) => { e.stopPropagation(); grade(5) }}>
            <Check size={18} />
            <div>
              <div className="grade-label">Easy</div>
              <div className="grade-key">4</div>
            </div>
          </button>
        </div>
      ) : (
        <div className="button-row">
          <button className="btn btn-block" onClick={() => setFlipped(true)}>
            Show Answer (Space)
          </button>
        </div>
      )}

      <div className="button-row" style={{ justifyContent: 'center', marginTop: '0.5rem' }}>
        <Link to="/history" className="btn btn-secondary btn-small">
          <ArrowLeft size={14} /> Exit
        </Link>
      </div>
    </div>
  )
}
