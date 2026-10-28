import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const api = axios.create({ baseURL: API_BASE, timeout: 120000 })

// Inject Authorization header from localStorage if present
api.interceptors.request.use((config) => {
  try {
    const token = localStorage.getItem('driquiz_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
  } catch (_) {}
  return config
})

// On 401, clear token (let UI redirect to /signin)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      try {
        localStorage.removeItem('driquiz_token')
        localStorage.removeItem('driquiz_teacher')
      } catch (_) {}
    }
    return Promise.reject(error)
  }
)

// Auth helpers (these don't import React; the auth context will use them)
// The signed-in account is stored under 'driquiz_teacher' for backward
// compatibility; it now holds any account (student, teacher or admin) with its role.
const notifyAuthChange = () => {
  try { window.dispatchEvent(new Event('driquiz-auth')) } catch (_) {}
}
export const saveAuth = (token, user) => {
  localStorage.setItem('driquiz_token', token)
  localStorage.setItem('driquiz_teacher', JSON.stringify(user))
  notifyAuthChange()
}
export const clearAuth = () => {
  localStorage.removeItem('driquiz_token')
  localStorage.removeItem('driquiz_teacher')
  notifyAuthChange()
}
export const getAuthToken = () => localStorage.getItem('driquiz_token')
export const getAuthUser = () => {
  try { return JSON.parse(localStorage.getItem('driquiz_teacher') || 'null') }
  catch (_) { return null }
}
export const getAuthTeacher = getAuthUser
export const isTeacherRole = (user) => !!user && (user.role === 'teacher' || user.role === 'admin' || !user.role)
export const homePathFor = (user) =>
  !user ? '/app' : user.role === 'admin' ? '/admin' : isTeacherRole(user) ? '/teacher' : '/my'

// Items a guest creates are remembered in this browser, so they show up in
// History and can be moved into the account after signing in.
const GUEST_KEY = 'driquiz_guest_items'
const readGuestItems = () => {
  try { return JSON.parse(localStorage.getItem(GUEST_KEY) || '{}') } catch (_) { return {} }
}
export const rememberCreated = (kind, id) => {
  if (!id || getAuthToken()) return
  try {
    const items = readGuestItems()
    const list = items[kind] || []
    if (!list.includes(id)) items[kind] = [id, ...list].slice(0, 100)
    localStorage.setItem(GUEST_KEY, JSON.stringify(items))
  } catch (_) {}
}
export const getGuestIds = (kind) => readGuestItems()[kind] || []

export const claimGuestItems = async () => {
  const items = readGuestItems()
  const body = {
    quiz_ids: items.quizzes || [],
    flashcard_ids: items.flashcards || [],
    note_ids: items.notes || [],
  }
  if (!body.quiz_ids.length && !body.flashcard_ids.length && !body.note_ids.length) return 0
  try {
    const { data } = await api.post('/api/me/claim', body)
    localStorage.removeItem(GUEST_KEY)
    return data.claimed
  } catch (_) { return 0 }
}

// Auth API
export const apiSignUp = async (email, password, name, role = 'teacher') => {
  const { data } = await api.post('/api/auth/signup', { email, password, name, role })
  saveAuth(data.token, data.user || data.teacher)
  await claimGuestItems()
  return data
}
export const apiSignIn = async (email, password) => {
  const { data } = await api.post('/api/auth/signin', { email, password })
  saveAuth(data.token, data.user || data.teacher)
  await claimGuestItems()
  return data
}
export const apiSignOut = async () => {
  try { await api.post('/api/auth/signout') } catch (_) {}
  clearAuth()
}
export const apiMe = async () => {
  const { data } = await api.get('/api/auth/me')
  const user = data.user || data.teacher
  // Keep the stored copy fresh (e.g. a role changed by an admin)
  const token = getAuthToken()
  if (token && user) {
    localStorage.setItem('driquiz_teacher', JSON.stringify(user))
  }
  return user
}

// =================== STUDENT ACCOUNT ===================
export const getMyLibrary = async () => {
  const { data } = await api.get('/api/me/library')
  return data
}
export const getMyProgress = async () => {
  const { data } = await api.get('/api/me/progress')
  return data
}
export const getFlashcardProgress = async (setId) => {
  const { data } = await api.get(`/api/me/flashcards/${setId}/progress`)
  return data.cards
}
export const saveFlashcardProgress = async (setId, item) => {
  const { data } = await api.put(`/api/me/flashcards/${setId}/progress`, item)
  return data
}

// =================== ADMIN ===================
export const adminStats = async () => (await api.get('/api/admin/stats')).data
export const adminUsers = async () => (await api.get('/api/admin/users')).data.users
export const adminSetRole = async (userId, role) => (await api.patch(`/api/admin/users/${userId}`, { role })).data
export const adminContent = async () => (await api.get('/api/admin/content')).data
export const adminDeleteQuiz = async (id) => (await api.delete(`/api/admin/quizzes/${id}`)).data
export const adminDeleteFlashcards = async (id) => (await api.delete(`/api/admin/flashcards/${id}`)).data
export const adminDeleteNote = async (id) => (await api.delete(`/api/admin/notes/${id}`)).data
export const adminUserDetail = async (id) => (await api.get(`/api/admin/users/${id}`)).data
export const adminBlockUser = async (id) => (await api.post(`/api/admin/users/${id}/block`)).data
export const adminUnblockUser = async (id) => (await api.post(`/api/admin/users/${id}/unblock`)).data
export const adminDeleteUser = async (id, deleteContent = false) =>
  (await api.delete(`/api/admin/users/${id}`, { params: { delete_content: deleteContent } })).data
export const adminAudit = async (limit = 200) => (await api.get('/api/admin/audit', { params: { limit } })).data.actions
export const adminMaintenance = async (guestDays = 30) =>
  (await api.get('/api/admin/maintenance', { params: { guest_days: guestDays } })).data
export const adminCleanup = async (task, days = 30) =>
  (await api.post('/api/admin/maintenance/cleanup', { task, days })).data

// Live mode API
export const createLiveSession = async (quiz_id) => {
  const { data } = await api.post('/api/live/create', { quiz_id })
  return data
}
export const joinLiveSession = async (code, player_name) => {
  const { data } = await api.post('/api/live/join', { code, player_name })
  return data
}
export const getLiveState = async (sessionId, playerId = null) => {
  const params = playerId != null ? { player_id: playerId } : {}
  const { data } = await api.get(`/api/live/${sessionId}/state`, { params })
  return data
}
export const startLiveSession = async (sessionId) => {
  const { data } = await api.post(`/api/live/${sessionId}/start`)
  return data
}
export const revealLiveQuestion = async (sessionId) => {
  const { data } = await api.post(`/api/live/${sessionId}/reveal`)
  return data
}
export const nextLiveQuestion = async (sessionId) => {
  const { data } = await api.post(`/api/live/${sessionId}/next`)
  return data
}
export const submitLiveAnswer = async (session_id, player_id, question_index, answer) => {
  const { data } = await api.post('/api/live/answer', { session_id, player_id, question_index, answer })
  return data
}


export const uploadPdf = async (file) => {
  const formData = new FormData()
  formData.append('file', file)
  const { data } = await api.post('/api/upload-pdf', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}

// Audio / video transcription via Azure Whisper.
// Accepts a File (from <input type="file">) or a Blob (from MediaRecorder).
// If a Blob is passed, provide a filename (with extension) so the backend
// can detect the format.
export const transcribeAudio = async (file, filename = null) => {
  const formData = new FormData()
  if (filename) {
    formData.append('file', file, filename)
  } else {
    formData.append('file', file)
  }
  const { data } = await api.post('/api/transcribe-audio', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 180000, // Transcription can take up to 3 min for long audio
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
  rememberCreated('quizzes', data?.id)
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

// Signed in: the account's own items. Guest: only items made in this browser.
const guestParams = (kind) =>
  getAuthToken() ? {} : { ids: getGuestIds(kind).join(',') }

export const listQuizzes = async () => {
  const { data } = await api.get('/api/quizzes', { params: guestParams('quizzes') })
  return data.quizzes
}

// Generic streaming helper for /api/chat and /api/eli5
const streamEndpoint = async (path, body, onDelta, signal) => {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
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
  rememberCreated('flashcards', data?.id)
  return data
}

export const generateFlashcardsFromQuiz = async (quiz_id, title) => {
  const { data } = await api.post('/api/flashcards/generate-from-quiz', { quiz_id, title })
  rememberCreated('flashcards', data?.id)
  return data
}

export const getFlashcardSet = async (setId) => {
  const { data } = await api.get(`/api/flashcards/${setId}`)
  return data
}

export const listFlashcardSets = async () => {
  const { data } = await api.get('/api/flashcards', { params: guestParams('flashcards') })
  return data.sets
}

// Study notes
export const generateNotes = async (payload) => {
  const { data } = await api.post('/api/notes/generate', payload)
  rememberCreated('notes', data?.id)
  return data
}

export const getNote = async (noteId) => {
  const { data } = await api.get(`/api/notes/${noteId}`)
  return data
}

export const listNotes = async () => {
  const { data } = await api.get('/api/notes', { params: guestParams('notes') })
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

// CSV exports need the teacher's token, so they are fetched with the API
// client and saved through a temporary link instead of opening a plain URL.
const downloadCsv = async (path, fallbackName) => {
  const res = await api.get(path, { responseType: 'blob' })
  const match = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = match ? match[1] : fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export const downloadAssignmentCsv = (assignmentId) =>
  downloadCsv(`/api/assignments/${assignmentId}/export.csv`, 'assignment.csv')

export const downloadClassCsv = (classId) =>
  downloadCsv(`/api/classes/${classId}/export.csv`, 'gradebook.csv')


// =================== ANNOUNCEMENTS ===================
export const createAnnouncement = async (class_id, author_name, message) => {
  const { data } = await api.post('/api/announcements', { class_id, author_name, message })
  return data
}

export const listAnnouncements = async (classId) => {
  const { data } = await api.get(`/api/classes/${classId}/announcements`)
  return data.announcements
}

export const deleteAnnouncement = async (announcementId) => {
  const { data } = await api.delete(`/api/announcements/${announcementId}`)
  return data
}

// =================== CLASS UPDATE ===================
export const updateClass = async (classId, fields) => {
  const { data } = await api.patch(`/api/classes/${classId}`, fields)
  return data
}

// =================== AI SHORT-ANSWER GRADING ===================
export const gradeShortAnswer = async (question, correct_answer, student_answer) => {
  const { data } = await api.post('/api/grade-short-answer', {
    question, correct_answer, student_answer,
  })
  return data
}


// =================== MANUAL QUIZ ===================
export const createManualQuiz = async (payload) => {
  const { data } = await api.post('/api/quiz/manual', payload)
  rememberCreated('quizzes', data?.id)
  return data
}

export const suggestQuestion = async (topic, type, difficulty = 'medium') => {
  const { data } = await api.post('/api/quiz/suggest-question', { topic, type, difficulty })
  return data
}

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
