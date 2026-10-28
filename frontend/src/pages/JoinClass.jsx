import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { GraduationCap, ArrowRight, Loader2, ArrowLeft } from 'lucide-react'
import { joinClass, getAuthUser } from '../api'

const STORAGE_STUDENT = 'driquiz_student_name'

export default function JoinClass() {
  const { code: codeParam } = useParams()
  const navigate = useNavigate()
  const [code, setCode] = useState(codeParam ? codeParam.toUpperCase() : '')
  const user = getAuthUser()
  const [name, setName] = useState(user?.name || localStorage.getItem(STORAGE_STUDENT) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!code.trim() || !name.trim()) {
      setError('Both fields required.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const data = await joinClass(code.trim().toUpperCase(), name.trim())
      localStorage.setItem(STORAGE_STUDENT, name.trim())
      navigate(`/student/class/${data.class.id}`, { state: { studentName: name.trim() } })
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not join class.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="header">
        <h1><GraduationCap size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} /> Join a class</h1>
        <p>Enter the code your teacher shared with you</p>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div className="card">
        <div className="field">
          <label className="label">Class code</label>
          <input
            className="input"
            placeholder="e.g. K9XM2P"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            disabled={busy}
            maxLength={10}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', letterSpacing: '0.1em', textAlign: 'center' }}
          />
        </div>

        <div className="field">
          <label className="label">Your name</label>
          <input
            className="input"
            placeholder="Drilon Rexhepi"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={busy}
            maxLength={80}
          />
        </div>

        <p className="text-info" style={{ fontSize: '0.8rem', marginTop: '-0.25rem', marginBottom: '0.9rem' }}>
          {user
            ? <>You are signed in, so this class and your results are saved to your account.</>
            : <>Tip: <Link to={`/signin?mode=signup&role=student&next=${encodeURIComponent('/join' + (code ? '/' + code : ''))}`}>create a student account</Link> to keep your results on every device.</>}
        </p>

        <button className="btn btn-block" onClick={submit} disabled={busy}>
          {busy ? <><Loader2 size={16} className="spinner" /> Joining...</> : <>Join class <ArrowRight size={16} /></>}
        </button>
      </div>

      <div className="button-row" style={{ justifyContent: 'center' }}>
        <Link to="/" className="btn btn-secondary btn-small"><ArrowLeft size={14} /> Back to home</Link>
      </div>
    </div>
  )
}
