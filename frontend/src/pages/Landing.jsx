import { Link } from 'react-router-dom'
import {
  Sparkles, FileText, MessageCircle, Mic, Clock, BookOpen, ArrowRight,
} from 'lucide-react'

export default function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <h1 className="hero-title">
          Turn anything into a <span className="gradient-text">quiz</span>
        </h1>
        <p className="hero-subtitle">
          Paste your notes, upload a PDF, drop a YouTube link, or record a lecture.
          Drilearn generates quizzes, flashcards and study notes in seconds — with
          explanations grounded in your own material.
        </p>
        <div className="hero-cta">
          <Link to="/start" className="btn btn-large">
            Get started <ArrowRight size={18} />
          </Link>
          <Link to="/history" className="btn btn-secondary btn-large">
            Past quizzes
          </Link>
        </div>
        <div className="hero-meta">No signup needed to study on your own · Free to use</div>
      </section>

      <section className="features">
        <h2 className="section-title">What it does</h2>
        <div className="feature-grid">
          <FeatureCard
            icon={<FileText size={20} />}
            title="Multiple sources"
            text="Text, PDF, YouTube transcripts, or recorded audio — combined into one study set."
          />
          <FeatureCard
            icon={<Sparkles size={20} />}
            title="Source-grounded"
            text="Every question cites the passage that justifies its answer, reducing hallucinations."
          />
          <FeatureCard
            icon={<Mic size={20} />}
            title="Audio transcription"
            text="Record or upload a lecture and turn the transcript into study material automatically."
          />
          <FeatureCard
            icon={<MessageCircle size={20} />}
            title="AI tutor"
            text="Ask follow-up questions about your material and get answers in context."
          />
          <FeatureCard
            icon={<Clock size={20} />}
            title="Spaced repetition"
            text="Flashcards scheduled with the SuperMemo-2 algorithm for long-term retention."
          />
          <FeatureCard
            icon={<BookOpen size={20} />}
            title="Classroom analytics"
            text="Teachers see per-question accuracy and which concepts a class is struggling with."
          />
        </div>
      </section>

      <section className="how-it-works">
        <h2 className="section-title">How it works</h2>
        <div className="steps">
          <Step n="1" title="Add your material" text="Paste notes, upload a PDF, use a YouTube link, or record a lecture." />
          <Step n="2" title="Choose your settings" text="Question count, difficulty, question types, and optional time limit." />
          <Step n="3" title="Study and review" text="Instant scoring with explanations, plus flashcards and summary notes." />
        </div>
      </section>

      <footer className="footer">
        <p>Drilearn · React, FastAPI, PostgreSQL and Azure OpenAI</p>
      </footer>

      <style>{`
        .landing .hero { padding-top: 3.5rem; padding-bottom: 2.5rem; }
        .landing .features { padding: 2rem 0; }
        .landing .how-it-works { padding: 2rem 0 2.5rem; }
        .landing .footer { padding: 1.5rem 0 2.5rem; opacity: 0.55; font-size: 0.85rem; }
        @media (max-width: 640px) {
          .landing .hero { padding-top: 2.25rem; padding-bottom: 1.75rem; }
        }
      `}</style>
    </div>
  )
}

function FeatureCard({ icon, title, text }) {
  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    e.currentTarget.style.setProperty('--mx', `${x}%`)
    e.currentTarget.style.setProperty('--my', `${y}%`)
  }

  return (
    <div className="feature-card" onMouseMove={handleMouseMove}>
      <div className="feature-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  )
}

function Step({ n, title, text }) {
  return (
    <div className="step">
      <div className="step-number">{n}</div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  )
}
