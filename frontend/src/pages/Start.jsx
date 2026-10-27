import { Link } from 'react-router-dom'
import { GraduationCap, Users, Rocket, ArrowRight, ArrowLeft, Check } from 'lucide-react'

const ROLES = [
  {
    key: 'teacher',
    icon: <GraduationCap size={24} />,
    title: 'I teach a class',
    text: 'Assign quizzes to your students and see which questions they struggle with.',
    points: [
      'Classes with a join code',
      'Quizzes as assignments',
      'Per-question analytics',
      'Live quizzes in class',
    ],
    ctaLabel: 'Sign in as teacher',
    ctaTo: '/signin?next=/teacher',
    secondaryLabel: 'Create a teacher account',
    secondaryTo: '/signin?mode=signup&role=teacher',
    note: 'Free account required',
    primary: true,
  },
  {
    key: 'student',
    icon: <Users size={24} />,
    title: 'I was given a class code',
    text: 'Join your teacher\u2019s class to see assignments and your results.',
    points: [
      'Join with a 6-letter code',
      'Take assigned quizzes',
      'Instant scoring',
      'Results saved if you sign in',
    ],
    ctaLabel: 'Join a class',
    ctaTo: '/join',
    secondaryLabel: 'Create a student account',
    secondaryTo: '/signin?mode=signup&role=student',
  },
  {
    key: 'solo',
    icon: <Rocket size={24} />,
    title: 'I\u2019m studying on my own',
    text: 'Turn your own material into quizzes, flashcards and study notes.',
    points: [
      'Text, PDF, video or audio',
      'Flashcards with spaced repetition',
      'AI-generated study notes',
      'Account optional',
    ],
    ctaLabel: 'Start studying',
    ctaTo: '/app',
    secondaryLabel: 'Sign up to save progress',
    secondaryTo: '/signin?mode=signup&role=student',
  },
]

export default function Start() {
  return (
    <div className="container start-page">
      <Link to="/" className="back-link"><ArrowLeft size={14} /> Home</Link>

      <div className="start-header">
        <h1>How will you use Drilearn?</h1>
        <p>Choose the option that fits you. You can switch at any time.</p>
      </div>

      <div className="start-grid">
        {ROLES.map((r) => (
          <div key={r.key} className={`start-card ${r.primary ? 'is-primary' : ''}`}>
            <div className="start-icon">{r.icon}</div>
            <h2>{r.title}</h2>
            <p className="start-card-text">{r.text}</p>
            <ul className="start-points">
              {r.points.map((p) => (
                <li key={p}><Check size={13} strokeWidth={3} /><span>{p}</span></li>
              ))}
            </ul>
            <div className="start-cta">
              <Link to={r.ctaTo} className={`btn btn-block ${r.primary ? '' : 'btn-secondary'}`}>
                {r.ctaLabel} <ArrowRight size={15} />
              </Link>
              {r.secondaryTo && (
                <Link to={r.secondaryTo} className="start-secondary">{r.secondaryLabel}</Link>
              )}
              {r.note && <p className="start-note">{r.note}</p>}
            </div>
          </div>
        ))}
      </div>

      <style>{`
        .start-page { max-width: 1040px; padding-bottom: 3rem; }
        .start-header { text-align: center; margin: 1.5rem 0 2.25rem; }
        .start-header h1 { margin: 0 0 0.5rem; font-size: 1.9rem; letter-spacing: -0.01em; }
        .start-header p { margin: 0; opacity: 0.65; font-size: 0.95rem; }

        .start-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1.1rem;
          align-items: stretch;
        }

        .start-card {
          display: flex;
          flex-direction: column;
          padding: 1.6rem 1.4rem 1.3rem;
          border-radius: 14px;
          border: 1px solid var(--border, rgba(124, 58, 237, 0.18));
          background: var(--surface-2, rgba(124, 58, 237, 0.035));
          transition: transform 0.2s ease, border-color 0.2s ease;
        }
        .start-card:hover {
          transform: translateY(-3px);
          border-color: rgba(124, 58, 237, 0.45);
        }
        .start-card.is-primary { border-color: rgba(124, 58, 237, 0.45); }

        .start-icon {
          width: 46px; height: 46px; border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(124, 58, 237, 0.14);
          color: #a855f7;
          margin-bottom: 0.9rem;
        }
        .start-card h2 { margin: 0 0 0.4rem; font-size: 1.05rem; }
        .start-card-text { margin: 0 0 0.9rem; opacity: 0.7; font-size: 0.88rem; line-height: 1.5; }

        .start-points {
          list-style: none; padding: 0; margin: 0 0 1.3rem;
          display: flex; flex-direction: column; gap: 0.38rem; font-size: 0.84rem;
        }
        .start-points li { display: flex; align-items: flex-start; gap: 0.45rem; opacity: 0.8; }
        .start-points svg { flex: 0 0 auto; margin-top: 2px; color: #10b981; }

        .start-cta { margin-top: auto; }
        .start-secondary { display: block; margin-top: 0.6rem; text-align: center; font-size: 0.82rem; color: #a855f7; }
        .start-note { margin: 0.55rem 0 0; text-align: center; font-size: 0.75rem; opacity: 0.5; }

        @media (max-width: 640px) {
          .start-header { margin: 1rem 0 1.5rem; }
          .start-header h1 { font-size: 1.5rem; }
        }
      `}</style>
    </div>
  )
}
