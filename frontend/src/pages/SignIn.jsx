import { useState, useMemo } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { GraduationCap, Loader2, ArrowLeft, Mail, Lock, User, Check, X, BookOpen } from 'lucide-react'
import { apiSignIn, apiSignUp, homePathFor, isTeacherRole } from '../api'

// ----------------------------------------------------------------------------
// Password strength — must match backend rules in main.py:validate_password().
// Rules: 8+ chars, at least one letter, one number, one symbol.
// Common weak passwords are rejected server-side (not duplicated here).
// ----------------------------------------------------------------------------
function checkPasswordRules(pw) {
  return {
    length: pw.length >= 8,
    letter: /[a-zA-Z]/.test(pw),
    number: /[0-9]/.test(pw),
    symbol: /[^a-zA-Z0-9]/.test(pw),
  }
}

// 0=empty, 1=weak, 2=fair, 3=good, 4=strong
function passwordStrength(pw) {
  if (!pw) return 0
  const rules = checkPasswordRules(pw)
  let passed = Object.values(rules).filter(Boolean).length
  // Bonus point for length (12+ chars = extra credit)
  if (pw.length >= 12 && passed === 4) return 4
  return passed  // 0-4
}

const STRENGTH_LABELS = ['', 'Weak', 'Fair', 'Good', 'Strong']
const STRENGTH_COLORS = ['#374151', '#ef4444', '#f59e0b', '#3b82f6', '#10b981']

function PasswordStrengthMeter({ password }) {
  const strength = passwordStrength(password)
  const rules = checkPasswordRules(password)

  return (
    <div style={{ marginTop: '0.5rem' }}>
      {/* Strength bars */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '0.5rem' }}>
        {[1, 2, 3, 4].map(i => (
          <div
            key={i}
            style={{
              flex: 1,
              height: '4px',
              borderRadius: '2px',
              background: i <= strength ? STRENGTH_COLORS[strength] : 'var(--surface-2, #2a2438)',
              transition: 'background 0.2s',
            }}
          />
        ))}
      </div>

      {password && (
        <div style={{
          fontSize: '0.8rem',
          color: STRENGTH_COLORS[strength],
          fontWeight: 600,
          marginBottom: '0.5rem',
        }}>
          {STRENGTH_LABELS[strength]}
        </div>
      )}

      {/* Requirements checklist */}
      <div style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8rem' }}>
        <RequirementItem met={rules.length} label="At least 8 characters" />
        <RequirementItem met={rules.letter} label="At least one letter (a-z, A-Z)" />
        <RequirementItem met={rules.number} label="At least one number (0-9)" />
        <RequirementItem met={rules.symbol} label="At least one symbol (! @ # $ %)" />
      </div>
    </div>
  )
}

function RequirementItem({ met, label }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      color: met ? '#10b981' : 'var(--text-dim, #9ca3af)',
      transition: 'color 0.2s',
    }}>
      {met
        ? <Check size={14} strokeWidth={3} />
        : <X size={14} strokeWidth={2} style={{ opacity: 0.5 }} />}
      <span style={{ textDecoration: met ? 'none' : 'none' }}>{label}</span>
    </div>
  )
}

export default function SignIn() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')

  const [mode, setMode] = useState(params.get('mode') === 'signup' ? 'signup' : 'signin') // 'signin' | 'signup'
  // Account type chosen at sign-up. Admin accounts are never created here.
  const [role, setRole] = useState(params.get('role') === 'teacher' ? 'teacher' : 'student')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Compute if password is strong enough for signup
  const passwordRules = useMemo(() => checkPasswordRules(password), [password])
  const passwordValid = useMemo(
    () => Object.values(passwordRules).every(Boolean),
    [passwordRules]
  )

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
    // Client-side pre-check for signup — server will re-validate too
    if (mode === 'signup' && !passwordValid) {
      setError('Password does not meet all requirements. See below.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const data = mode === 'signup'
        ? await apiSignUp(email.trim(), password, name.trim(), role)
        : await apiSignIn(email.trim(), password)
      const user = data.user || data.teacher
      // Teacher-only pages are not useful for a student account
      const teacherOnly = next && (next.startsWith('/teacher') || next.startsWith('/live/host'))
      const adminOnly = next && next.startsWith('/admin')
      const allowed = next
        && !(teacherOnly && !isTeacherRole(user))
        && !(adminOnly && user?.role !== 'admin')
      navigate(allowed ? next : homePathFor(user))
    } catch (err) {
      setError(err.response?.data?.detail || err.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  // Only disable submit for signup mode when password is weak.
  // Sign-in should always be clickable (users might have legacy passwords).
  const submitDisabled = busy || (mode === 'signup' && !passwordValid)

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="header">
        <h1>
          <GraduationCap size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} />
          {mode === 'signin' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p>
          {mode === 'signin'
            ? 'Sign in to see your saved materials, progress and classes.'
            : 'Save your study materials and progress, and use them on any device.'}
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
              <label className="label">I am a</label>
              <div className="tabs" role="radiogroup" aria-label="Account type">
                <button type="button" role="radio" aria-checked={role === 'student'}
                  className={`tab ${role === 'student' ? 'active' : ''}`}
                  onClick={() => setRole('student')} disabled={busy}>
                  <BookOpen size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Student
                </button>
                <button type="button" role="radio" aria-checked={role === 'teacher'}
                  className={`tab ${role === 'teacher' ? 'active' : ''}`}
                  onClick={() => setRole('teacher')} disabled={busy}>
                  <GraduationCap size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Teacher
                </button>
              </div>
              <p className="text-info" style={{ marginTop: '0.4rem', fontSize: '0.8rem' }}>
                {role === 'student'
                  ? 'Your sets, flashcard progress and results are saved to your account.'
                  : 'Teachers can also create classes, assignments and live sessions.'}
              </p>
            </div>
          )}
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
              placeholder={mode === 'signup' ? 'Choose a strong password' : ''}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
            {mode === 'signup' && <PasswordStrengthMeter password={password} />}
          </div>

          <button className="btn btn-block" type="submit" disabled={submitDisabled}>
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
