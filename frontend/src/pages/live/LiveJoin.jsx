import { useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { Zap, ArrowRight, Loader2, ArrowLeft } from 'lucide-react'
import { joinLiveSession } from '../../api'

const STORAGE_PLAYER = 'driquiz_live_player_name'

export default function LiveJoin() {
  const navigate = useNavigate()
  const { code: codeParam } = useParams()
  const [code, setCode] = useState(codeParam ? codeParam.toUpperCase() : '')
  const [name, setName] = useState(localStorage.getItem(STORAGE_PLAYER) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e?.preventDefault?.()
    if (!code.trim() || !name.trim()) {
      setError('Both fields required.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const data = await joinLiveSession(code.trim().toUpperCase(), name.trim())
      localStorage.setItem(STORAGE_PLAYER, name.trim())
      navigate(`/live/play/${data.session_id}`, {
        state: { playerId: data.player_id, playerName: data.player_name },
      })
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not join.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="header">
        <h1><Zap size={28} style={{ verticalAlign: 'middle', marginRight: 8, color: 'var(--accent-light)' }} /> Join live quiz</h1>
        <p>Enter the 6-character code your teacher shared</p>
      </div>

      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div className="card">
        <form onSubmit={submit}>
          <div className="field">
            <label className="label">Game code</label>
            <input
              className="input"
              placeholder="K9XM2P"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              disabled={busy}
              maxLength={10}
              autoFocus
              style={{ fontFamily: 'var(--font-mono)', fontSize: '1.4rem', letterSpacing: '0.2em', textAlign: 'center' }}
            />
          </div>

          <div className="field">
            <label className="label">Your name</label>
            <input
              className="input"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={busy}
              maxLength={80}
            />
          </div>

          <button className="btn btn-block" type="submit" disabled={busy}>
            {busy ? <><Loader2 size={16} className="spinner" /> Joining...</> : <>Join <ArrowRight size={16} /></>}
          </button>
        </form>
      </div>

      <div className="button-row" style={{ justifyContent: 'center' }}>
        <Link to="/" className="btn btn-secondary btn-small"><ArrowLeft size={14} /> Home</Link>
      </div>
    </div>
  )
}
