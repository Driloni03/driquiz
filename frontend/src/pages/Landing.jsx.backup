import { Link } from 'react-router-dom'
import { Sparkles, FileText, MessageCircle, Video, Clock, BookOpen, ArrowRight, Brain } from 'lucide-react'

export default function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-badge">
          <Sparkles size={14} /> Powered by Driloni
        </div>
        <h1 className="hero-title">
          Turn anything into a <span className="gradient-text">quiz</span>
        </h1>
        <p className="hero-subtitle">
          Paste your notes, upload a PDF, or drop a YouTube link.
          Drilearn generates a quiz in seconds — with explanations, source citations, and clickable timestamps.
        </p>
        <div className="hero-cta">
          <Link to="/app" className="btn btn-large">
            Try It Free <ArrowRight size={18} />
          </Link>
          <Link to="/history" className="btn btn-secondary btn-large">
            See Past Quizzes
          </Link>
        </div>
        <div className="hero-meta">No signup needed · Free to try · Built for students</div>
      </section>

      <section className="features">
        <h2 className="section-title">Everything you need to study smarter</h2>
        <div className="feature-grid">
          <FeatureCard
            icon={<FileText size={22} />}
            title="Multiple sources"
            text="Paste raw text, upload a PDF, or use a YouTube transcript. Mix and match for any subject."
          />
          <FeatureCard
            icon={<Sparkles size={22} />}
            title="Source-grounded answers"
            text="Every question cites the exact passage that justifies the answer. No AI hallucinations."
          />
          <FeatureCard
            icon={<MessageCircle size={22} />}
            title="AI tutor chat"
            text="Stuck on a concept? Open the chatbot and ask. It already knows your study material."
          />
          <FeatureCard
            icon={<Video size={22} />}
            title="YouTube timestamps"
            text="Each question links back to the exact second in the video where the answer is explained."
          />
          <FeatureCard
            icon={<Clock size={22} />}
            title="Instant scoring"
            text="Submit and see your score plus per-question feedback with full explanations."
          />
          <FeatureCard
            icon={<BookOpen size={22} />}
            title="Quiz history"
            text="Every quiz is saved. Retake them anytime, share them with classmates via a link."
          />
        </div>
      </section>

      <section className="how-it-works">
        <h2 className="section-title">How it works</h2>
        <div className="steps">
          <Step n="1" title="Add your material" text="Paste lecture notes, upload a PDF, or grab a YouTube transcript." />
          <Step n="2" title="Pick your settings" text="Choose number of questions, difficulty, and question types." />
          <Step n="3" title="Take the quiz" text="Get instant scoring with explanations grounded in your source." />
        </div>
      </section>

      <section className="cta-bottom">
        <h2>Ready to study?</h2>
        <p>Generate your first quiz in under a minute.</p>
        <Link to="/app" className="btn btn-large">
          Get Started <ArrowRight size={18} />
        </Link>
      </section>

      <footer className="footer">
        <p>Drilearn · Built with FastAPI, React, and Azure OpenAI</p>
      </footer>
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
