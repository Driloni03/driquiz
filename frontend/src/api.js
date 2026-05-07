import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

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
