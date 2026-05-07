import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send, Loader2, BookOpen, Sparkles } from 'lucide-react'
import { streamChat } from './api'

export default function ChatWidget({ studyMaterial }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('general') // 'tutor' | 'general'
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)
  const abortRef = useRef(null)

  const hasMaterial = studyMaterial && studyMaterial.length >= 100

  // Auto-switch to tutor mode when material first becomes available
  useEffect(() => {
    if (hasMaterial && messages.length === 0) {
      setMode('tutor')
    }
  }, [hasMaterial])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streaming])

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    setError('')
    setInput('')

    const userMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages([...newMessages, { role: 'assistant', content: '' }])
    setStreaming(true)

    abortRef.current = new AbortController()
    try {
      await streamChat({
        messages: newMessages,
        mode,
        context: mode === 'tutor' ? studyMaterial : null,
        signal: abortRef.current.signal,
        onDelta: (delta) => {
          setMessages((prev) => {
            const copy = [...prev]
            copy[copy.length - 1] = {
              role: 'assistant',
              content: copy[copy.length - 1].content + delta,
            }
            return copy
          })
        },
      })
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Chat error')
        setMessages((prev) => prev.slice(0, -1))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const stop = () => {
    if (abortRef.current) abortRef.current.abort()
  }

  const clear = () => {
    if (streaming) stop()
    setMessages([])
    setError('')
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const switchMode = (newMode) => {
    if (newMode === mode || streaming) return
    setMode(newMode)
    setMessages([])
    setError('')
  }

  return (
    <>
      {/* Floating bubble */}
      {!open && (
        <button
          className="chat-bubble"
          onClick={() => setOpen(true)}
          aria-label="Open chat"
        >
          <MessageCircle size={26} />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="chat-panel">
          <div className="chat-header">
            <div className="chat-title">
              <MessageCircle size={18} />
              <span>AI Assistant</span>
            </div>
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="chat-mode-toggle">
            <button
              className={`mode-btn ${mode === 'tutor' ? 'active' : ''}`}
              onClick={() => switchMode('tutor')}
              disabled={!hasMaterial}
              title={!hasMaterial ? 'Load study material first' : 'Tutor mode uses your material'}
            >
              <BookOpen size={14} /> Tutor
            </button>
            <button
              className={`mode-btn ${mode === 'general' ? 'active' : ''}`}
              onClick={() => switchMode('general')}
            >
              <Sparkles size={14} /> General
            </button>
          </div>

          <div className="chat-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="chat-empty">
                {mode === 'tutor' ? (
                  hasMaterial ? (
                    <>
                      <strong>Tutor mode</strong>
                      <p>Ask anything about your study material:</p>
                      <ul>
                        <li>"Explain this in simpler terms"</li>
                        <li>"Give me 3 example questions"</li>
                        <li>"What's the main idea?"</li>
                      </ul>
                    </>
                  ) : (
                    <p>Load study material above to use tutor mode.</p>
                  )
                ) : (
                  <>
                    <strong>General assistant</strong>
                    <p>Ask me anything!</p>
                  </>
                )}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                <div className="chat-msg-bubble">
                  {m.content || (streaming && i === messages.length - 1 ? <Loader2 size={14} className="spinner" /> : '')}
                </div>
              </div>
            ))}

            {error && <div className="chat-error">⚠️ {error}</div>}
          </div>

          <div className="chat-input-row">
            <textarea
              className="chat-input"
              placeholder={mode === 'tutor' ? 'Ask about your material...' : 'Ask me anything...'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              disabled={streaming}
            />
            {streaming ? (
              <button className="chat-send stop" onClick={stop} aria-label="Stop">
                <X size={18} />
              </button>
            ) : (
              <button
                className="chat-send"
                onClick={send}
                disabled={!input.trim()}
                aria-label="Send"
              >
                <Send size={18} />
              </button>
            )}
          </div>

          {messages.length > 0 && (
            <button className="chat-clear" onClick={clear}>Clear chat</button>
          )}
        </div>
      )}
    </>
  )
}
