import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { getAuthToken, apiMe, clearAuth } from '../api'

export default function RequireAuth({ children }) {
  const location = useLocation()
  const [status, setStatus] = useState(getAuthToken() ? 'checking' : 'no-token')

  useEffect(() => {
    if (status !== 'checking') return
    apiMe()
      .then(() => setStatus('authed'))
      .catch(() => {
        clearAuth()
        setStatus('no-token')
      })
  }, [status])

  if (status === 'checking') {
    return (
      <div className="container">
        <div className="card center-text" style={{ marginTop: '4rem' }}>
          <div className="spinner" />
          <p style={{ marginTop: '0.75rem', color: 'var(--text-dim)' }}>Checking your session...</p>
        </div>
      </div>
    )
  }

  if (status === 'no-token') {
    const redirect = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/signin?next=${redirect}`} replace />
  }

  return children
}
