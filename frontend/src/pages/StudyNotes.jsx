import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Loader2, ArrowLeft, ScrollText, Download, Printer, Copy, Check,
} from 'lucide-react'
import { getNote } from '../api'

/* Tiny safe Markdown renderer - covers headings, bold, italic, lists, code, blockquotes */
function renderMarkdown(md) {
  if (!md) return ''
  // Escape HTML first
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const lines = html.split('\n')
  const out = []
  let inList = false
  let listType = null
  let inCode = false

  const closeList = () => {
    if (inList) {
      out.push(listType === 'ol' ? '</ol>' : '</ul>')
      inList = false
      listType = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trim().startsWith('```')) {
      if (inCode) { out.push('</code></pre>'); inCode = false }
      else { closeList(); out.push('<pre><code>'); inCode = true }
      continue
    }
    if (inCode) { out.push(line); continue }

    if (/^#{1,6}\s/.test(line)) {
      closeList()
      const level = line.match(/^(#+)\s/)[1].length
      const text = inline(line.replace(/^#+\s/, ''))
      out.push(`<h${level}>${text}</h${level}>`)
      continue
    }

    const ulMatch = line.match(/^(\s*)[-*]\s(.+)$/)
    const olMatch = line.match(/^(\s*)\d+\.\s(.+)$/)
    if (ulMatch || olMatch) {
      const newType = ulMatch ? 'ul' : 'ol'
      if (!inList || listType !== newType) {
        closeList()
        out.push(newType === 'ol' ? '<ol>' : '<ul>')
        inList = true
        listType = newType
      }
      const text = inline((ulMatch || olMatch)[2])
      out.push(`<li>${text}</li>`)
      continue
    } else if (inList && line.trim() === '') {
      // Continue list across blank lines? simpler: close it
      closeList()
    }

    if (line.trim().startsWith('&gt;')) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`)
      continue
    }

    if (line.trim() === '') {
      closeList()
      out.push('')
      continue
    }

    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  if (inCode) out.push('</code></pre>')
  return out.join('\n')

  function inline(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  }
}

export default function StudyNotes() {
  const { noteId } = useParams()
  const [note, setNote] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        setNote(await getNote(noteId))
      } catch (err) {
        setError(err.response?.data?.detail || 'Note not found.')
      } finally {
        setLoading(false)
      }
    })()
  }, [noteId])

  const downloadMd = () => {
    if (!note) return
    const blob = new Blob([note.content_md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${note.title.replace(/[^a-z0-9]+/gi, '_')}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const copyToClipboard = async () => {
    if (!note) return
    try {
      await navigator.clipboard.writeText(note.content_md)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (_) {}
  }

  const print = () => window.print()

  if (loading) {
    return (
      <div className="container">
        <div className="card center-text">
          <Loader2 size={24} className="spinner" />
          <p>Loading notes...</p>
        </div>
      </div>
    )
  }

  if (error || !note) {
    return (
      <div className="container">
        <div className="alert alert-error">⚠️ {error || 'Note not found'}</div>
        <Link to="/" className="btn btn-secondary"><ArrowLeft size={16} /> Back</Link>
      </div>
    )
  }

  return (
    <div className="container">
      <div className="card no-print">
        <h2><ScrollText size={20} /> {note.title}</h2>
        <div className="text-info">
          {note.format === 'guide' ? 'Study guide' : 'Quick summary'} · Generated {new Date(note.created_at).toLocaleDateString()}
        </div>
        <div className="button-row" style={{ marginTop: '0.85rem' }}>
          <button className="btn btn-secondary btn-small" onClick={copyToClipboard}>
            {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
          </button>
          <button className="btn btn-secondary btn-small" onClick={downloadMd}>
            <Download size={14} /> Download .md
          </button>
          <button className="btn btn-secondary btn-small" onClick={print}>
            <Printer size={14} /> Print / PDF
          </button>
        </div>
      </div>

      <article className="notes-article" dangerouslySetInnerHTML={{ __html: renderMarkdown(note.content_md) }} />

      <div className="button-row no-print" style={{ marginTop: '2rem' }}>
        <Link to="/app" className="btn">Create another</Link>
        <Link to="/history" className="btn btn-secondary">All my study materials</Link>
      </div>
    </div>
  )
}
