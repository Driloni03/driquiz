import { useState } from 'react'
import {
  Upload, FileText, Sparkles, CheckCircle2, XCircle, RotateCcw, BookOpen,
  Loader2, Video as Youtube, Clock, Plus, X, Lightbulb, ArrowRight, ArrowLeft,
} from 'lucide-react'
import {
  uploadPdf, generateQuiz, fetchYoutubeTranscript, pasteYoutubeTranscript,
  extractConcepts,
} from '../api'
import ChatWidget from '../ChatWidget'

const QUESTION_TYPE_LABELS = {
  multiple_choice: 'Multiple Choice',
  true_false: 'True / False',
  short_answer: 'Short Answer',
}
const DIFFICULTY_LABELS = {
  easy: 'Easy', medium: 'Medium', hard: 'Hard', mixed: 'Mixed',
}

// A "source" is one piece of material the user added
// { id, kind: 'text'|'pdf'|'youtube', label, text, youtube_video_id? }

let sourceIdCounter = 0
const newSourceId = () => `src-${++sourceIdCounter}`

export default function CreateQuiz() {
  const [step, setStep] = useState('input') // 'input' | 'concepts' | 'settings'
  const [sources, setSources] = useState([])
  const [title, setTitle] = useState('')

  // Concept extraction
  const [concepts, setConcepts] = useState([])
  const [selectedConcepts, setSelectedConcepts] = useState(new Set())
  const [extractingConcepts, setExtractingConcepts] = useState(false)

  // Quiz settings
  const [numQuestions, setNumQuestions] = useState(5)
  const [difficulty, setDifficulty] = useState('mixed')
  const [questionTypes, setQuestionTypes] = useState(['multiple_choice'])

  // App state
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [error, setError] = useState('')

  // Combine all sources into one text payload
  const combinedText = sources.map(s => s.text).join('\n\n---\n\n')
  const totalChars = combinedText.length

  // Determine the source_type to send the backend (for chunking strategy)
  const aggregateSourceType = () => {
    if (sources.length === 0) return 'text'
    if (sources.length === 1) return sources[0].kind
    return 'multi'
  }

  // Get the youtube video id if there's exactly one YouTube source
  const aggregateYoutubeVideoId = () => {
    const ytSources = sources.filter(s => s.kind === 'youtube')
    return ytSources.length === 1 ? ytSources[0].youtube_video_id : null
  }

  const removeSource = (id) => {
    setSources(prev => prev.filter(s => s.id !== id))
  }

  const handleExtractConcepts = async () => {
    if (totalChars < 100) {
      setError('Add some material first (at least 100 characters).')
      return
    }
    setError('')
    setExtractingConcepts(true)
    setLoadingMsg('Analyzing your material...')
    try {
      const result = await extractConcepts(combinedText.slice(0, 50000))
      setConcepts(result)
      setSelectedConcepts(new Set(result.map((_, i) => i)))
      setStep('concepts')
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not extract concepts.')
    } finally {
      setExtractingConcepts(false)
      setLoadingMsg('')
    }
  }

  const toggleConcept = (idx) => {
    setSelectedConcepts(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const skipConcepts = () => {
    setConcepts([])
    setSelectedConcepts(new Set())
    setStep('settings')
  }

  const goToSettings = () => {
    if (concepts.length > 0 && selectedConcepts.size === 0) {
      setError('Pick at least one concept, or skip this step.')
      return
    }
    setError('')
    setStep('settings')
  }

  const handleGenerate = async () => {
    if (questionTypes.length === 0) {
      setError('Select at least one question type.')
      return
    }
    setError('')
    setLoading(true)
    setLoadingMsg('Generating quiz... (this may take 20-40 seconds)')

    const focusConcepts = concepts.length > 0
      ? Array.from(selectedConcepts).map(i => concepts[i].name)
      : null

    try {
      const data = await generateQuiz({
        text: combinedText,
        num_questions: numQuestions,
        difficulty,
        question_types: questionTypes,
        title: title || (sources[0]?.label || 'Untitled Quiz'),
        source_type: aggregateSourceType(),
        youtube_video_id: aggregateYoutubeVideoId(),
        focus_concepts: focusConcepts,
      })
      // Navigate to the public quiz page so they can take it (and share)
      window.location.href = `/q/${data.id}`
    } catch (err) {
      setError(err.response?.data?.detail || 'Error generating quiz.')
      setLoading(false)
      setLoadingMsg('')
    }
  }

  return (
    <>
      <div className="container">
        <div className="header">
          <h1>Create a quiz</h1>
          <p>Add one or more sources, then generate</p>
        </div>

        {error && <div className="alert alert-error">⚠️ {error}</div>}

        {/* STEP INDICATOR */}
        <div className="step-indicator">
          <div className={`step-dot ${step === 'input' ? 'active' : 'done'}`}>1</div>
          <div className="step-line" />
          <div className={`step-dot ${step === 'concepts' ? 'active' : (step === 'settings' ? 'done' : '')}`}>2</div>
          <div className="step-line" />
          <div className={`step-dot ${step === 'settings' ? 'active' : ''}`}>3</div>
        </div>

        {step === 'input' && (
          <InputStep
            sources={sources}
            setSources={setSources}
            removeSource={removeSource}
            title={title}
            setTitle={setTitle}
            totalChars={totalChars}
            handleExtractConcepts={handleExtractConcepts}
            extracting={extractingConcepts}
            setError={setError}
          />
        )}

        {step === 'concepts' && (
          <ConceptsStep
            concepts={concepts}
            selectedConcepts={selectedConcepts}
            toggleConcept={toggleConcept}
            goToSettings={goToSettings}
            back={() => setStep('input')}
            skipConcepts={skipConcepts}
          />
        )}

        {step === 'settings' && (
          <SettingsStep
            numQuestions={numQuestions}
            setNumQuestions={setNumQuestions}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            questionTypes={questionTypes}
            setQuestionTypes={setQuestionTypes}
            handleGenerate={handleGenerate}
            back={() => setStep(concepts.length > 0 ? 'concepts' : 'input')}
            loading={loading}
            loadingMsg={loadingMsg}
            sourceCount={sources.length}
            conceptCount={selectedConcepts.size}
          />
        )}
      </div>

      <ChatWidget studyMaterial={combinedText} />
    </>
  )
}

/* ============================================================
   STEP 1: INPUT (multi-source bag)
   ============================================================ */
function InputStep({ sources, setSources, removeSource, title, setTitle, totalChars, handleExtractConcepts, extracting, setError }) {
  const [adderOpen, setAdderOpen] = useState(sources.length === 0)
  const [adderType, setAdderType] = useState('text') // 'text' | 'pdf' | 'youtube'

  return (
    <>
      <div className="card">
        <h2><FileText size={20} /> Sources</h2>

        {sources.length > 0 && (
          <div className="sources-list">
            {sources.map((s) => (
              <div key={s.id} className="source-chip">
                <SourceIcon kind={s.kind} />
                <div className="source-chip-info">
                  <div className="source-chip-label">{s.label}</div>
                  <div className="source-chip-meta">{s.text.length.toLocaleString()} chars</div>
                </div>
                <button className="source-chip-remove" onClick={() => removeSource(s.id)} aria-label="Remove">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {!adderOpen ? (
          <button className="btn btn-secondary btn-block" onClick={() => setAdderOpen(true)}>
            <Plus size={16} /> Add another source
          </button>
        ) : (
          <SourceAdder
            adderType={adderType}
            setAdderType={setAdderType}
            onAdd={(src) => {
              setSources(prev => [...prev, src])
              setAdderOpen(false)
              setError('')
            }}
            onCancel={sources.length > 0 ? () => setAdderOpen(false) : null}
            setError={setError}
          />
        )}
      </div>

      {sources.length > 0 && (
        <div className="card">
          <h2><Sparkles size={20} /> Quiz title (optional)</h2>
          <input
            className="input"
            placeholder={sources[0]?.label || 'My Quiz'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="text-info">
            Combined: {totalChars.toLocaleString()} characters across {sources.length} source{sources.length === 1 ? '' : 's'}
          </div>
          <button
            className="btn btn-block"
            onClick={handleExtractConcepts}
            disabled={extracting || totalChars < 100}
            style={{ marginTop: '1rem' }}
          >
            {extracting
              ? <><Loader2 size={18} className="spinner" /> Analyzing material...</>
              : <>Continue <ArrowRight size={18} /></>}
          </button>
        </div>
      )}
    </>
  )
}

function SourceIcon({ kind }) {
  if (kind === 'youtube') return <Youtube size={16} />
  if (kind === 'pdf') return <FileText size={16} />
  return <Sparkles size={16} />
}

function SourceAdder({ adderType, setAdderType, onAdd, onCancel, setError }) {
  const [text, setText] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [youtubeMode, setYoutubeMode] = useState('paste') // 'auto' | 'paste'
  const [pastedTranscript, setPastedTranscript] = useState('')
  const [busy, setBusy] = useState(false)

  const submitText = () => {
    if (text.trim().length < 50) {
      setError('Text must be at least 50 characters.')
      return
    }
    onAdd({
      id: newSourceId(),
      kind: 'text',
      label: text.slice(0, 40).trim() + (text.length > 40 ? '...' : ''),
      text: text.trim(),
    })
    setText('')
  }

  const submitPdf = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setBusy(true)
    try {
      const data = await uploadPdf(file)
      onAdd({
        id: newSourceId(),
        kind: 'pdf',
        label: file.name.replace(/\.pdf$/i, ''),
        text: data.text,
      })
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not upload PDF.')
    } finally {
      setBusy(false)
    }
  }

  const submitYoutubeAuto = async () => {
    if (!youtubeUrl.trim()) {
      setError('Paste a YouTube URL.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const data = await fetchYoutubeTranscript(youtubeUrl.trim())
      onAdd({
        id: newSourceId(),
        kind: 'youtube',
        label: data.title,
        text: data.text,
        youtube_video_id: data.video_id,
      })
      setYoutubeUrl('')
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not fetch transcript.')
    } finally {
      setBusy(false)
    }
  }

  const submitYoutubePaste = async () => {
    if (!youtubeUrl.trim() || !pastedTranscript.trim() || pastedTranscript.length < 50) {
      setError('Need both a URL and a transcript (50+ chars).')
      return
    }
    setError('')
    setBusy(true)
    try {
      const data = await pasteYoutubeTranscript(youtubeUrl.trim(), pastedTranscript)
      onAdd({
        id: newSourceId(),
        kind: 'youtube',
        label: data.title,
        text: data.text,
        youtube_video_id: data.video_id,
      })
      setYoutubeUrl('')
      setPastedTranscript('')
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not process transcript.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adder-panel">
      <div className="tabs">
        <button className={`tab ${adderType === 'text' ? 'active' : ''}`} onClick={() => setAdderType('text')}>
          Text
        </button>
        <button className={`tab ${adderType === 'pdf' ? 'active' : ''}`} onClick={() => setAdderType('pdf')}>
          PDF
        </button>
        <button className={`tab ${adderType === 'youtube' ? 'active' : ''}`} onClick={() => setAdderType('youtube')}>
          <Youtube size={14} /> YouTube
        </button>
      </div>

      {adderType === 'text' && (
        <>
          <textarea
            className="textarea"
            placeholder="Paste your study material..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
          <div className="button-row" style={{ marginTop: '0.75rem' }}>
            <button className="btn" onClick={submitText} disabled={busy || !text.trim()}>
              <Plus size={16} /> Add Text
            </button>
            {onCancel && <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>}
          </div>
        </>
      )}

      {adderType === 'pdf' && (
        <>
          <label className="upload-zone">
            <input type="file" accept=".pdf" onChange={submitPdf} disabled={busy} />
            <Upload size={32} className="icon" />
            {busy
              ? <div><Loader2 size={16} className="spinner" /> Extracting...</div>
              : <>
                  <div><strong>Click to upload PDF</strong></div>
                  <div className="text-info">Maximum 10 MB</div>
                </>}
          </label>
          {onCancel && (
            <div className="button-row" style={{ marginTop: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            </div>
          )}
        </>
      )}

      {adderType === 'youtube' && (
        <>
          <div className="tabs" style={{ marginBottom: '0.75rem' }}>
            <button className={`tab ${youtubeMode === 'paste' ? 'active' : ''}`} onClick={() => setYoutubeMode('paste')}>
              Paste Transcript
            </button>
            <button className={`tab ${youtubeMode === 'auto' ? 'active' : ''}`} onClick={() => setYoutubeMode('auto')}>
              Auto Fetch
            </button>
          </div>

          <div className="field">
            <label className="label">YouTube URL</label>
            <input
              className="input"
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={(e) => setYoutubeUrl(e.target.value)}
              disabled={busy}
            />
          </div>

          {youtubeMode === 'auto' && (
            <>
              <button className="btn btn-block" onClick={submitYoutubeAuto} disabled={busy || !youtubeUrl.trim()}>
                {busy ? <><Loader2 size={16} className="spinner" /> Fetching...</> : <>Fetch Transcript</>}
              </button>
              <div className="text-info" style={{ marginTop: '0.5rem' }}>
                ⚠️ YouTube often blocks cloud servers. If fetch fails, use Paste mode.
              </div>
            </>
          )}

          {youtubeMode === 'paste' && (
            <>
              <div className="field" style={{ marginTop: '0.75rem' }}>
                <label className="label">Transcript</label>
                <textarea
                  className="textarea"
                  style={{ minHeight: '140px' }}
                  placeholder="Paste the transcript here..."
                  value={pastedTranscript}
                  onChange={(e) => setPastedTranscript(e.target.value)}
                  disabled={busy}
                />
              </div>
              <button className="btn btn-block" onClick={submitYoutubePaste} disabled={busy || !youtubeUrl.trim() || !pastedTranscript.trim()}>
                {busy ? <><Loader2 size={16} className="spinner" /> Processing...</> : <><Plus size={16} /> Add Video</>}
              </button>
              <details style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-dim)' }}>
                <summary style={{ cursor: 'pointer' }}>How to copy a YouTube transcript</summary>
                <ol style={{ marginLeft: '1.5rem', marginTop: '0.5rem', lineHeight: 1.7 }}>
                  <li>On YouTube, click <strong>...more</strong> → <strong>Show transcript</strong></li>
                  <li>Select all the transcript text and copy</li>
                  <li>Paste here. Timestamps (0:00, 1:23) are detected automatically.</li>
                </ol>
              </details>
            </>
          )}

          {onCancel && (
            <div className="button-row" style={{ marginTop: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ============================================================
   STEP 2: CONCEPTS
   ============================================================ */
function ConceptsStep({ concepts, selectedConcepts, toggleConcept, goToSettings, back, skipConcepts }) {
  const allSelected = concepts.length > 0 && selectedConcepts.size === concepts.length
  return (
    <>
      <div className="card">
        <h2><Lightbulb size={20} /> Main concepts found</h2>
        <p className="text-info" style={{ marginBottom: '1rem' }}>
          Pick which concepts you want the quiz to focus on. Selected: <strong>{selectedConcepts.size}</strong> / {concepts.length}
        </p>

        <div className="concepts-list">
          {concepts.map((c, idx) => {
            const checked = selectedConcepts.has(idx)
            return (
              <label key={idx} className={`concept-item ${checked ? 'checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleConcept(idx)}
                />
                <div className="concept-info">
                  <div className="concept-name">{c.name}</div>
                  <div className="concept-desc">{c.description}</div>
                </div>
              </label>
            )
          })}
        </div>

        <div className="button-row" style={{ marginTop: '1.25rem' }}>
          <button className="btn" onClick={goToSettings}>
            Continue <ArrowRight size={16} />
          </button>
          <button className="btn btn-secondary" onClick={back}>
            <ArrowLeft size={16} /> Back
          </button>
          <button className="btn btn-secondary" onClick={skipConcepts}>
            Skip (use all)
          </button>
        </div>
      </div>
    </>
  )
}

/* ============================================================
   STEP 3: SETTINGS
   ============================================================ */
function SettingsStep({
  numQuestions, setNumQuestions, difficulty, setDifficulty,
  questionTypes, setQuestionTypes, handleGenerate, back, loading, loadingMsg,
  sourceCount, conceptCount,
}) {
  const toggleType = (type) => {
    setQuestionTypes(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type])
  }

  return (
    <div className="card">
      <h2><Sparkles size={20} /> Quiz settings</h2>

      <div className="text-info" style={{ marginBottom: '1rem' }}>
        From {sourceCount} source{sourceCount === 1 ? '' : 's'}{conceptCount > 0 && `, focused on ${conceptCount} concept${conceptCount === 1 ? '' : 's'}`}
      </div>

      <div className="row">
        <div className="field">
          <label className="label">Questions: {numQuestions}</label>
          <input
            type="range" min="3" max="15"
            value={numQuestions}
            onChange={(e) => setNumQuestions(Number(e.target.value))}
            style={{ width: '100%' }}
          />
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

      <div className="button-row" style={{ marginTop: '1.5rem' }}>
        <button className="btn" onClick={handleGenerate} disabled={loading}>
          {loading
            ? <><Loader2 size={18} className="spinner" /> {loadingMsg}</>
            : <><Sparkles size={18} /> Generate Quiz</>}
        </button>
        <button className="btn btn-secondary" onClick={back} disabled={loading}>
          <ArrowLeft size={16} /> Back
        </button>
      </div>
    </div>
  )
}
