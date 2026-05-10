# 🧠 Drilearn

> AI-powered study companion that turns any source material into quizzes, flashcards, and study notes — with a full classroom system for teachers including live Kahoot-style quiz mode.

[![Live Demo](https://img.shields.io/badge/Demo-Live-7c3aed?style=for-the-badge)](https://drilearn.vercel.app)
[![FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/Frontend-React-61dafb?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Azure OpenAI](https://img.shields.io/badge/AI-Azure_OpenAI-0078d4?style=for-the-badge&logo=microsoft-azure&logoColor=white)](https://azure.microsoft.com/en-us/products/ai-services/openai-service)

---

## ✨ What it does

Drilearn takes your study material — pasted text, PDFs, or YouTube transcripts — and uses AI to generate quizzes, flashcards, and study notes that are **grounded in your source** (no hallucinations: every answer cites the exact passage that justifies it).

Beyond solo studying, Drilearn includes a full classroom system: teachers create classes, push assignments, view per-student analytics, export gradebooks as CSV, and run live Kahoot-style quizzes with real-time leaderboards.

---

## 🎯 Features

### For students
- 📝 **Multi-source quizzes** — combine text, PDFs, and YouTube transcripts into one quiz
- 🎴 **Flashcards mode** with the SM-2 spaced repetition algorithm
- 📜 **AI-generated study notes** in summary or full study guide format
- 💬 **AI tutor chat** that knows your study material
- 🎯 **Concept extraction** — preview the main concepts before generating, choose what to focus on
- 💡 **"Explain like I'm 5"** button on every wrong answer
- 🎉 **Confetti** on high scores
- 🏆 **Public leaderboards** for shared quizzes (anonymous animal names by default)
- ⏱️ **Time limits** with auto-submit countdown timer

### For teachers
- 🔐 **Teacher authentication** (email + password, sessions stored as bearer tokens)
- 🏫 **Class management** with custom colors, icons, and 6-character join codes
- 📋 **Assignments** with due dates pushed to specific classes
- 📊 **Per-assignment analytics** — class average, top score, ranked submissions
- 📥 **CSV export** for individual assignments or full class gradebook
- 📢 **Class announcements** posted by the teacher
- 🤖 **AI feedback on short answers** with partial credit (full / partial / none)
- ⚡ **Live quiz mode** — Kahoot-style real-time game with speed-bonus scoring

### Quiz creation
- 🪄 **AI generation** with PDF / text / YouTube input + optional concept focus
- ✏️ **Manual builder** with full edit control (MC, T/F, short answer)
- 💡 **AI assist in manual mode** — type a topic, AI suggests a question you can edit

### Polish
- 🌗 **Light & dark mode** toggle (saved per browser)
- 📱 **Fully responsive** — mobile drawer nav, optimized touch targets
- 🎨 **Animated UI** — smooth transitions, gradient accents, custom branding

---

## 🛠️ Tech stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18 + Vite + React Router 6 |
| **Backend** | FastAPI (Python 3.12) |
| **AI** | Azure OpenAI (gpt-4o-mini) |
| **Database** | SQLite (dev), Postgres-ready |
| **Auth** | Salted SHA-256 password hashes + bearer-token sessions |
| **PDF parsing** | PyMuPDF (fitz) |
| **YouTube transcripts** | youtube-transcript-api with optional Webshare residential proxy |
| **Hosting** | Render (backend) + Vercel (frontend) |
| **Icons** | Lucide React |
| **Styling** | Hand-crafted CSS with CSS custom properties (no framework) |

---

## 🏗️ Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌──────────────────┐
│                 │         │                 │         │                  │
│  React (Vite)   │ ◄─────► │  FastAPI        │ ◄─────► │  Azure OpenAI    │
│  Vercel         │  HTTPS  │  Render         │  HTTPS  │  (gpt-4o-mini)   │
│                 │         │                 │         │                  │
└────────┬────────┘         └────────┬────────┘         └──────────────────┘
         │                           │
         │                           ▼
         │                  ┌─────────────────┐
         │                  │    SQLite       │
         │                  │    (10 tables)  │
         │                  └─────────────────┘
         │
         └─► localStorage: theme, auth token, flashcard SM-2 progress
```

### Why these choices

- **FastAPI** — async-friendly, automatic OpenAPI docs, Pydantic validation built in
- **SQLite over Postgres** — zero setup, perfect for a class project; idempotent ALTER TABLE migrations on boot
- **Polling over WebSockets for live mode** — simpler stack, ships in one zip, still feels real-time at 1.5s intervals
- **Source-grounded prompts** — every quiz question prompt requires a `source_chunk` citation so the AI can't invent answers
- **Bearer tokens not JWT** — simpler implementation, server-side revocable, sufficient for a single-server deployment

---

## 🚀 Getting started

### Prerequisites
- Python 3.12 (3.14 doesn't work — PyMuPDF wheels not yet released)
- Node.js 18+
- An Azure OpenAI deployment of `gpt-4o-mini` (Azure for Students gives you $100 free)

### 1. Clone and set up

```bash
git clone https://github.com/your-username/drilearn
cd drilearn
```

### 2. Backend

```bash
cd backend
python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` file in `backend/`:

```bash
AZURE_OPENAI_API_KEY=your-key-here
AZURE_OPENAI_ENDPOINT=https://your-resource.services.ai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
AZURE_OPENAI_API_VERSION=2024-10-21
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:5175

# Optional: for YouTube transcript fetching from cloud servers
WEBSHARE_PROXY_USERNAME=your-username
WEBSHARE_PROXY_PASSWORD=your-password
```

Run it:

```bash
uvicorn main:app --reload --port 8000
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — done.

---

## 📁 Project structure

```
drilearn/
├── backend/
│   ├── main.py              # All FastAPI routes, models, AI prompts
│   ├── requirements.txt
│   ├── .env                 # Secrets (gitignored)
│   └── quizzes.db           # SQLite (auto-created)
│
└── frontend/
    ├── index.html           # Theme bootstrap script
    ├── package.json
    ├── vercel.json          # SPA rewrite for client-side routing
    └── src/
        ├── App.jsx          # Routes
        ├── main.jsx         # Entry point
        ├── api.js           # All HTTP calls + auth helpers
        ├── styles.css       # All styling (CSS custom properties)
        ├── ChatWidget.jsx   # Floating AI tutor
        ├── components/
        │   ├── Navbar.jsx
        │   ├── ThemeToggle.jsx
        │   ├── RequireAuth.jsx
        │   └── ManualQuizBuilder.jsx
        └── pages/
            ├── Landing.jsx
            ├── CreateQuiz.jsx
            ├── PublicQuiz.jsx
            ├── Flashcards.jsx
            ├── StudyNotes.jsx
            ├── History.jsx
            ├── SignIn.jsx
            ├── JoinClass.jsx
            ├── StudentClass.jsx
            ├── AssignmentTake.jsx
            ├── teacher/
            │   ├── TeacherDashboard.jsx
            │   ├── ClassDetail.jsx
            │   └── AssignmentAnalytics.jsx
            └── live/
                ├── LiveHost.jsx
                ├── LiveJoin.jsx
                └── LivePlay.jsx
```

---

## 🗄️ Database schema

10 tables, all created on boot via idempotent `CREATE TABLE IF NOT EXISTS`:

| Table | Purpose |
|-------|---------|
| `quizzes` | Generated and manual quizzes (with questions as JSON) |
| `flashcard_sets` | Flashcard decks (cards as JSON) |
| `study_notes` | AI-generated study notes (Markdown) |
| `leaderboard` | All quiz submissions (also class-scoped via `class_id` / `assignment_id`) |
| `teachers` | Teacher accounts (email + hashed password) |
| `sessions` | Bearer token → teacher mapping |
| `classes` | Teacher-owned classrooms |
| `class_memberships` | Students who joined a class |
| `assignments` | Quizzes pushed to a class with optional due date |
| `class_announcements` | Teacher messages to a class |
| `live_sessions` + `live_players` + `live_answers` | Real-time game state |

---

## 🔌 API overview

The full FastAPI auto-generated docs are at `/docs` when running locally. Highlights:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/generate-quiz` | POST | Generate AI quiz from text |
| `/api/quiz/manual` | POST | Save a manually-built quiz |
| `/api/extract-concepts` | POST | Extract main concepts from material |
| `/api/upload-pdf` | POST | Parse PDF and return text |
| `/api/youtube` | POST | Fetch YouTube transcript (uses proxy) |
| `/api/youtube-paste` | POST | Process pasted YouTube transcript |
| `/api/flashcards/generate-from-text` | POST | Generate flashcards from material |
| `/api/notes/generate` | POST | Generate study notes |
| `/api/chat` | POST | Stream tutor chat (SSE) |
| `/api/eli5` | POST | Stream simpler explanation (SSE) |
| `/api/grade-short-answer` | POST | AI partial-credit grading |
| `/api/auth/signup` | POST | Create teacher account |
| `/api/auth/signin` | POST | Sign in, return bearer token |
| `/api/classes` | GET/POST | List or create classes (teacher only) |
| `/api/classes/join` | POST | Student joins with class code |
| `/api/assignments` | POST | Push a quiz to a class |
| `/api/assignments/{id}/analytics` | GET | Per-assignment performance |
| `/api/live/create` | POST | Start a live quiz session |
| `/api/live/join` | POST | Student joins by code |
| `/api/live/{id}/state` | GET | Polled by host + students |
| `/api/live/{id}/start` / `/reveal` / `/next` | POST | Host controls |

---

## 🤖 AI prompt strategy

Drilearn uses Azure OpenAI for several distinct tasks, each with a tailored prompt:

1. **Quiz generation** — strict JSON schema response, requires `source_chunk` citation per question, language-matching, type filtering with auto-retry
2. **Concept extraction** — JSON object listing 5–8 named concepts with descriptions
3. **Flashcards** — JSON cards (term/definition or Q&A format)
4. **Study notes** — free-form Markdown, separate prompts for "summary" vs "study guide" formats
5. **Tutor chat** — streaming SSE, system prompt includes user's study material as context
6. **ELI5** — streaming, takes existing question + answer + explanation, generates a simpler version
7. **Short answer grading** — JSON `{score: 0/0.5/1.0, feedback}` with bias toward partial credit
8. **Question suggestion** — for manual mode, generates one question matching the requested type

All prompts emphasize: stay grounded in source, match user's language, return valid JSON only.

---

## ⚡ Live quiz mode

A Kahoot-style real-time multiplayer game built without WebSockets:

1. Teacher launches a session from any quiz → gets a 6-char code (no confusing chars: no I/O/0/1)
2. Students go to `/live`, enter code + name, land in a **lobby** that polls every 1.5s
3. Teacher sees players appearing in real time, hits **Start**
4. Each question is shown to all players simultaneously
5. Students tap an answer → **speed bonus**: faster = more points (1000 base + up to 1000 bonus, decaying linearly over 30s)
6. Teacher hits **Reveal** → everyone sees the correct answer + answer distribution
7. Teacher hits **Next** → repeat until last question
8. Final podium screen with top 3 + confetti for winners

State machine: `lobby` → `question` → `reveal` → `question` → ... → `finished`.

---

## 🎨 Design system

- **Brand colors:** Deep purple `#7c3aed` accent, animated gradient on hero text
- **Typography:** Space Grotesk (display), Inter (body), JetBrains Mono (code/timestamps)
- **Component style:** Dark by default with warm purple aurora background, light mode tuned for AA contrast
- **Animations:** Page fade-up, hero gradient flow, button shimmer, chat bubble pulse, score number spring, confetti on success
- **No CSS framework** — all styling is hand-written CSS with custom properties for theming

---

## 🐛 Known limitations

- **SQLite on Render free tier resets on every redeploy** — shared quiz links eventually 404. Production would migrate to Postgres (Neon free tier).
- **YouTube auto-fetch is blocked from cloud server IPs** by YouTube's bot detection. Drilearn works around this with (a) a "paste transcript" fallback that always works, and (b) optional Webshare residential proxy support for ~$1.40/mo.
- **Live mode polls every 1.5s** rather than using WebSockets. Trade-off: simpler stack vs slight latency. For a real classroom this is invisible.
- **Per-question analytics** show difficulty + correct answer but not actual correct rates per question (would require storing individual answers, not just aggregate scores).
- **Rate limits are in-memory** so they reset on server restart and don't span multiple instances.

---

## 🔮 Roadmap

If continued, the highest-impact additions would be:

- **Postgres migration** (fixes data persistence on redeploys)
- **Per-question correct rate analytics** (store individual answers, surface which questions are too hard)
- **Quiz editing** (edit individual questions or regenerate one specific question)
- **Streaming quiz generation** (perceived faster — show questions as they generate)
- **Tests + GitHub Actions CI**
- **Adaptive difficulty** (auto-calibrate question difficulty from student performance)
- **Audio file upload** (Whisper transcription)

---

## 📄 License

MIT — feel free to fork, learn, or build on this.

---

## 🙏 Acknowledgements

- Built with [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service)
- Icons by [Lucide](https://lucide.dev)
- Confetti by [canvas-confetti](https://github.com/catdad/canvas-confetti)
- Spaced repetition based on the [SuperMemo SM-2 algorithm](https://en.wikipedia.org/wiki/SuperMemo)

---

## 👤 Author

Built by Drilon Rexhepi as a university project, May 2026.

If you found this useful, ⭐ the repo!
