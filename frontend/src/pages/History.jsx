import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader2, Sparkles, FileText, Video, Clock, Share2, Play, Layers, ScrollText,
} from 'lucide-react'
import { listQuizzes, listFlashcardSets, listNotes, getAuthUser } from '../api'

export default function History() {
  const [tab, setTab] = useState('quizzes') // 'quizzes' | 'flashcards' | 'notes'
  const [quizzes, setQuizzes] = useState([])
  const [flashcards, setFlashcards] = useState([])
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState(null)

  useEffect(() => { loadAll() }, [])

  const loadAll = async () => {
    setLoading(true)
    setError('')
    try {
      const [q, f, n] = await Promise.all([
        listQuizzes().catch(() => []),
        listFlashcardSets().catch(() => []),
        listNotes().catch(() => []),
      ])
      setQuizzes(q)
      setFlashcards(f)
      setNotes(n)
    } catch (err) {
      setError('Could not load history.')
    } finally {
      setLoading(false)
    }
  }

  const copyShareLink = async (path, id) => {
    const url = `${window.location.origin}${path}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (_) { prompt('Copy:', url) }
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

  const total = quizzes.length + flashcards.length + notes.length
  const user = getAuthUser()

  return (
    <div className="container">
      <div className="header">
        <h1>Your study materials</h1>
        <p>
          {total} item{total === 1 ? '' : 's'} {user ? 'saved to your account' : 'created in this browser'}
        </p>
      </div>

      {!user && (
        <div className="alert alert-info" style={{ marginBottom: '1.25rem' }}>
          You are studying as a guest, so this list only lives in this browser.{' '}
          <Link to="/signin?mode=signup&role=student">Create a free account</Link> to keep your materials,
          flashcard progress and results on every device. Anything you made here moves into your account.
        </div>
      )}

      <div className="tabs" style={{ marginBottom: '1.25rem' }}>
        <button className={`tab ${tab === 'quizzes' ? 'active' : ''}`} onClick={() => setTab('quizzes')}>
          <Sparkles size={14} /> Quizzes ({quizzes.length})
        </button>
        <button className={`tab ${tab === 'flashcards' ? 'active' : ''}`} onClick={() => setTab('flashcards')}>
          <Layers size={14} /> Flashcards ({flashcards.length})
        </button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          <ScrollText size={14} /> Notes ({notes.length})
        </button>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {loading && (
        <div className="card center-text">
          <Loader2 size={24} className="spinner" /><p>Loading...</p>
        </div>
      )}

      {!loading && tab === 'quizzes' && (
        <ItemList
          items={quizzes}
          emptyText="No quizzes yet."
          renderRow={(q) => (
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
                <button className="btn btn-secondary btn-small" onClick={() => copyShareLink(`/q/${q.id}`, q.id)}>
                  <Share2 size={14} /> {copiedId === q.id ? 'Copied!' : 'Share'}
                </button>
                <Link to={`/q/${q.id}`} className="btn btn-small"><Play size={14} /> Take</Link>
              </div>
            </div>
          )}
        />
      )}

      {!loading && tab === 'flashcards' && (
        <ItemList
          items={flashcards}
          emptyText="No flashcard sets yet."
          renderRow={(f) => (
            <div key={f.id} className="quiz-row">
              <div className="quiz-row-main">
                <div className="quiz-row-icon"><Layers size={14} /></div>
                <div className="quiz-row-info">
                  <div className="quiz-row-title">{f.title}</div>
                  <div className="quiz-row-meta">
                    <Clock size={11} /> {formatDate(f.created_at)} · {f.num_cards} cards
                  </div>
                </div>
              </div>
              <div className="quiz-row-actions">
                <Link to={`/flashcards/${f.id}`} className="btn btn-small"><Play size={14} /> Study</Link>
              </div>
            </div>
          )}
        />
      )}

      {!loading && tab === 'notes' && (
        <ItemList
          items={notes}
          emptyText="No notes yet."
          renderRow={(n) => (
            <div key={n.id} className="quiz-row">
              <div className="quiz-row-main">
                <div className="quiz-row-icon"><ScrollText size={14} /></div>
                <div className="quiz-row-info">
                  <div className="quiz-row-title">{n.title}</div>
                  <div className="quiz-row-meta">
                    <Clock size={11} /> {formatDate(n.created_at)} · {n.format === 'guide' ? 'study guide' : 'quick summary'}
                  </div>
                </div>
              </div>
              <div className="quiz-row-actions">
                <Link to={`/notes/${n.id}`} className="btn btn-small">Open</Link>
              </div>
            </div>
          )}
        />
      )}
    </div>
  )
}

function ItemList({ items, emptyText, renderRow }) {
  if (items.length === 0) {
    return (
      <div className="card center-text">
        <p style={{ marginBottom: '1rem' }}>{emptyText}</p>
        <Link to="/app" className="btn"><Sparkles size={16} /> Create something</Link>
      </div>
    )
  }
  return <div className="quiz-list">{items.map(renderRow)}</div>
}
