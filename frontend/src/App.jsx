import { useState } from 'react'
import { Upload, FileText, Sparkles, CheckCircle2, XCircle, RotateCcw, BookOpen, Loader2, Video as Youtube, Clock } from 'lucide-react'
import { uploadPdf, generateQuiz, submitQuiz, fetchYoutubeTranscript, formatTimestamp, youtubeLinkAt } from './api'
import ChatWidget from './ChatWidget'

const QUESTION_TYPE_LABELS = {
  multiple_choice: 'Multiple Choice',
  true_false: 'True / False',
  short_answer: 'Short Answer',
}

const DIFFICULTY_LABELS = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  mixed: 'Mixed',
}

export default function App() {
  const [view, setView] = useState('setup')
  const [inputMode, setInputMode] = useState('text') // 'text' | 'pdf' | 'youtube'
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [sourceType, setSourceType] = useState('text')  // tracked separately
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [youtubeVideoId, setYoutubeVideoId] = useState(null)
  const [numQuestions, setNumQuestions] = useState(5)
  const [difficulty, setDifficulty] = useState('mixed')
  const [questionTypes, setQuestionTypes] = useState(['multiple_choice'])
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [error, setError] = useState('')
  const [quiz, setQuiz] = useState(null)
  const [answers, setAnswers] = useState({})
  const [results, setResults] = useState(null)

  const handlePdfUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setLoading(true)
    setLoadingMsg('Extracting text from PDF...')
    try {
      const data = await uploadPdf(file)
      setText(data.text)
      setSourceType('pdf')
      setYoutubeVideoId(null)
      if (!title) setTitle(file.name.replace(/\.pdf$/i, ''))
    } catch (err) {
      setError(err.response?.data?.detail || 'Error uploading PDF.')
    } finally {
      setLoading(false)
      setLoadingMsg('')
    }
  }

  const handleYoutubeFetch = async () => {
    if (!youtubeUrl.trim()) {
      setError('Paste a YouTube URL first.')
      return
    }
    setError('')
    setLoading(true)
    setLoadingMsg('Fetching transcript...')
    try {
      const data = await fetchYoutubeTranscript(youtubeUrl.trim())
      setText(data.text)
      setSourceType('youtube')
      setYoutubeVideoId(data.video_id)
      if (!title) setTitle(data.title)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not fetch transcript.')
    } finally {
      setLoading(false)
      setLoadingMsg('')
    }
  }

  const switchInputMode = (mode) => {
    setInputMode(mode)
    setError('')
    // Reset content when switching modes
    setText('')
    setYoutubeVideoId(null)
    setYoutubeUrl('')
    setSourceType(mode === 'youtube' ? 'youtube' : 'text')
  }

  const toggleType = (type) => {
    setQuestionTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    )
  }

  const handleGenerate = async () => {
    setError('')
    if (!text.trim() || text.length < 100) {
      setError('Material must be at least 100 characters.')
      return
    }
    if (questionTypes.length === 0) {
      setError('Select at least one question type.')
      return
    }
    setLoading(true)
    setLoadingMsg('Generating quiz... (this may take 20-40 seconds)')
    try {
      const data = await generateQuiz({
        text,
        num_questions: numQuestions,
        difficulty,
        question_types: questionTypes,
        title: title || 'Untitled Quiz',
        source_type: sourceType,
        youtube_video_id: youtubeVideoId,
      })
      setQuiz(data)
      setAnswers({})
      setView('quiz')
      window.scrollTo(0, 0)
    } catch (err) {
      setError(err.response?.data?.detail || 'Error generating quiz.')
    } finally {
      setLoading(false)
      setLoadingMsg('')
    }
  }

  const handleAnswer = (qid, value) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }))
  }

  const handleSubmit = async () => {
    if (Object.keys(answers).length < quiz.questions.length) {
      if (!confirm("You haven't answered all questions. Submit anyway?")) return
    }
    setLoading(true)
    setLoadingMsg('Scoring...')
    try {
      const payload = quiz.questions.map((q) => ({
        question_id: q.id,
        user_answer: answers[q.id] || '',
      }))
      const data = await submitQuiz(quiz.id, payload)
      setResults(data)
      setView('results')
      window.scrollTo(0, 0)
    } catch (err) {
      setError(err.response?.data?.detail || 'Error submitting quiz.')
    } finally {
      setLoading(false)
      setLoadingMsg('')
    }
  }

  const reset = () => {
    setView('setup')
    setQuiz(null)
    setAnswers({})
    setResults(null)
    setError('')
  }

  const retake = () => {
    setAnswers({})
    setResults(null)
    setView('quiz')
    window.scrollTo(0, 0)
  }

  return (
    <>
      <div className="container">
        <div className="header">
          <h1>📚 AI Quiz Generator</h1>
          <p>Create quizzes from text, PDFs, or YouTube lectures</p>
        </div>

        {error && <div className="alert alert-error">⚠️ {error}</div>}

        {view === 'setup' && (
          <SetupView
            inputMode={inputMode}
            switchInputMode={switchInputMode}
            text={text}
            setText={setText}
            title={title}
            setTitle={setTitle}
            youtubeUrl={youtubeUrl}
            setYoutubeUrl={setYoutubeUrl}
            youtubeVideoId={youtubeVideoId}
            handleYoutubeFetch={handleYoutubeFetch}
            numQuestions={numQuestions}
            setNumQuestions={setNumQuestions}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            questionTypes={questionTypes}
            toggleType={toggleType}
            handlePdfUpload={handlePdfUpload}
            handleGenerate={handleGenerate}
            loading={loading}
            loadingMsg={loadingMsg}
          />
        )}

        {view === 'quiz' && quiz && (
          <QuizView
            quiz={quiz}
            answers={answers}
            handleAnswer={handleAnswer}
            handleSubmit={handleSubmit}
            loading={loading}
            loadingMsg={loadingMsg}
            reset={reset}
          />
        )}

        {view === 'results' && results && quiz && (
          <ResultsView
            results={results}
            quiz={quiz}
            retake={retake}
            reset={reset}
          />
        )}
      </div>

      <ChatWidget studyMaterial={text} />
    </>
  )
}

function SetupView(props) {
  const {
    inputMode, switchInputMode, text, setText, title, setTitle,
    youtubeUrl, setYoutubeUrl, youtubeVideoId, handleYoutubeFetch,
    numQuestions, setNumQuestions, difficulty, setDifficulty,
    questionTypes, toggleType, handlePdfUpload, handleGenerate,
    loading, loadingMsg
  } = props

  return (
    <>
      <div className="card">
        <h2><FileText size={20} /> Study Material</h2>
        <div className="tabs">
          <button className={`tab ${inputMode === 'text' ? 'active' : ''}`} onClick={() => switchInputMode('text')}>Paste Text</button>
          <button className={`tab ${inputMode === 'pdf' ? 'active' : ''}`} onClick={() => switchInputMode('pdf')}>Upload PDF</button>
          <button className={`tab ${inputMode === 'youtube' ? 'active' : ''}`} onClick={() => switchInputMode('youtube')}>
            <Youtube size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            YouTube
          </button>
        </div>

        {inputMode === 'pdf' && (
          <label className="upload-zone">
            <input type="file" accept=".pdf" onChange={handlePdfUpload} disabled={loading} />
            <Upload size={32} className="icon" />
            <div><strong>Click to upload PDF</strong></div>
            <div className="text-info">Maximum 10 MB</div>
          </label>
        )}

        {inputMode === 'text' && (
          <textarea
            className="textarea"
            placeholder="Paste your study material here (lecture notes, textbook chapters, articles...)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
          />
        )}

        {inputMode === 'youtube' && (
          <>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                className="input"
                placeholder="Paste a YouTube URL (e.g. https://www.youtube.com/watch?v=...)"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                disabled={loading}
              />
              <button className="btn" onClick={handleYoutubeFetch} disabled={loading || !youtubeUrl.trim()}>
                {loading ? <Loader2 size={16} className="spinner" /> : 'Fetch'}
              </button>
            </div>
            <div className="text-info" style={{ marginTop: '0.5rem' }}>
              Works with most public YouTube videos that have captions/subtitles.
            </div>
            {youtubeVideoId && (
              <div className="text-info" style={{ marginTop: '0.5rem', color: '#6ee7b7' }}>
                ✓ Transcript loaded from video <code>{youtubeVideoId}</code>
              </div>
            )}
          </>
        )}

        {text && inputMode !== 'youtube' && (
          <div className="text-info">✓ {text.length.toLocaleString()} characters loaded</div>
        )}
      </div>

      <div className="card">
        <h2><Sparkles size={20} /> Quiz Settings</h2>
        <div className="field">
          <label className="label">Quiz title</label>
          <input className="input" placeholder="e.g. Algebra Basics - Chapter 3" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="row">
          <div className="field">
            <label className="label">Number of questions: {numQuestions}</label>
            <input type="range" min="3" max="15" value={numQuestions} onChange={(e) => setNumQuestions(Number(e.target.value))} style={{ width: '100%' }} />
          </div>
          <div className="field">
            <label className="label">Difficulty</label>
            <select className="select" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              {Object.entries(DIFFICULTY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label">Question types</label>
          <div className="checkbox-group">
            {Object.entries(QUESTION_TYPE_LABELS).map(([type, label]) => {
              const checked = questionTypes.includes(type)
              return (
                <label key={type} className={`checkbox-item ${checked ? 'checked' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleType(type)} />
                  {label}
                </label>
              )
            })}
          </div>
        </div>
        <button className="btn btn-block" onClick={handleGenerate} disabled={loading || !text.trim()}>
          {loading ? <><Loader2 size={18} className="spinner" /> {loadingMsg || 'Working...'}</> : <><Sparkles size={18} /> Generate Quiz</>}
        </button>
      </div>
    </>
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

function QuizView({ quiz, answers, handleAnswer, handleSubmit, loading, loadingMsg, reset }) {
  const answeredCount = Object.values(answers).filter((a) => a && a.trim()).length
  const videoId = quiz.youtube_video_id

  return (
    <>
      <div className="card">
        <h2>
          <BookOpen size={20} /> {quiz.title}
          {quiz.source_type === 'youtube' && (
            <span className="badge badge-medium" style={{ marginLeft: '0.5rem' }}>
              <Youtube size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} /> YouTube
            </span>
          )}
        </h2>
        <div className="text-info">{answeredCount} / {quiz.questions.length} questions answered</div>
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
        <button className="btn" onClick={handleSubmit} disabled={loading}>
          {loading ? <><Loader2 size={18} className="spinner" /> {loadingMsg}</> : <><CheckCircle2 size={18} /> Submit Quiz</>}
        </button>
        <button className="btn btn-secondary" onClick={reset}>Cancel</button>
      </div>
    </>
  )
}

function ResultsView({ results, quiz, retake, reset }) {
  const { score, total, percentage } = results
  const videoId = results.youtube_video_id || quiz.youtube_video_id
  const message =
    percentage >= 80 ? '🎉 Excellent!' :
    percentage >= 60 ? '👍 Good job!' :
    percentage >= 40 ? '📖 You can do better' :
    '💪 Keep studying!'
  return (
    <>
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
        <button className="btn btn-secondary" onClick={reset}>Create New Quiz</button>
      </div>
    </>
  )
}
