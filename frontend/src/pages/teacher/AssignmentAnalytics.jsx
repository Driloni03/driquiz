import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  BarChart3, Loader2, ArrowLeft, Download, Trophy, Users, TrendingUp,
  AlertTriangle, HelpCircle, Layers,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { getAssignmentAnalytics, downloadAssignmentCsv } from '../../api'

// ----------------------------------------------------------------------------
// Colour helpers
// ----------------------------------------------------------------------------
const scoreColor = (pct) => {
  if (pct == null) return 'var(--text-dim, #9ca3af)'
  if (pct >= 80) return '#10b981'   // green — easy
  if (pct >= 50) return '#f59e0b'   // amber — medium
  return '#ef4444'                  // red — hard
}

const difficultyLabel = (label) => {
  if (label === 'easy') return { text: 'Easy', color: '#10b981' }
  if (label === 'medium') return { text: 'Medium', color: '#f59e0b' }
  if (label === 'hard') return { text: 'Hard', color: '#ef4444' }
  if (label === 'insufficient_data') return { text: 'Not enough data', color: '#6b7280' }
  return { text: '—', color: '#6b7280' }
}

const questionTypeLabel = (t) => {
  if (!t) return 'Question'
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ----------------------------------------------------------------------------
// Custom bar-chart tooltip
// ----------------------------------------------------------------------------
function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{
      background: 'var(--surface-2, #1a1625)',
      border: '1px solid var(--border, #2a2438)',
      borderRadius: '8px',
      padding: '0.6rem 0.8rem',
      maxWidth: '320px',
      fontSize: '0.85rem',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
        Q{d.number}: {d.question.length > 70 ? d.question.slice(0, 70) + '…' : d.question}
      </div>
      <div style={{ color: d.color, fontWeight: 700 }}>
        {d.correct_rate}% correct
      </div>
      <div style={{ color: 'var(--text-dim, #9ca3af)', fontSize: '0.8rem' }}>
        {d.correct_count} of {d.total_answered} students
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Per-question bar chart
// ----------------------------------------------------------------------------
function QuestionAccuracyChart({ questions }) {
  const data = questions
    .filter(q => q.correct_rate != null)
    .map((q, i) => ({
      number: i + 1,
      question: q.question,
      correct_rate: q.correct_rate,
      correct_count: q.correct_count,
      total_answered: q.total_answered,
      color: scoreColor(q.correct_rate),
    }))

  if (data.length === 0) return null

  return (
    <div className="card">
      <h2 style={{ marginBottom: '0.25rem' }}>
        <BarChart3 size={20} /> Per-question accuracy
      </h2>
      <p className="text-info" style={{ marginBottom: '1rem' }}>
        Green = mastered (≥80%), amber = mixed (50–79%), red = struggling (&lt;50%).
      </p>
      <ResponsiveContainer width="100%" height={Math.max(220, data.length * 34)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 32, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #2a2438)" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            stroke="var(--text-dim, #9ca3af)"
            fontSize={12}
          />
          <YAxis
            type="category"
            dataKey="number"
            tickFormatter={(v) => `Q${v}`}
            stroke="var(--text-dim, #9ca3af)"
            fontSize={12}
            width={40}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(124, 58, 237, 0.08)' }} />
          <Bar dataKey="correct_rate" radius={[0, 4, 4, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Most difficult questions callout (only shown if any question is <50%)
// ----------------------------------------------------------------------------
function DifficultQuestionsCallout({ questions }) {
  const hard = questions
    .map((q, i) => ({ ...q, number: i + 1 }))
    .filter(q => q.correct_rate != null && q.correct_rate < 50)
    .sort((a, b) => a.correct_rate - b.correct_rate)

  if (hard.length === 0) return null

  return (
    <div className="card" style={{
      borderLeft: '4px solid #ef4444',
      background: 'rgba(239, 68, 68, 0.05)',
    }}>
      <h2 style={{ marginBottom: '0.25rem', color: '#ef4444' }}>
        <AlertTriangle size={20} /> Most difficult questions ({hard.length})
      </h2>
      <p className="text-info" style={{ marginBottom: '1rem' }}>
        These questions may be worth re-teaching or re-phrasing.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {hard.map((q) => (
          <div key={q.question_id || q.number} style={{
            padding: '0.9rem 1rem',
            background: 'var(--surface-2, #1a1625)',
            border: '1px solid var(--border, #2a2438)',
            borderRadius: '10px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '0.4rem' }}>
              <div style={{ fontWeight: 600 }}>Q{q.number}. {q.question}</div>
              <div style={{
                fontWeight: 700,
                color: '#ef4444',
                whiteSpace: 'nowrap',
                fontSize: '1.05rem',
              }}>
                {q.correct_rate}%
              </div>
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-dim, #9ca3af)', marginBottom: '0.5rem' }}>
              <strong style={{ color: '#10b981' }}>Correct answer:</strong> {q.correct_answer}
            </div>
            {q.common_wrong_answers?.length > 0 && (
              <div style={{ fontSize: '0.85rem' }}>
                <div style={{ color: 'var(--text-dim, #9ca3af)', marginBottom: '0.3rem' }}>
                  Common wrong answers:
                </div>
                <ul style={{ margin: 0, paddingLeft: '1.2rem', color: 'var(--text-dim, #9ca3af)' }}>
                  {q.common_wrong_answers.map((w, i) => (
                    <li key={i}>
                      "{w.answer}" — {w.count} student{w.count === 1 ? '' : 's'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Concept / question-type rollup
// ----------------------------------------------------------------------------
function ConceptRollup({ rollup }) {
  if (!rollup || rollup.length === 0) return null
  return (
    <div className="card">
      <h2 style={{ marginBottom: '0.25rem' }}>
        <Layers size={20} /> By question type
      </h2>
      <p className="text-info" style={{ marginBottom: '1rem' }}>
        Average accuracy grouped by the format of the question.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {rollup.map((r) => (
          <div key={r.group} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ flex: '0 0 140px', fontWeight: 600 }}>
              {questionTypeLabel(r.group)}
            </div>
            <div style={{ flex: 1, height: '10px', background: 'var(--surface-2, #1a1625)', borderRadius: '5px', overflow: 'hidden' }}>
              <div style={{
                width: `${r.average_correct_rate}%`,
                height: '100%',
                background: scoreColor(r.average_correct_rate),
                transition: 'width 0.5s ease',
              }} />
            </div>
            <div style={{
              flex: '0 0 90px',
              textAlign: 'right',
              color: scoreColor(r.average_correct_rate),
              fontWeight: 700,
            }}>
              {r.average_correct_rate}%
            </div>
            <div style={{
              flex: '0 0 90px',
              textAlign: 'right',
              fontSize: '0.85rem',
              color: 'var(--text-dim, #9ca3af)',
            }}>
              {r.question_count} question{r.question_count === 1 ? '' : 's'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Per-question detail list (replaces the old plain list)
// ----------------------------------------------------------------------------
function QuestionDetailList({ questions }) {
  return (
    <div className="card">
      <h2><HelpCircle size={20} /> All questions ({questions.length})</h2>
      <p className="text-info" style={{ marginBottom: '1rem' }}>
        Full breakdown of every question in the assignment.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {questions.map((q, i) => {
          const dl = difficultyLabel(q.difficulty_label)
          return (
            <div key={q.question_id || `q-${i}`} style={{
              padding: '0.85rem 1rem',
              background: 'var(--surface-2, #1a1625)',
              border: '1px solid var(--border, #2a2438)',
              borderRadius: '10px',
            }}>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                <div style={{
                  flex: '0 0 32px', height: 32, borderRadius: '50%',
                  background: 'rgba(124, 58, 237, 0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: '0.85rem', color: '#a855f7',
                }}>{i + 1}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>{q.question}</div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-dim, #9ca3af)', marginBottom: '0.35rem' }}>
                    <strong style={{ color: '#10b981' }}>Answer:</strong> {q.correct_answer}
                    {' · '}
                    <span>{questionTypeLabel(q.type)}</span>
                  </div>
                  {q.correct_rate != null ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem' }}>
                      <span style={{
                        padding: '0.15rem 0.6rem',
                        borderRadius: '999px',
                        background: `${dl.color}22`,
                        color: dl.color,
                        fontWeight: 600,
                        fontSize: '0.75rem',
                      }}>{dl.text}</span>
                      <span style={{ color: scoreColor(q.correct_rate), fontWeight: 700 }}>
                        {q.correct_rate}% correct
                      </span>
                      <span style={{ color: 'var(--text-dim, #9ca3af)' }}>
                        · {q.correct_count}/{q.total_answered}
                      </span>
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-dim, #9ca3af)', fontStyle: 'italic' }}>
                      No response data yet
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// Main page
// ============================================================================
export default function AssignmentAnalytics() {
  const { assignmentId } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [assignmentId])

  const load = async () => {
    setLoading(true)
    try {
      const result = await getAssignmentAnalytics(assignmentId)
      setData(result)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load analytics.')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (iso) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    } catch (_) { return iso }
  }

  if (loading) {
    return (
      <div className="container">
        <div className="card center-text"><Loader2 size={20} className="spinner" /></div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error || 'Not found'}</div>
        <Link to="/teacher" className="btn btn-secondary"><ArrowLeft size={16} /> Back</Link>
      </div>
    )
  }

  const hasSubmissions = data.total_submissions > 0
  const hasPerQuestionData = data.has_per_question_data === true

  return (
    <div className="container">
      <Link to="/teacher" className="back-link"><ArrowLeft size={14} /> Dashboard</Link>

      <div className="header">
        <h1>
          <BarChart3 size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} />
          {data.quiz_title}
        </h1>
        <p>Assignment analytics</p>
      </div>

      {/* Summary stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon"><Users size={20} /></div>
          <div className="stat-value">{data.total_submissions}</div>
          <div className="stat-label">Submissions</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><TrendingUp size={20} /></div>
          <div className="stat-value" style={{ color: scoreColor(data.average_pct) }}>
            {data.average_pct}%
          </div>
          <div className="stat-label">Class average</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><Trophy size={20} /></div>
          <div className="stat-value">
            {data.submissions[0]?.percentage ?? 0}%
          </div>
          <div className="stat-label">Top score</div>
        </div>
      </div>

      {/* Empty state banner if no per-question data (for older assignments) */}
      {hasSubmissions && !hasPerQuestionData && (
        <div className="alert" style={{
          background: 'rgba(59, 130, 246, 0.1)',
          border: '1px solid rgba(59, 130, 246, 0.3)',
          color: '#3b82f6',
          marginBottom: '1rem',
        }}>
          <strong>Per-question breakdown not available for this assignment.</strong>
          <div style={{ fontSize: '0.85rem', marginTop: '0.35rem', color: 'var(--text)' }}>
            This is normal for submissions made before per-question tracking was added.
            New submissions will populate the detailed views below.
          </div>
        </div>
      )}

      {/* Difficult questions callout — only if any exist */}
      {hasPerQuestionData && <DifficultQuestionsCallout questions={data.questions} />}

      {/* Bar chart */}
      {hasPerQuestionData && <QuestionAccuracyChart questions={data.questions} />}

      {/* Concept rollup */}
      {hasPerQuestionData && <ConceptRollup rollup={data.concept_rollup} />}

      {/* Submissions list */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}><Trophy size={20} /> Submissions ({data.total_submissions})</h2>
          {data.total_submissions > 0 && (
            <button className="btn btn-secondary btn-small" onClick={() => downloadAssignmentCsv(assignmentId).catch(() => alert('Could not download the CSV file.'))}>
              <Download size={14} /> CSV
            </button>
          )}
        </div>

        {data.submissions.length === 0 ? (
          <p className="text-info center-text" style={{ padding: '1rem' }}>
            No submissions yet. When students take this quiz, their scores appear here.
          </p>
        ) : (
          <div className="submission-list">
            {data.submissions.map((s, i) => (
              <div key={`sub-${i}`} className="submission-row">
                <div className="submission-rank">
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                </div>
                <div className="submission-info">
                  <div className="submission-name">{s.display_name}</div>
                  <div className="submission-time">{formatDate(s.created_at)}</div>
                </div>
                <div className="submission-score" style={{ color: scoreColor(s.percentage) }}>
                  <strong>{s.percentage}%</strong>
                  <span className="submission-fraction">{s.score}/{s.total}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-question detail cards */}
      <QuestionDetailList questions={data.questions} />
    </div>
  )
}
