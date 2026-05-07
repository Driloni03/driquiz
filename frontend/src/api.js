import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || 'https://driquiz-api.onrender.com'

const api = axios.create({
  baseURL: API_BASE,
  timeout: 120000,
})

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

export const generateQuiz = async (payload) => {
  const { data } = await api.post('/api/generate-quiz', payload)
  return data
}

export const submitQuiz = async (quizId, answers) => {
  const { data } = await api.post('/api/submit-quiz', {
    quiz_id: quizId,
    answers,
  })
  return data
}

export const streamChat = async ({ messages, mode, context, onDelta, signal }) => {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, mode, context }),
    signal,
  })

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const err = await response.json()
      detail = err.detail || detail
    } catch (_) {}
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

// Helper: format seconds as M:SS
export const formatTimestamp = (seconds) => {
  if (seconds == null || isNaN(seconds)) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Helper: build YouTube link with timestamp
export const youtubeLinkAt = (videoId, seconds) => {
  if (!videoId) return null
  const t = seconds != null ? Math.max(0, Math.floor(seconds)) : 0
  return `https://www.youtube.com/watch?v=${videoId}&t=${t}s`
}
