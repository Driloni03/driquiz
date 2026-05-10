import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const api = axios.create({ baseURL: API_BASE, timeout: 120000 })

export const uploadPdf = async (file) => {
  const formData = new FormData()
  formData.append('file', file)
  const { data } = await api.post('/api/upload-pdf', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}

export const fetchYoutubeTranscript = async (url) => {
  const { data } = await api.post('/api/youtube', { url })
  return data
}

export const pasteYoutubeTranscript = async (url, transcript) => {
  const { data } = await api.post('/api/youtube-paste', { url, transcript })
  return data
}

export const extractConcepts = async (text) => {
  const { data } = await api.post('/api/extract-concepts', { text })
  return data.concepts
}

export const generateQuiz = async (payload) => {
  const { data } = await api.post('/api/generate-quiz', payload)
  return data
}

export const submitQuiz = async (quizId, answers) => {
  const { data } = await api.post('/api/submit-quiz', {
    quiz_id: quizId, answers,
  })
  return data
}

export const submitToLeaderboard = async (quizId, answers, displayName) => {
  const { data } = await api.post('/api/leaderboard/submit', {
    quiz_id: quizId, answers, display_name: displayName,
  })
  return data
}

export const getLeaderboard = async (quizId) => {
  const { data } = await api.get(`/api/leaderboard/${quizId}`)
  return data
}

export const getQuiz = async (quizId) => {
  const { data } = await api.get(`/api/quiz/${quizId}`)
  return data
}

export const getPublicQuiz = async (quizId) => {
  const { data } = await api.get(`/api/quiz/${quizId}/public`)
  return data
}

export const listQuizzes = async () => {
  const { data } = await api.get('/api/quizzes')
  return data.quizzes
}

// Generic streaming helper for /api/chat and /api/eli5
const streamEndpoint = async (path, body, onDelta, signal) => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try { const err = await response.json(); detail = err.detail || detail } catch (_) {}
    throw new Error(detail)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return
      try {
        const parsed = JSON.parse(data)
        if (parsed.error) throw new Error(parsed.error)
        if (parsed.delta) onDelta(parsed.delta)
      } catch (e) {
        if (e.message && !e.message.includes('JSON')) throw e
      }
    }
  }
}

export const streamChat = async ({ messages, mode, context, onDelta, signal }) =>
  streamEndpoint('/api/chat', { messages, mode, context }, onDelta, signal)

export const streamEli5 = async ({ question, answer, original_explanation, onDelta, signal }) =>
  streamEndpoint('/api/eli5', { question, answer, original_explanation }, onDelta, signal)


// Flashcards
export const generateFlashcardsFromText = async (payload) => {
  const { data } = await api.post('/api/flashcards/generate-from-text', payload)
  return data
}

export const generateFlashcardsFromQuiz = async (quiz_id, title) => {
  const { data } = await api.post('/api/flashcards/generate-from-quiz', { quiz_id, title })
  return data
}

export const getFlashcardSet = async (setId) => {
  const { data } = await api.get(`/api/flashcards/${setId}`)
  return data
}

export const listFlashcardSets = async () => {
  const { data } = await api.get('/api/flashcards')
  return data.sets
}

// Study notes
export const generateNotes = async (payload) => {
  const { data } = await api.post('/api/notes/generate', payload)
  return data
}

export const getNote = async (noteId) => {
  const { data } = await api.get(`/api/notes/${noteId}`)
  return data
}

export const listNotes = async () => {
  const { data } = await api.get('/api/notes')
  return data.notes
}


// =================== CLASSROOM ===================
export const createClass = async (name, teacher_name) => {
  const { data } = await api.post('/api/classes', { name, teacher_name })
  return data
}

export const listClasses = async () => {
  const { data } = await api.get('/api/classes')
  return data.classes
}

export const getClass = async (classId) => {
  const { data } = await api.get(`/api/classes/${classId}`)
  return data
}

export const deleteClass = async (classId) => {
  const { data } = await api.delete(`/api/classes/${classId}`)
  return data
}

export const getClassByCode = async (code) => {
  const { data } = await api.get(`/api/classes/by-code/${code}`)
  return data
}

export const joinClass = async (code, student_name) => {
  const { data } = await api.post('/api/classes/join', { code, student_name })
  return data
}

export const createAssignment = async (class_id, quiz_id, due_at = null) => {
  const { data } = await api.post('/api/assignments', { class_id, quiz_id, due_at })
  return data
}

export const deleteAssignment = async (assignmentId) => {
  const { data } = await api.delete(`/api/assignments/${assignmentId}`)
  return data
}

export const getAssignment = async (assignmentId) => {
  const { data } = await api.get(`/api/assignments/${assignmentId}`)
  return data
}

export const submitAssignment = async (assignment_id, student_name, answers) => {
  const { data } = await api.post('/api/assignments/submit', { assignment_id, student_name, answers })
  return data
}

export const getAssignmentAnalytics = async (assignmentId) => {
  const { data } = await api.get(`/api/assignments/${assignmentId}/analytics`)
  return data
}

export const exportAssignmentCsvUrl = (assignmentId) =>
  `${API_BASE}/api/assignments/${assignmentId}/export.csv`

export const exportClassCsvUrl = (classId) =>
  `${API_BASE}/api/classes/${classId}/export.csv`

export const formatTimestamp = (seconds) => {
  if (seconds == null || isNaN(seconds)) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export const youtubeLinkAt = (videoId, seconds) => {
  if (!videoId) return null
  const t = seconds != null ? Math.max(0, Math.floor(seconds)) : 0
  return `https://www.youtube.com/watch?v=${videoId}&t=${t}s`
}

// Tiny confetti helper - lazy-loads canvas-confetti
export const fireConfetti = async (intensity = 'normal') => {
  try {
    const confetti = (await import('canvas-confetti')).default
    if (intensity === 'high') {
      confetti({ particleCount: 150, spread: 90, origin: { y: 0.6 } })
      setTimeout(() => confetti({ particleCount: 80, angle: 60, spread: 70, origin: { x: 0 } }), 200)
      setTimeout(() => confetti({ particleCount: 80, angle: 120, spread: 70, origin: { x: 1 } }), 400)
    } else {
      confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } })
    }
  } catch (e) {
    console.error('Confetti failed:', e)
  }
}
