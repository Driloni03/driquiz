import { useState } from 'react'
import {
  Plus, Trash2, GripVertical, Sparkles, Loader2, Check, ChevronUp, ChevronDown,
  Edit3, X,
} from 'lucide-react'
import { createManualQuiz, suggestQuestion } from '../api'

const QUESTION_TYPE_LABELS = {
  multiple_choice: 'Multiple Choice',
  true_false: 'True / False',
  short_answer: 'Short Answer',
}

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }

const blankQuestion = (type = 'multiple_choice') => ({
  localId: Math.random().toString(36).slice(2),
  type,
  question: '',
  options: type === 'multiple_choice' ? ['', '', '', ''] : null,
  correct_answer: '',
  explanation: '',
  difficulty: 'medium',
  expanded: true,
})

export default function ManualQuizBuilder({ onCancel }) {
  const [title, setTitle] = useState('')
  const [questions, setQuestions] = useState([blankQuestion()])
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // AI suggest state
  const [showSuggest, setShowSuggest] = useState(false)
  const [suggestTopic, setSuggestTopic] = useState('')
  const [suggestType, setSuggestType] = useState('multiple_choice')
  const [suggestDifficulty, setSuggestDifficulty] = useState('medium')
  const [suggesting, setSuggesting] = useState(false)

  const addQuestion = (type = 'multiple_choice') => {
    setQuestions(prev => [...prev, blankQuestion(type)])
  }

  const removeQuestion = (idx) => {
    if (questions.length === 1) {
      // Don't let them remove the last one
      return
    }
    setQuestions(prev => prev.filter((_, i) => i !== idx))
  }

  const moveQuestion = (idx, direction) => {
    const newIdx = idx + direction
    if (newIdx < 0 || newIdx >= questions.length) return
    setQuestions(prev => {
      const next = [...prev]
      const [item] = next.splice(idx, 1)
      next.splice(newIdx, 0, item)
      return next
    })
  }

  const updateQuestion = (idx, fields) => {
    setQuestions(prev => prev.map((q, i) => i === idx ? { ...q, ...fields } : q))
  }

  const updateOption = (qIdx, optIdx, value) => {
    setQuestions(prev => prev.map((q, i) => {
      if (i !== qIdx) return q
      const newOptions = [...(q.options || [])]
      newOptions[optIdx] = value
      // If they're editing the option that's the correct answer, keep them in sync
      const newCorrect = (q.correct_answer === q.options[optIdx]) ? value : q.correct_answer
      return { ...q, options: newOptions, correct_answer: newCorrect }
    }))
  }

  const addOption = (qIdx) => {
    setQuestions(prev => prev.map((q, i) => {
      if (i !== qIdx) return q
      if ((q.options?.length || 0) >= 6) return q
      return { ...q, options: [...(q.options || []), ''] }
    }))
  }

  const removeOption = (qIdx, optIdx) => {
    setQuestions(prev => prev.map((q, i) => {
      if (i !== qIdx) return q
      if ((q.options?.length || 0) <= 2) return q
      const removed = q.options[optIdx]
      const newOptions = q.options.filter((_, oi) => oi !== optIdx)
      const newCorrect = q.correct_answer === removed ? '' : q.correct_answer
      return { ...q, options: newOptions, correct_answer: newCorrect }
    }))
  }

  const changeQuestionType = (idx, newType) => {
    setQuestions(prev => prev.map((q, i) => {
      if (i !== idx) return q
      const next = { ...q, type: newType, correct_answer: '' }
      if (newType === 'multiple_choice') {
        next.options = q.options && q.options.length >= 2 ? q.options : ['', '', '', '']
      } else {
        next.options = null
      }
      return next
    }))
  }

  const handleSuggest = async () => {
    if (!suggestTopic.trim()) {
      setError('Type a topic for the AI to write about.')
      return
    }
    setError('')
    setSuggesting(true)
    try {
      const data = await suggestQuestion(suggestTopic.trim(), suggestType, suggestDifficulty)
      // Append as a new question
      setQuestions(prev => [...prev, {
        localId: Math.random().toString(36).slice(2),
        type: data.type,
        question: data.question,
        options: data.options || null,
        correct_answer: data.correct_answer,
        explanation: data.explanation,
        difficulty: data.difficulty,
        expanded: true,
      }])
      setShowSuggest(false)
      setSuggestTopic('')
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not suggest a question.')
    } finally {
      setSuggesting(false)
    }
  }

  // Validation - returns first error message or null if valid
  const validate = () => {
    if (!title.trim()) return 'Quiz title is required.'
    if (questions.length === 0) return 'Add at least one question.'
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      if (!q.question.trim()) return `Question ${i + 1} is empty.`
      if (!q.correct_answer.trim()) return `Question ${i + 1} needs a correct answer.`
      if (q.type === 'multiple_choice') {
        const opts = (q.options || []).map(o => o.trim())
        if (opts.length < 2) return `Question ${i + 1}: at least 2 options required.`
        if (opts.some(o => !o)) return `Question ${i + 1}: all options must have text.`
        if (!opts.includes(q.correct_answer.trim())) return `Question ${i + 1}: pick which option is correct.`
        const unique = new Set(opts)
        if (unique.size !== opts.length) return `Question ${i + 1}: options must be unique.`
      }
      if (q.type === 'true_false' && !['True', 'False'].includes(q.correct_answer)) {
        return `Question ${i + 1}: pick True or False.`
      }
    }
    return null
  }

  const handleSubmit = async () => {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setError('')
    setSubmitting(true)
    try {
      const payload = {
        title: title.trim(),
        time_limit_seconds: timeLimitMinutes > 0 ? timeLimitMinutes * 60 : null,
        questions: questions.map(q => ({
          type: q.type,
          question: q.question.trim(),
          options: q.type === 'multiple_choice' ? q.options.map(o => o.trim()) : null,
          correct_answer: q.correct_answer.trim(),
          explanation: q.explanation.trim(),
          difficulty: q.difficulty,
        })),
      }
      const data = await createManualQuiz(payload)
      window.location.href = `/q/${data.id}`
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not save the quiz.')
      setSubmitting(false)
    }
  }

  return (
    <>
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {/* Title + time limit */}
      <div className="card">
        <h2><Edit3 size={20} /> Quiz details</h2>
        <div className="field">
          <label className="label">Title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Cell Biology - Chapter 3 review"
            maxLength={200}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">Time limit: {timeLimitMinutes > 0 ? `${timeLimitMinutes} min` : 'No limit'}</label>
          <div className="time-limit-row">
            {[0, 5, 10, 15, 30, 60].map(m => (
              <button
                key={m}
                type="button"
                className={`time-chip ${timeLimitMinutes === m ? 'active' : ''}`}
                onClick={() => setTimeLimitMinutes(m)}
              >
                {m === 0 ? 'No limit' : `${m} min`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Questions */}
      <div className="manual-questions-list">
        {questions.map((q, idx) => (
          <ManualQuestionCard
            key={q.localId}
            question={q}
            index={idx}
            total={questions.length}
            onUpdate={(fields) => updateQuestion(idx, fields)}
            onUpdateOption={(optIdx, val) => updateOption(idx, optIdx, val)}
            onAddOption={() => addOption(idx)}
            onRemoveOption={(optIdx) => removeOption(idx, optIdx)}
            onChangeType={(t) => changeQuestionType(idx, t)}
            onMoveUp={() => moveQuestion(idx, -1)}
            onMoveDown={() => moveQuestion(idx, 1)}
            onRemove={() => removeQuestion(idx)}
            onToggleExpand={() => updateQuestion(idx, { expanded: !q.expanded })}
          />
        ))}
      </div>

      {/* AI suggest panel */}
      {showSuggest && (
        <div className="card suggest-card">
          <h2><Sparkles size={18} /> Suggest a question with AI</h2>
          <div className="field">
            <label className="label">Topic</label>
            <input
              className="input"
              placeholder="e.g. The water cycle"
              value={suggestTopic}
              onChange={(e) => setSuggestTopic(e.target.value)}
              disabled={suggesting}
              maxLength={500}
            />
          </div>
          <div className="row">
            <div className="field">
              <label className="label">Type</label>
              <select className="select" value={suggestType} onChange={(e) => setSuggestType(e.target.value)} disabled={suggesting}>
                {Object.entries(QUESTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Difficulty</label>
              <select className="select" value={suggestDifficulty} onChange={(e) => setSuggestDifficulty(e.target.value)} disabled={suggesting}>
                {Object.entries(DIFFICULTY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          <div className="button-row">
            <button className="btn" onClick={handleSuggest} disabled={suggesting || !suggestTopic.trim()}>
              {suggesting
                ? <><Loader2 size={16} className="spinner" /> Generating...</>
                : <><Sparkles size={16} /> Generate question</>}
            </button>
            <button className="btn btn-secondary" onClick={() => setShowSuggest(false)} disabled={suggesting}>Close</button>
          </div>
          <div className="text-info" style={{ marginTop: '0.5rem' }}>
            The AI-generated question is added to your quiz. You can still edit it.
          </div>
        </div>
      )}

      {/* Add buttons */}
      <div className="manual-add-row">
        <button className="btn btn-secondary" onClick={() => addQuestion('multiple_choice')}>
          <Plus size={16} /> Add question
        </button>
        {!showSuggest && (
          <button className="btn btn-secondary" onClick={() => setShowSuggest(true)}>
            <Sparkles size={16} /> Suggest with AI
          </button>
        )}
      </div>

      {/* Submit */}
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="text-info" style={{ marginBottom: '0.85rem' }}>
          <strong>{questions.length}</strong> question{questions.length === 1 ? '' : 's'} ready to save.
        </div>
        <div className="button-row">
          <button className="btn btn-large" onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? <><Loader2 size={18} className="spinner" /> Saving...</>
              : <><Check size={18} /> Save quiz</>}
          </button>
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>Cancel</button>
        </div>
      </div>
    </>
  )
}

/* ============================================================
   ManualQuestionCard — one question editor
   ============================================================ */
function ManualQuestionCard({
  question: q, index, total,
  onUpdate, onUpdateOption, onAddOption, onRemoveOption, onChangeType,
  onMoveUp, onMoveDown, onRemove, onToggleExpand,
}) {
  return (
    <div className="card manual-question-card">
      <div className="manual-question-header" onClick={onToggleExpand}>
        <div className="manual-question-num">
          <GripVertical size={14} />
          Q{index + 1}
        </div>
        <div className="manual-question-preview">
          {q.question.trim() || <em style={{ color: 'var(--text-fade)' }}>Untitled question</em>}
        </div>
        <div className="manual-question-controls" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn-small" onClick={onMoveUp} disabled={index === 0} title="Move up">
            <ChevronUp size={14} />
          </button>
          <button className="icon-btn-small" onClick={onMoveDown} disabled={index === total - 1} title="Move down">
            <ChevronDown size={14} />
          </button>
          <button className="icon-btn-small" onClick={onRemove} disabled={total === 1} title="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {q.expanded && (
        <div className="manual-question-body">
          {/* Type + difficulty */}
          <div className="row">
            <div className="field">
              <label className="label">Type</label>
              <select className="select" value={q.type} onChange={(e) => onChangeType(e.target.value)}>
                {Object.entries(QUESTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Difficulty</label>
              <select className="select" value={q.difficulty} onChange={(e) => onUpdate({ difficulty: e.target.value })}>
                {Object.entries(DIFFICULTY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>

          {/* Question text */}
          <div className="field">
            <label className="label">Question</label>
            <textarea
              className="textarea"
              style={{ minHeight: 70 }}
              value={q.question}
              onChange={(e) => onUpdate({ question: e.target.value })}
              placeholder="Type the question..."
              maxLength={2000}
            />
          </div>

          {/* Type-specific answer area */}
          {q.type === 'multiple_choice' && (
            <div className="field">
              <label className="label">Options (mark the correct one)</label>
              {q.options.map((opt, i) => (
                <div key={i} className="manual-option-row">
                  <button
                    type="button"
                    className={`manual-option-radio ${q.correct_answer === opt && opt ? 'selected' : ''}`}
                    onClick={() => opt && onUpdate({ correct_answer: opt })}
                    title="Mark as correct"
                    disabled={!opt.trim()}
                  >
                    {q.correct_answer === opt && opt ? <Check size={14} /> : <span>{String.fromCharCode(65 + i)}</span>}
                  </button>
                  <input
                    className="input"
                    value={opt}
                    onChange={(e) => onUpdateOption(i, e.target.value)}
                    placeholder={`Option ${String.fromCharCode(65 + i)}`}
                  />
                  {q.options.length > 2 && (
                    <button className="icon-btn-small" onClick={() => onRemoveOption(i)} title="Remove option">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {q.options.length < 6 && (
                <button className="btn-ghost-small" onClick={onAddOption} style={{ marginTop: '0.4rem' }}>
                  <Plus size={13} /> Add option
                </button>
              )}
            </div>
          )}

          {q.type === 'true_false' && (
            <div className="field">
              <label className="label">Correct answer</label>
              <div className="tabs">
                {['True', 'False'].map(opt => (
                  <button
                    key={opt}
                    type="button"
                    className={`tab ${q.correct_answer === opt ? 'active' : ''}`}
                    onClick={() => onUpdate({ correct_answer: opt })}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {q.type === 'short_answer' && (
            <div className="field">
              <label className="label">Accepted answer (max 10 words; AI feedback grades partial)</label>
              <input
                className="input"
                value={q.correct_answer}
                onChange={(e) => onUpdate({ correct_answer: e.target.value })}
                placeholder="e.g. mitochondria"
                maxLength={500}
              />
            </div>
          )}

          {/* Explanation */}
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label">Explanation (shown after submission)</label>
            <textarea
              className="textarea"
              style={{ minHeight: 60 }}
              value={q.explanation}
              onChange={(e) => onUpdate({ explanation: e.target.value })}
              placeholder="Why is this the correct answer?"
              maxLength={1000}
            />
          </div>
        </div>
      )}
    </div>
  )
}
