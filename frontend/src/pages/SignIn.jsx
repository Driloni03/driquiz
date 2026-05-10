import { useState } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { GraduationCap, Loader2, ArrowLeft, Mail, Lock, User } from 'lucide-react'
import { apiSignIn, apiSignUp } from '../api'

export default function SignIn() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const redirectTo = params.get('next') || '/teacher'

  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e?.preventDefault?.()
    if (!email.trim() || !password) {
      setError('Email and password are required.')
      return
    }
    if (mode === 'signup' && !name.trim()) {
      setError('Please enter your name.')
      return
    }
    setError('')
    setBusy(true)
    try {
      if (mode === 'signup') {
        await apiSignUp(email.trim(), password, name.trim())
      } else {
        await apiSignIn(email.trim(), password)
      }
      navigate(redirectTo)
    } catch (err) {
      setError(err.response?.data?.detail || err.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="header">
        <h1>
          <GraduationCap size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} />
          {mode === 'signin' ? 'Welcome back' : 'Create teacher account'}
        </h1>
        <p>
          {mode === 'signin'
            ? 'Sign in to manage your classes and quizzes.'
            : 'Sign up to start running classes and live quizzes.'}
        </p>
      </div>

      <div className="card">
        <div className="tabs" style={{ marginBottom: '1.25rem' }}>
          <button className={`tab ${mode === 'signin' ? 'active' : ''}`} onClick={() => { setMode('signin'); setError('') }} type="button">
            Sign in
          </button>
          <button className={`tab ${mode === 'signup' ? 'active' : ''}`} onClick={() => { setMode('signup'); setError('') }} type="button">
            Sign up
          </button>
        </div>

        {error && <div className="alert alert-error">⚠️ {error}</div>}

        <form onSubmit={submit}>
          {mode === 'signup' && (
            <div className="field">
              <label className="label"><User size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Your name</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                placeholder="Drilon Rexhepi"
                maxLength={80}
                autoComplete="name"
              />
            </div>
          )}

          <div className="field">
            <label className="label"><Mail size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              placeholder="you@university.edu"
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label className="label"><Lock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              placeholder={mode === 'signup' ? 'At least 6 characters' : ''}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </div>

          <button className="btn btn-block" type="submit" disabled={busy}>
            {busy
              ? <><Loader2 size={16} className="spinner" /> {mode === 'signup' ? 'Creating account...' : 'Signing in...'}</>
              : (mode === 'signup' ? 'Create account' : 'Sign in')}
          </button>
        </form>

        <p className="text-info center-text" style={{ marginTop: '1rem' }}>
          {mode === 'signin'
            ? <>No account yet? <button className="link-btn" type="button" onClick={() => { setMode('signup'); setError('') }}>Sign up</button></>
            : <>Already have one? <button className="link-btn" type="button" onClick={() => { setMode('signin'); setError('') }}>Sign in</button></>}
        </p>
      </div>

      <div className="button-row" style={{ justifyContent: 'center' }}>
        <Link to="/" className="btn btn-secondary btn-small"><ArrowLeft size={14} /> Back to home</Link>
      </div>
    </div>
  )
}
