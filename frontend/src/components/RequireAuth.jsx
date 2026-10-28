import { useEffect, useState } from 'react'
import { Navigate, useLocation, Link } from 'react-router-dom'
import { getAuthToken, apiMe, clearAuth, isTeacherRole, homePathFor } from '../api'

// Guards a page behind sign-in. `role` limits it further:
//   role="teacher" → teacher or admin accounts
//   role="admin"   → admin accounts only
// Without `role`, any signed-in account (student, teacher, admin) is allowed.
export default function RequireAuth({ children, role }) {
  const location = useLocation()
  const [status, setStatus] = useState(getAuthToken() ? 'checking' : 'no-token')
  const [user, setUser] = useState(null)

  useEffect(() => {
    if (status !== 'checking') return
    apiMe()
      .then((u) => { setUser(u); setStatus('authed') })
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

  const allowed =
    !role ||
    (role === 'teacher' && isTeacherRole(user)) ||
    (role === 'admin' && user?.role === 'admin')

  if (!allowed) {
    return (
      <div className="container" style={{ maxWidth: 520 }}>
        <div className="card center-text" style={{ marginTop: '4rem' }}>
          <h2 style={{ marginBottom: '0.5rem' }}>
            {role === 'admin' ? 'Administrators only' : 'Teacher account needed'}
          </h2>
          <p style={{ color: 'var(--text-dim)' }}>
            You are signed in as {user?.name} ({user?.role}). This page is not available for your account.
          </p>
          <div className="button-row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
            <Link to={homePathFor(user)} className="btn">Go to my page</Link>
          </div>
        </div>
      </div>
    )
  }

  return children
}
