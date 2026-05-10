"""
DriQuiz API - FastAPI backend
v1.4.0: + concept extraction, ELI5, leaderboard, multi-source quizzes
"""
import os
import re
import json
import uuid
import time
import random
import sqlite3
import secrets
import hashlib
from contextlib import contextmanager
from typing import List, Optional, Literal
from datetime import datetime, timedelta
from collections import defaultdict, deque

from fastapi import FastAPI, File, UploadFile, HTTPException, Request, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from openai import AzureOpenAI
import fitz
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="DriQuiz API", version="1.4.0")

ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:3000",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ALLOWED_ORIGINS],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = AzureOpenAI(
    api_key=os.getenv("AZURE_OPENAI_API_KEY"),
    api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21"),
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
)
DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT")

# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------
DB_PATH = os.getenv("DB_PATH", "quizzes.db")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS quizzes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                source_text_preview TEXT,
                source_type TEXT DEFAULT 'text',
                youtube_video_id TEXT,
                questions_json TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS leaderboard (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                quiz_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                score INTEGER NOT NULL,
                total INTEGER NOT NULL,
                percentage REAL NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_leaderboard_quiz ON leaderboard(quiz_id, percentage DESC)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS flashcard_sets (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                source_text_preview TEXT,
                cards_json TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS study_notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                source_text_preview TEXT,
                format TEXT DEFAULT 'summary',
                content_md TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS classes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                code TEXT NOT NULL UNIQUE,
                teacher_name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_classes_code ON classes(code)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS class_memberships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                class_id TEXT NOT NULL,
                student_name TEXT NOT NULL,
                joined_at TEXT NOT NULL,
                FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_membership_class ON class_memberships(class_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS assignments (
                id TEXT PRIMARY KEY,
                class_id TEXT NOT NULL,
                quiz_id TEXT NOT NULL,
                due_at TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
                FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS class_announcements (
                id TEXT PRIMARY KEY,
                class_id TEXT NOT NULL,
                author_name TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_announcements_class ON class_announcements(class_id, created_at DESC)")

        # Add new columns to existing tables (idempotent migrations)
        for sql in [
            "ALTER TABLE classes ADD COLUMN color TEXT DEFAULT '#7c3aed'",
            "ALTER TABLE classes ADD COLUMN icon TEXT DEFAULT 'graduation'",
            "ALTER TABLE quizzes ADD COLUMN time_limit_seconds INTEGER",
            "ALTER TABLE classes ADD COLUMN teacher_id TEXT",  # nullable for legacy
        ]:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError:
                pass

        # Auth tables
        conn.execute("""
            CREATE TABLE IF NOT EXISTS teachers (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_teachers_email ON teachers(email)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                teacher_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
            )
        """)

        # Live session tables (in-memory style but persisted briefly)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS live_sessions (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                quiz_id TEXT NOT NULL,
                teacher_id TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'lobby',
                current_question_index INTEGER DEFAULT -1,
                question_started_at TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (quiz_id) REFERENCES quizzes(id),
                FOREIGN KEY (teacher_id) REFERENCES teachers(id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_live_code ON live_sessions(code)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS live_players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                player_name TEXT NOT NULL,
                joined_at TEXT NOT NULL,
                score INTEGER DEFAULT 0,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_live_players_session ON live_players(session_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS live_answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                player_id INTEGER NOT NULL,
                question_index INTEGER NOT NULL,
                answer TEXT NOT NULL,
                is_correct INTEGER NOT NULL,
                answered_at TEXT NOT NULL,
                points INTEGER DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (player_id) REFERENCES live_players(id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_live_answers ON live_answers(session_id, question_index)")

        # Per user choice: clean start - clear ALL existing classes since they have no owner
        # Only run this once. Use a marker to detect first run after auth.
        try:
            existing_marker = conn.execute("SELECT 1 FROM teachers LIMIT 1").fetchone()
            # If no teacher exists yet, this is first auth-aware boot. Clear old classes.
            if not existing_marker:
                # Only clear if there are classes without teacher_id (legacy data)
                legacy_count = conn.execute(
                    "SELECT COUNT(*) c FROM classes WHERE teacher_id IS NULL"
                ).fetchone()
                if legacy_count and legacy_count["c"] > 0:
                    conn.execute("DELETE FROM assignments WHERE class_id IN (SELECT id FROM classes WHERE teacher_id IS NULL)")
                    conn.execute("DELETE FROM class_memberships WHERE class_id IN (SELECT id FROM classes WHERE teacher_id IS NULL)")
                    conn.execute("DELETE FROM class_announcements WHERE class_id IN (SELECT id FROM classes WHERE teacher_id IS NULL)")
                    conn.execute("DELETE FROM classes WHERE teacher_id IS NULL")
                    print(f"[AUTH] Cleared {legacy_count['c']} legacy classes (no owner) - clean start enabled.")
        except sqlite3.OperationalError:
            pass
        # Add class_id and assignment_id to leaderboard for class-scoped scores
        for sql in [
            "ALTER TABLE leaderboard ADD COLUMN class_id TEXT",
            "ALTER TABLE leaderboard ADD COLUMN assignment_id TEXT",
        ]:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError:
                pass

        # Migrate older DBs
        for sql in [
            "ALTER TABLE quizzes ADD COLUMN source_type TEXT DEFAULT 'text'",
            "ALTER TABLE quizzes ADD COLUMN youtube_video_id TEXT",
        ]:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError:
                pass
        conn.commit()


init_db()


# ===========================================================================
# AUTHENTICATION
# ===========================================================================

def hash_password(password: str) -> str:
    """Salted SHA-256 hash. (bcrypt would be better but sha256 + salt is OK for a class project.)"""
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, expected = stored.split("$", 1)
    except ValueError:
        return False
    actual = hashlib.sha256((salt + password).encode()).hexdigest()
    return secrets.compare_digest(actual, expected)


def create_session(teacher_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    exp = now + timedelta(days=30)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, teacher_id, created_at, expires_at) VALUES (?,?,?,?)",
            (token, teacher_id, now.isoformat(), exp.isoformat()),
        )
        conn.commit()
    return token


def get_teacher_from_token(token: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute(
            """SELECT t.id, t.email, t.name FROM sessions s
               JOIN teachers t ON t.id = s.teacher_id
               WHERE s.token = ? AND s.expires_at > ?""",
            (token, datetime.utcnow().isoformat()),
        ).fetchone()
        return dict(row) if row else None


def require_teacher(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency: return the teacher for a valid token, else 401."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in required.")
    token = authorization.split(None, 1)[1].strip()
    teacher = get_teacher_from_token(token)
    if not teacher:
        raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
    return teacher


def optional_teacher(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    """Returns teacher dict if signed in, else None (for endpoints that work both ways)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(None, 1)[1].strip()
    return get_teacher_from_token(token)


def save_quiz(quiz_dict: dict):
    with get_db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO quizzes
            (id, title, created_at, source_text_preview, source_type, youtube_video_id, questions_json, time_limit_seconds)
            VALUES (?,?,?,?,?,?,?,?)""",
            (
                quiz_dict["id"],
                quiz_dict["title"],
                quiz_dict["created_at"],
                quiz_dict["source_text_preview"],
                quiz_dict.get("source_type", "text"),
                quiz_dict.get("youtube_video_id"),
                json.dumps(quiz_dict["questions"]),
                quiz_dict.get("time_limit_seconds"),
            ),
        )
        conn.commit()


def load_quiz(quiz_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()
        if not row:
            return None
        # Some older rows might not have time_limit_seconds
        try:
            tls = row["time_limit_seconds"]
        except (KeyError, IndexError):
            tls = None
        return {
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "source_text_preview": row["source_text_preview"],
            "source_type": row["source_type"] or "text",
            "youtube_video_id": row["youtube_video_id"],
            "questions": json.loads(row["questions_json"]),
            "time_limit_seconds": tls,
        }


def list_all_quizzes():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, source_type, questions_json FROM quizzes ORDER BY created_at DESC LIMIT 100"
        ).fetchall()
        return [
            {
                "id": r["id"],
                "title": r["title"],
                "created_at": r["created_at"],
                "source_type": r["source_type"] or "text",
                "num_questions": len(json.loads(r["questions_json"])),
            }
            for r in rows
        ]


def save_leaderboard_entry(quiz_id, display_name, score, total, percentage):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO leaderboard (quiz_id, display_name, score, total, percentage, created_at) VALUES (?,?,?,?,?,?)",
            (quiz_id, display_name, score, total, percentage, datetime.utcnow().isoformat()),
        )
        conn.commit()


def get_leaderboard(quiz_id):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT display_name, score, total, percentage, created_at FROM leaderboard WHERE quiz_id = ? ORDER BY percentage DESC, created_at ASC LIMIT 50",
            (quiz_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Random animal names for anonymous leaderboard
# ---------------------------------------------------------------------------
ADJECTIVES = [
    "Brave", "Clever", "Sneaky", "Mighty", "Swift", "Wise", "Curious", "Daring",
    "Gentle", "Loyal", "Bold", "Witty", "Calm", "Bright", "Lucky", "Quick",
    "Sleepy", "Happy", "Fierce", "Quiet", "Sunny", "Rusty", "Smooth", "Wild",
]
ANIMALS = [
    "Otter", "Fox", "Owl", "Wolf", "Bear", "Hawk", "Tiger", "Panda",
    "Lynx", "Falcon", "Raven", "Badger", "Eagle", "Lion", "Cobra", "Penguin",
    "Dolphin", "Koala", "Sloth", "Cheetah", "Heron", "Moose", "Rabbit", "Crane",
]


def random_animal_name() -> str:
    return f"{random.choice(ADJECTIVES)} {random.choice(ANIMALS)}"


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "10"))
RATE_LIMIT_WINDOW_SEC = int(os.getenv("RATE_LIMIT_WINDOW_SEC", "3600"))
CHAT_RATE_LIMIT = int(os.getenv("CHAT_RATE_LIMIT", "30"))
_quiz_log = defaultdict(deque)
_chat_log = defaultdict(deque)


def _check(log, ip, limit, window, label):
    now = time.time()
    while log[ip] and log[ip][0] < now - window:
        log[ip].popleft()
    if len(log[ip]) >= limit:
        retry_in = int(window - (now - log[ip][0]))
        raise HTTPException(
            status_code=429,
            detail=f"{label} rate limit reached. Try again in ~{max(1, retry_in // 60)} min.",
        )
    log[ip].append(now)


def check_quiz_rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    _check(_quiz_log, ip, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SEC, "Quiz")


def check_chat_rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    _check(_chat_log, ip, CHAT_RATE_LIMIT, RATE_LIMIT_WINDOW_SEC, "Chat")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class Question(BaseModel):
    id: str
    type: Literal["multiple_choice", "true_false", "short_answer"]
    question: str
    options: Optional[List[str]] = None
    correct_answer: str
    explanation: str
    source_chunk: str
    difficulty: Literal["easy", "medium", "hard"]
    timestamp_seconds: Optional[int] = None


class Quiz(BaseModel):
    id: str
    title: str
    created_at: str
    questions: List[Question]
    source_text_preview: str
    source_type: str = "text"
    youtube_video_id: Optional[str] = None
    time_limit_seconds: Optional[int] = None


class GenerateRequest(BaseModel):
    text: str
    num_questions: int = Field(default=5, ge=1, le=15)
    difficulty: Literal["easy", "medium", "hard", "mixed"] = "mixed"
    question_types: List[Literal["multiple_choice", "true_false", "short_answer"]] = ["multiple_choice"]
    title: Optional[str] = "Untitled Quiz"
    source_type: Literal["text", "pdf", "youtube", "multi"] = "text"
    youtube_video_id: Optional[str] = None
    focus_concepts: Optional[List[str]] = None
    time_limit_seconds: Optional[int] = Field(default=None, ge=30, le=7200)


class YouTubeRequest(BaseModel):
    url: str


class PastedTranscriptRequest(BaseModel):
    url: str
    transcript: str


class ConceptsRequest(BaseModel):
    text: str = Field(..., min_length=100)


class ELI5Request(BaseModel):
    question: str
    answer: str
    original_explanation: str


class AnswerSubmission(BaseModel):
    question_id: str
    user_answer: str


class SubmitQuizRequest(BaseModel):
    quiz_id: str
    answers: List[AnswerSubmission]


class LeaderboardSubmitRequest(BaseModel):
    quiz_id: str
    answers: List[AnswerSubmission]
    display_name: Optional[str] = None  # if None, generate random animal


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(..., min_length=1, max_length=30)
    mode: Literal["tutor", "general"] = "general"
    context: Optional[str] = None


# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------
YOUTUBE_ID_PATTERNS = [
    r"(?:v=|/v/|youtu\.be/|/embed/|/shorts/)([0-9A-Za-z_-]{11})",
    r"^([0-9A-Za-z_-]{11})$",
]


def extract_youtube_id(url_or_id: str) -> Optional[str]:
    s = url_or_id.strip()
    for pattern in YOUTUBE_ID_PATTERNS:
        match = re.search(pattern, s)
        if match:
            return match.group(1)
    return None


def get_video_title(video_id: str) -> str:
    try:
        import urllib.request
        url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read().decode())
            return data.get("title", f"YouTube video {video_id}")
    except Exception:
        return f"YouTube video {video_id}"


def _build_ytt_client():
    from youtube_transcript_api import YouTubeTranscriptApi
    proxy_user = os.getenv("WEBSHARE_PROXY_USERNAME")
    proxy_pass = os.getenv("WEBSHARE_PROXY_PASSWORD")
    if proxy_user and proxy_pass:
        try:
            from youtube_transcript_api.proxies import WebshareProxyConfig
            return YouTubeTranscriptApi(proxy_config=WebshareProxyConfig(
                proxy_username=proxy_user,
                proxy_password=proxy_pass,
            ))
        except ImportError:
            pass
    return YouTubeTranscriptApi()


def fetch_youtube_transcript(video_id: str) -> tuple[str, list]:
    languages = ["en", "sq", "es", "fr", "de", "it", "sr", "hr", "mk"]
    segments = None
    last_err = None
    try:
        ytt = _build_ytt_client()
        try:
            fetched = ytt.fetch(video_id, languages=languages)
        except Exception:
            fetched = ytt.fetch(video_id)
        try:
            segments = [{"text": s.text, "start": s.start, "duration": s.duration} for s in fetched]
        except Exception:
            segments = fetched.to_raw_data() if hasattr(fetched, "to_raw_data") else None
    except Exception as e:
        last_err = e

    if not segments:
        msg = str(last_err) if last_err else "Unknown error"
        if "TranscriptsDisabled" in msg or "transcripts are disabled" in msg.lower():
            raise HTTPException(status_code=400, detail="This video has transcripts disabled.")
        if "VideoUnavailable" in msg or "unavailable" in msg.lower():
            raise HTTPException(status_code=400, detail="Video unavailable or private.")
        raise HTTPException(status_code=400, detail=f"Could not fetch transcript: {msg}")

    parts, last_marker = [], -999
    for seg in segments:
        start = int(seg["start"])
        if start - last_marker >= 25:
            parts.append(f"[{start}s]")
            last_marker = start
        parts.append(seg["text"].replace("\n", " "))
    return " ".join(parts), segments


def parse_pasted_transcript(raw: str) -> str:
    if not raw or not raw.strip():
        return ""
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    ts_pattern = re.compile(r"^(\d+):(\d{2})(?::(\d{2}))?$")
    parts = []
    has_any_ts = False
    for line in lines:
        m = ts_pattern.match(line)
        if m:
            has_any_ts = True
            groups = m.groups()
            if groups[2] is not None:
                h, mn, s = int(groups[0]), int(groups[1]), int(groups[2])
                current_ts = h * 3600 + mn * 60 + s
            else:
                mn, s = int(groups[0]), int(groups[1])
                current_ts = mn * 60 + s
            parts.append(f"[{current_ts}s]")
        else:
            parts.append(line)
    if not has_any_ts:
        return raw.strip()
    return " ".join(parts)


# ---------------------------------------------------------------------------
# PDF & chunking
# ---------------------------------------------------------------------------
def extract_pdf_text(file_bytes: bytes) -> str:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = [p.get_text("text") for p in doc if p.get_text("text").strip()]
    doc.close()
    return "\n\n".join(pages)


def chunk_text(text: str, max_chars: int = 4000) -> List[str]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks, current = [], ""
    for para in paragraphs:
        if len(current) + len(para) + 2 <= max_chars:
            current += ("\n\n" if current else "") + para
        else:
            if current:
                chunks.append(current)
            if len(para) > max_chars:
                for i in range(0, len(para), max_chars):
                    chunks.append(para[i : i + max_chars])
                current = ""
            else:
                current = para
    if current:
        chunks.append(current)
    return chunks


def chunk_text_for_youtube(text: str, max_chars: int = 4000) -> List[str]:
    words = text.split(" ")
    chunks, current = [], ""
    for word in words:
        if len(current) + len(word) + 1 <= max_chars:
            current += (" " if current else "") + word
        else:
            if current:
                chunks.append(current)
            current = word
    if current:
        chunks.append(current)
    return chunks


# ---------------------------------------------------------------------------
# Concept extraction
# ---------------------------------------------------------------------------
def extract_concepts(text: str) -> List[dict]:
    """Use the LLM to extract 5-8 main concepts from study material."""
    # Use a sample of the text if very long
    sample = text[:8000] if len(text) > 8000 else text

    prompt = f"""Analyze this study material and identify the 5-8 main concepts/topics it covers.

MATERIAL:
\"\"\"
{sample}
\"\"\"

Return ONLY a JSON object in this format:
{{
  "concepts": [
    {{
      "name": "Short topic name (2-5 words)",
      "description": "One-sentence description of what this covers"
    }}
  ]
}}

Identify 5-8 distinct concepts. Use the language of the material."""

    response = client.chat.completions.create(
        model=DEPLOYMENT,
        messages=[
            {"role": "system", "content": "You analyze study material and return valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
        max_tokens=1024,
    )
    raw = response.choices[0].message.content.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not extract concepts.")
    return data.get("concepts", [])


# ---------------------------------------------------------------------------
# Quiz Generation
# ---------------------------------------------------------------------------
QUIZ_PROMPT = """You are an expert at creating educational quiz questions. Generate a quiz from the provided learning material.

LEARNING MATERIAL:
\"\"\"
{content}
\"\"\"

REQUIREMENTS:
- Number of questions: {num_questions}
- Difficulty: {difficulty}
- Allowed question types: {types}
{focus_block}
CRITICAL: Generate ONLY questions of the allowed types listed above. If only "multiple_choice" is allowed, EVERY question must be multiple_choice. If only "true_false" is allowed, EVERY question must be true_false. Do NOT mix in other types under any circumstances.

IMPORTANT INSTRUCTIONS:
1. Questions must be based ONLY on the provided material - do not invent information.
2. Each question must include a "source_chunk" that is a short citation (1-2 sentences) from the material justifying the correct answer.
3. For multiple_choice: provide exactly 4 options, only one correct. "correct_answer" must be the FULL TEXT of the correct option (not just a letter).
4. For true_false: "correct_answer" must be exactly "True" or "False".
5. For short_answer: "correct_answer" must be a short answer (max 10 words).
6. Explanations should be clear and educational.
7. Match the language of the questions to the language of the source material.
{extra_instructions}

Respond with ONLY a valid JSON object in this exact format, with no other text:

{{
  "questions": [
    {{
      "type": "multiple_choice|true_false|short_answer",
      "question": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_answer": "Full text of the correct answer",
      "explanation": "Why this is correct",
      "source_chunk": "Citation from the material",
      "difficulty": "easy|medium|hard"{extra_field_doc}
    }}
  ]
}}

For true_false and short_answer questions, set "options": null.
"""

YOUTUBE_EXTRA_INSTRUCTIONS = """8. The material is a video transcript with [Ns] markers indicating the time in seconds where each part was spoken.
9. For each question, include a "timestamp_seconds" field (integer) with the closest [Ns] marker BEFORE the part that justifies the answer.
10. Do NOT include the [Ns] markers in the source_chunk - clean them out for readability."""

YOUTUBE_EXTRA_FIELD_DOC = ',\n      "timestamp_seconds": 123'


def generate_questions_from_chunk(chunk, num_questions, difficulty, types, is_youtube=False, focus_concepts=None):
    types_str = ", ".join(types)
    focus_block = ""
    if focus_concepts:
        concepts_str = ", ".join(f'"{c}"' for c in focus_concepts)
        focus_block = f"- FOCUS on these concepts: {concepts_str}\n"

    prompt = QUIZ_PROMPT.format(
        content=chunk,
        num_questions=num_questions,
        difficulty=difficulty,
        types=types_str,
        focus_block=focus_block,
        extra_instructions=YOUTUBE_EXTRA_INSTRUCTIONS if is_youtube else "",
        extra_field_doc=YOUTUBE_EXTRA_FIELD_DOC if is_youtube else "",
    )
    response = client.chat.completions.create(
        model=DEPLOYMENT,
        messages=[
            {"role": "system", "content": "You are a helpful assistant that always responds with valid JSON."},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.7,
        max_tokens=4096,
    )
    raw = response.choices[0].message.content.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"LLM returned invalid JSON: {e}")
    return data.get("questions", [])


def _filter_by_types(questions, allowed_types):
    """Drop any questions whose type isn't in the allowed list."""
    allowed = set(allowed_types)
    return [q for q in questions if q.get("type") in allowed]


def build_quiz(text, num_questions, difficulty, types, title, source_type="text",
               youtube_video_id=None, focus_concepts=None, time_limit_seconds=None) -> Quiz:
    is_youtube = source_type == "youtube"
    chunks = chunk_text_for_youtube(text) if is_youtube else chunk_text(text)
    if not chunks:
        raise HTTPException(status_code=400, detail="The material is empty.")
    n_chunks = min(len(chunks), num_questions)
    chunks_to_use = chunks[:n_chunks] if len(chunks) > num_questions else chunks
    per_chunk = max(1, num_questions // len(chunks_to_use))
    remainder = num_questions - per_chunk * len(chunks_to_use)
    all_questions = []
    for i, chunk in enumerate(chunks_to_use):
        n = per_chunk + (1 if i < remainder else 0)
        if n == 0:
            continue
        all_questions.extend(generate_questions_from_chunk(
            chunk, n, difficulty, types,
            is_youtube=is_youtube, focus_concepts=focus_concepts,
        ))

    # Validate: drop any questions of wrong types and retry if needed
    all_questions = _filter_by_types(all_questions, types)
    retries = 0
    while len(all_questions) < num_questions and retries < 2 and chunks_to_use:
        retries += 1
        needed = num_questions - len(all_questions)
        # Use the first chunk for the retry
        retry_qs = generate_questions_from_chunk(
            chunks_to_use[0], needed, difficulty, types,
            is_youtube=is_youtube, focus_concepts=focus_concepts,
        )
        all_questions.extend(_filter_by_types(retry_qs, types))

    all_questions = all_questions[:num_questions]
    if not all_questions:
        raise HTTPException(
            status_code=500,
            detail="Could not generate questions matching your selected types. Try adding more types or a different difficulty.",
        )
    questions_list = []
    for q in all_questions:
        questions_list.append({
            "id": str(uuid.uuid4()),
            "type": q.get("type", "multiple_choice"),
            "question": q.get("question", ""),
            "options": q.get("options"),
            "correct_answer": q.get("correct_answer", ""),
            "explanation": q.get("explanation", ""),
            "source_chunk": q.get("source_chunk", ""),
            "difficulty": q.get("difficulty", "medium"),
            "timestamp_seconds": q.get("timestamp_seconds") if is_youtube else None,
        })

    quiz_dict = {
        "id": str(uuid.uuid4()),
        "title": title,
        "created_at": datetime.utcnow().isoformat(),
        "source_text_preview": text[:300] + ("..." if len(text) > 300 else ""),
        "source_type": source_type,
        "youtube_video_id": youtube_video_id,
        "questions": questions_list,
        "time_limit_seconds": time_limit_seconds,
    }
    save_quiz(quiz_dict)
    return Quiz(**quiz_dict)


# ---------------------------------------------------------------------------
# Chat & ELI5
# ---------------------------------------------------------------------------
TUTOR_SYSTEM_PROMPT = """You are a friendly, patient study tutor. The student has provided study material below. Use it as the primary source for your answers.

When answering:
- Base your answers on the provided material whenever possible
- If the material doesn't cover the question, you can use general knowledge but say so clearly
- Explain concepts simply, with examples when helpful
- Keep answers focused and not overly long
- If the student's question is unclear, ask a quick clarifying question
- Match the language of your responses to the language the student uses
- If the material contains [Ns] markers (these are video timestamps in seconds), you may reference them when helpful, e.g. "around 2:30 in the video"

STUDY MATERIAL:
\"\"\"
{material}
\"\"\""""

GENERAL_SYSTEM_PROMPT = """You are a helpful, friendly assistant. Answer the user's questions clearly and concisely. Match the language they use."""


def build_chat_messages(req: ChatRequest):
    if req.mode == "tutor":
        material = (req.context or "").strip()
        if not material:
            raise HTTPException(status_code=400, detail="Tutor mode requires study material.")
        if len(material) > 25000:
            material = material[:25000] + "\n\n[truncated]"
        system = TUTOR_SYSTEM_PROMPT.format(material=material)
    else:
        system = GENERAL_SYSTEM_PROMPT
    messages = [{"role": "system", "content": system}]
    for m in req.messages:
        messages.append({"role": m.role, "content": m.content})
    return messages


def stream_chat(messages):
    try:
        stream = client.chat.completions.create(
            model=DEPLOYMENT,
            messages=messages,
            temperature=0.7,
            max_tokens=1024,
            stream=True,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta and delta.content:
                payload = json.dumps({"delta": delta.content})
                yield f"data: {payload}\n\n"
        yield "data: [DONE]\n\n"
    except Exception as e:
        err = json.dumps({"error": str(e)})
        yield f"data: {err}\n\n"
        yield "data: [DONE]\n\n"


def stream_eli5(question, answer, original_explanation):
    """Stream a simpler explanation."""
    prompt = f"""A student got this question:

Q: {question}
A: {answer}

The original explanation was: "{original_explanation}"

Re-explain this in extremely simple terms, like you're talking to a 10-year-old. Use a short analogy or everyday example. Keep it under 4 sentences. Match the language of the original."""

    try:
        stream = client.chat.completions.create(
            model=DEPLOYMENT,
            messages=[
                {"role": "system", "content": "You explain things simply and clearly."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_tokens=400,
            stream=True,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta and delta.content:
                payload = json.dumps({"delta": delta.content})
                yield f"data: {payload}\n\n"
        yield "data: [DONE]\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def root():
    return {"status": "ok", "service": "DriQuiz API", "version": "1.4.0"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed.")
    contents = await file.read()
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF too large (max 10 MB).")
    try:
        text = extract_pdf_text(contents)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {e}")
    if not text.strip():
        raise HTTPException(status_code=400, detail="PDF contains no readable text.")
    return {"text": text, "char_count": len(text), "filename": file.filename}


@app.post("/api/youtube")
def youtube_to_text(req: YouTubeRequest):
    video_id = extract_youtube_id(req.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL.")
    text, _ = fetch_youtube_transcript(video_id)
    if not text.strip():
        raise HTTPException(status_code=400, detail="Transcript is empty.")
    title = get_video_title(video_id)
    return {"video_id": video_id, "title": title, "text": text, "char_count": len(text)}


@app.post("/api/youtube-paste")
def youtube_paste(req: PastedTranscriptRequest):
    video_id = extract_youtube_id(req.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL.")
    text = parse_pasted_transcript(req.transcript)
    if not text or len(text) < 50:
        raise HTTPException(status_code=400, detail="Transcript text is too short.")
    title = get_video_title(video_id)
    return {"video_id": video_id, "title": title, "text": text, "char_count": len(text)}


@app.post("/api/extract-concepts")
def api_extract_concepts(req: ConceptsRequest, request: Request):
    check_quiz_rate_limit(request)
    if len(req.text) > 50000:
        raise HTTPException(status_code=400, detail="Text too long (max 50,000 chars).")
    concepts = extract_concepts(req.text)
    return {"concepts": concepts}


@app.post("/api/generate-quiz", response_model=Quiz)
def generate_quiz(req: GenerateRequest, request: Request):
    check_quiz_rate_limit(request)
    if not req.text.strip() or len(req.text) < 100:
        raise HTTPException(status_code=400, detail="Text too short (min 100 chars).")
    if len(req.text) > 50000:
        raise HTTPException(status_code=400, detail="Text too long (max 50,000 chars).")
    return build_quiz(
        text=req.text,
        num_questions=req.num_questions,
        difficulty=req.difficulty,
        types=req.question_types,
        title=req.title or "Untitled Quiz",
        source_type=req.source_type,
        youtube_video_id=req.youtube_video_id,
        focus_concepts=req.focus_concepts,
        time_limit_seconds=req.time_limit_seconds,
    )


@app.get("/api/quiz/{quiz_id}", response_model=Quiz)
def get_quiz(quiz_id: str):
    quiz = load_quiz(quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    return Quiz(**quiz)


@app.get("/api/quiz/{quiz_id}/public")
def get_public_quiz(quiz_id: str):
    quiz = load_quiz(quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    public_questions = []
    for q in quiz["questions"]:
        public_questions.append({
            "id": q["id"],
            "type": q["type"],
            "question": q["question"],
            "options": q.get("options"),
            "difficulty": q.get("difficulty", "medium"),
            "timestamp_seconds": q.get("timestamp_seconds"),
        })
    return {
        "id": quiz["id"],
        "title": quiz["title"],
        "created_at": quiz["created_at"],
        "source_text_preview": quiz["source_text_preview"],
        "source_type": quiz["source_type"],
        "youtube_video_id": quiz["youtube_video_id"],
        "questions": public_questions,
        "time_limit_seconds": quiz.get("time_limit_seconds"),
    }


def _score_quiz(quiz, answers):
    answers_map = {a.question_id: a.user_answer for a in answers}
    results, correct_count = [], 0
    for q in quiz["questions"]:
        user_ans = answers_map.get(q["id"], "").strip()
        is_correct = user_ans.lower() == q["correct_answer"].strip().lower()
        if is_correct:
            correct_count += 1
        results.append({
            "question_id": q["id"], "question": q["question"],
            "user_answer": user_ans, "correct_answer": q["correct_answer"],
            "is_correct": is_correct, "explanation": q["explanation"],
            "source_chunk": q["source_chunk"],
            "timestamp_seconds": q.get("timestamp_seconds"),
        })
    total = len(quiz["questions"])
    pct = round(100 * correct_count / total, 1) if total else 0
    return correct_count, total, pct, results


@app.post("/api/submit-quiz")
def submit_quiz(req: SubmitQuizRequest):
    quiz = load_quiz(req.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    correct_count, total, pct, results = _score_quiz(quiz, req.answers)
    return {
        "quiz_id": req.quiz_id,
        "score": correct_count, "total": total, "percentage": pct,
        "results": results,
        "youtube_video_id": quiz.get("youtube_video_id"),
    }


@app.post("/api/leaderboard/submit")
def leaderboard_submit(req: LeaderboardSubmitRequest):
    """Submit a score for a public quiz challenge."""
    quiz = load_quiz(req.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    correct_count, total, pct, results = _score_quiz(quiz, req.answers)
    display_name = (req.display_name or "").strip() or random_animal_name()
    save_leaderboard_entry(req.quiz_id, display_name, correct_count, total, pct)
    return {
        "quiz_id": req.quiz_id,
        "display_name": display_name,
        "score": correct_count, "total": total, "percentage": pct,
        "results": results,
        "youtube_video_id": quiz.get("youtube_video_id"),
    }


@app.get("/api/leaderboard/{quiz_id}")
def leaderboard_get(quiz_id: str):
    quiz = load_quiz(quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    entries = get_leaderboard(quiz_id)
    return {"quiz_id": quiz_id, "title": quiz["title"], "entries": entries}


@app.get("/api/quizzes")
def list_quizzes():
    return {"quizzes": list_all_quizzes()}


@app.post("/api/chat")
def chat(req: ChatRequest, request: Request):
    check_chat_rate_limit(request)
    messages = build_chat_messages(req)
    return StreamingResponse(
        stream_chat(messages),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/eli5")
def api_eli5(req: ELI5Request, request: Request):
    check_chat_rate_limit(request)
    return StreamingResponse(
        stream_eli5(req.question, req.answer, req.original_explanation),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Flashcards
# ---------------------------------------------------------------------------
class Flashcard(BaseModel):
    id: str
    front: str
    back: str
    # SM-2 fields (managed client-side, but room for server-side later)
    ease: Optional[float] = 2.5
    interval: Optional[int] = 0
    reps: Optional[int] = 0


class FlashcardSet(BaseModel):
    id: str
    title: str
    created_at: str
    source_text_preview: str
    cards: List[Flashcard]


class GenerateFlashcardsFromTextRequest(BaseModel):
    text: str = Field(..., min_length=100)
    count: int = Field(default=10, ge=3, le=30)
    format: Literal["term_definition", "question_answer"] = "term_definition"
    title: Optional[str] = "Untitled Flashcards"
    focus_concepts: Optional[List[str]] = None


class GenerateFlashcardsFromQuizRequest(BaseModel):
    quiz_id: str
    title: Optional[str] = None


def save_flashcard_set(fs_dict):
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO flashcard_sets (id, title, created_at, source_text_preview, cards_json) VALUES (?,?,?,?,?)",
            (fs_dict["id"], fs_dict["title"], fs_dict["created_at"],
             fs_dict["source_text_preview"], json.dumps(fs_dict["cards"])),
        )
        conn.commit()


def load_flashcard_set(set_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM flashcard_sets WHERE id = ?", (set_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"], "title": row["title"], "created_at": row["created_at"],
            "source_text_preview": row["source_text_preview"],
            "cards": json.loads(row["cards_json"]),
        }


def list_flashcard_sets():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, cards_json FROM flashcard_sets ORDER BY created_at DESC LIMIT 100"
        ).fetchall()
        return [{
            "id": r["id"], "title": r["title"], "created_at": r["created_at"],
            "num_cards": len(json.loads(r["cards_json"])),
        } for r in rows]


FLASHCARD_PROMPT = """You are an expert at creating effective flashcards for studying. Generate flashcards from the learning material below.

LEARNING MATERIAL:
\"\"\"
{content}
\"\"\"

REQUIREMENTS:
- Number of cards: {count}
- Format: {format_desc}
{focus_block}
INSTRUCTIONS:
- Cards must be based ONLY on the material - do not invent.
- Each card has a "front" and "back".
- Keep front concise (a term, concept, or question).
- Back should be a clear, complete answer (1-3 sentences).
- Cover diverse topics from the material - don't repeat similar cards.
- Match the language of the source material.

Respond with ONLY a valid JSON object:
{{
  "cards": [
    {{"front": "...", "back": "..."}}
  ]
}}
"""


def generate_flashcards_from_text(text, count, format_kind, focus_concepts=None):
    if format_kind == "term_definition":
        format_desc = 'Term/Definition pairs. Front is a key term or concept. Back is its definition.'
    else:
        format_desc = 'Question/Answer pairs. Front is a clear question. Back is the answer.'

    focus_block = ""
    if focus_concepts:
        concepts_str = ", ".join(f'"{c}"' for c in focus_concepts)
        focus_block = f"- FOCUS on these concepts: {concepts_str}\n"

    sample = text[:12000] if len(text) > 12000 else text
    prompt = FLASHCARD_PROMPT.format(content=sample, count=count, format_desc=format_desc, focus_block=focus_block)

    response = client.chat.completions.create(
        model=DEPLOYMENT,
        messages=[
            {"role": "system", "content": "You generate flashcards as valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.6,
        max_tokens=4096,
    )
    raw = response.choices[0].message.content.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse flashcard JSON.")
    return data.get("cards", [])


@app.post("/api/flashcards/generate-from-text", response_model=FlashcardSet)
def api_generate_flashcards_from_text(req: GenerateFlashcardsFromTextRequest, request: Request):
    check_quiz_rate_limit(request)
    if len(req.text) > 50000:
        raise HTTPException(status_code=400, detail="Text too long.")
    raw_cards = generate_flashcards_from_text(req.text, req.count, req.format, req.focus_concepts)
    cards = [{
        "id": str(uuid.uuid4()),
        "front": c.get("front", ""),
        "back": c.get("back", ""),
        "ease": 2.5, "interval": 0, "reps": 0,
    } for c in raw_cards if c.get("front") and c.get("back")]
    if not cards:
        raise HTTPException(status_code=500, detail="No flashcards generated.")
    fs = {
        "id": str(uuid.uuid4()),
        "title": req.title or "Untitled Flashcards",
        "created_at": datetime.utcnow().isoformat(),
        "source_text_preview": req.text[:300] + ("..." if len(req.text) > 300 else ""),
        "cards": cards,
    }
    save_flashcard_set(fs)
    return FlashcardSet(**fs)


@app.post("/api/flashcards/generate-from-quiz", response_model=FlashcardSet)
def api_generate_flashcards_from_quiz(req: GenerateFlashcardsFromQuizRequest, request: Request):
    check_quiz_rate_limit(request)
    quiz = load_quiz(req.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    cards = []
    for q in quiz["questions"]:
        # For multi-choice and short_answer, front=question, back=answer + explanation
        front = q["question"]
        back = q["correct_answer"]
        if q.get("explanation"):
            back += f"\n\n{q['explanation']}"
        cards.append({
            "id": str(uuid.uuid4()),
            "front": front,
            "back": back,
            "ease": 2.5, "interval": 0, "reps": 0,
        })
    fs = {
        "id": str(uuid.uuid4()),
        "title": req.title or f"Flashcards: {quiz['title']}",
        "created_at": datetime.utcnow().isoformat(),
        "source_text_preview": quiz["source_text_preview"],
        "cards": cards,
    }
    save_flashcard_set(fs)
    return FlashcardSet(**fs)


@app.get("/api/flashcards/{set_id}", response_model=FlashcardSet)
def api_get_flashcards(set_id: str):
    fs = load_flashcard_set(set_id)
    if not fs:
        raise HTTPException(status_code=404, detail="Flashcard set not found.")
    return FlashcardSet(**fs)


@app.get("/api/flashcards")
def api_list_flashcards():
    return {"sets": list_flashcard_sets()}


# ---------------------------------------------------------------------------
# Study Notes
# ---------------------------------------------------------------------------
class StudyNote(BaseModel):
    id: str
    title: str
    created_at: str
    source_text_preview: str
    format: Literal["summary", "guide"]
    content_md: str


class GenerateNotesRequest(BaseModel):
    text: str = Field(..., min_length=100)
    format: Literal["summary", "guide"] = "guide"
    title: Optional[str] = "Untitled Notes"
    focus_concepts: Optional[List[str]] = None


def save_note(note_dict):
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO study_notes (id, title, created_at, source_text_preview, format, content_md) VALUES (?,?,?,?,?,?)",
            (note_dict["id"], note_dict["title"], note_dict["created_at"],
             note_dict["source_text_preview"], note_dict["format"], note_dict["content_md"]),
        )
        conn.commit()


def load_note(note_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM study_notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            return None
        return dict(row)


def list_notes():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, format FROM study_notes ORDER BY created_at DESC LIMIT 100"
        ).fetchall()
        return [dict(r) for r in rows]


SUMMARY_PROMPT = """Create a clear, concise study summary of the material below in Markdown.

Use this structure:
- Brief intro paragraph explaining what the material covers
- 4-7 main points as a bulleted list
- A short closing paragraph noting key takeaways

Match the language of the source material. Be concise and accurate. Do not invent information not in the material.

MATERIAL:
\"\"\"
{content}
\"\"\"
"""

GUIDE_PROMPT = """Create a structured study guide in Markdown from the material below.

Use this structure:
# Study Guide: [Topic]

## Overview
2-3 sentence overview.

## Key Concepts
For each major concept, use a heading and explanation:
### Concept name
- Definition
- Why it matters
- Example or application

## Key Terms
A bulleted glossary: **term** — definition

## Summary
3-4 sentence wrap-up.

Match the language of the source material. Be thorough but concise. Do not invent information not in the material.

MATERIAL:
\"\"\"
{content}
\"\"\"
"""


def generate_notes(text, format_kind, focus_concepts=None):
    sample = text[:14000] if len(text) > 14000 else text
    prompt = (GUIDE_PROMPT if format_kind == "guide" else SUMMARY_PROMPT).format(content=sample)
    if focus_concepts:
        concepts_str = ", ".join(f'"{c}"' for c in focus_concepts)
        prompt += f"\n\nFOCUS especially on these concepts: {concepts_str}\n"

    response = client.chat.completions.create(
        model=DEPLOYMENT,
        messages=[
            {"role": "system", "content": "You write clear, well-organized study materials in Markdown."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.5,
        max_tokens=3000,
    )
    return response.choices[0].message.content.strip()


@app.post("/api/notes/generate", response_model=StudyNote)
def api_generate_notes(req: GenerateNotesRequest, request: Request):
    check_quiz_rate_limit(request)
    if len(req.text) > 50000:
        raise HTTPException(status_code=400, detail="Text too long.")
    content_md = generate_notes(req.text, req.format, req.focus_concepts)
    note = {
        "id": str(uuid.uuid4()),
        "title": req.title or "Untitled Notes",
        "created_at": datetime.utcnow().isoformat(),
        "source_text_preview": req.text[:300] + ("..." if len(req.text) > 300 else ""),
        "format": req.format,
        "content_md": content_md,
    }
    save_note(note)
    return StudyNote(**note)


@app.get("/api/notes/{note_id}", response_model=StudyNote)
def api_get_note(note_id: str):
    note = load_note(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found.")
    return StudyNote(**note)


@app.get("/api/notes")
def api_list_notes():
    return {"notes": list_notes()}


# ===========================================================================
# CLASSROOM / TEACHER FEATURES
# ===========================================================================

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class ClassInfo(BaseModel):
    id: str
    name: str
    code: str
    teacher_name: str
    created_at: str
    student_count: int = 0
    assignment_count: int = 0
    color: Optional[str] = "#7c3aed"
    icon: Optional[str] = "graduation"


class CreateClassRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    teacher_name: str = Field(..., min_length=1, max_length=80)
    color: Optional[str] = "#7c3aed"
    icon: Optional[str] = "graduation"


class UpdateClassRequest(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    icon: Optional[str] = None


class JoinClassRequest(BaseModel):
    code: str
    student_name: str = Field(..., min_length=1, max_length=80)


class CreateAssignmentRequest(BaseModel):
    class_id: str
    quiz_id: str
    due_at: Optional[str] = None  # ISO datetime string


class SubmitAssignmentRequest(BaseModel):
    assignment_id: str
    student_name: str
    answers: List[AnswerSubmission]


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def generate_class_code() -> str:
    """8-char uppercase code, e.g. 'BIO-K9XM'."""
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I,O,1,0 (confusing)
    while True:
        code = "".join(random.choices(chars, k=6))
        # Check uniqueness
        with get_db() as conn:
            existing = conn.execute("SELECT 1 FROM classes WHERE code = ?", (code,)).fetchone()
        if not existing:
            return code


def save_class(c):
    with get_db() as conn:
        conn.execute(
            """INSERT INTO classes (id, name, code, teacher_name, created_at, color, icon, teacher_id)
               VALUES (?,?,?,?,?,?,?,?)""",
            (c["id"], c["name"], c["code"], c["teacher_name"], c["created_at"],
             c.get("color", "#7c3aed"), c.get("icon", "graduation"),
             c.get("teacher_id")),
        )
        conn.commit()


def load_class(class_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM classes WHERE id = ?", (class_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        # SQLite Row may not include teacher_id key safely if column was just added
        try:
            d["teacher_id"] = row["teacher_id"]
        except (KeyError, IndexError):
            d["teacher_id"] = None
        return d


def load_class_by_code(code):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM classes WHERE code = ?", (code,)).fetchone()
        return dict(row) if row else None


def list_classes(teacher_id: Optional[str] = None):
    """List classes for a teacher (or all classes if teacher_id is None - admin only)."""
    with get_db() as conn:
        if teacher_id:
            rows = conn.execute(
                """SELECT id, name, code, teacher_name, created_at, color, icon
                   FROM classes WHERE teacher_id = ? ORDER BY created_at DESC LIMIT 200""",
                (teacher_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, name, code, teacher_name, created_at, color, icon
                   FROM classes ORDER BY created_at DESC LIMIT 200"""
            ).fetchall()
        out = []
        for r in rows:
            class_id = r["id"]
            students = conn.execute("SELECT COUNT(*) c FROM class_memberships WHERE class_id = ?", (class_id,)).fetchone()
            assigns = conn.execute("SELECT COUNT(*) c FROM assignments WHERE class_id = ?", (class_id,)).fetchone()
            d = dict(r)
            d["student_count"] = students["c"]
            d["assignment_count"] = assigns["c"]
            out.append(d)
        return out


def add_membership(class_id, student_name):
    with get_db() as conn:
        # Don't add duplicate
        existing = conn.execute(
            "SELECT 1 FROM class_memberships WHERE class_id = ? AND student_name = ?",
            (class_id, student_name),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO class_memberships (class_id, student_name, joined_at) VALUES (?,?,?)",
                (class_id, student_name, datetime.utcnow().isoformat()),
            )
            conn.commit()


def list_class_members(class_id):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT student_name, joined_at FROM class_memberships WHERE class_id = ? ORDER BY joined_at DESC",
            (class_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def save_assignment(a):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO assignments (id, class_id, quiz_id, due_at, created_at) VALUES (?,?,?,?,?)",
            (a["id"], a["class_id"], a["quiz_id"], a.get("due_at"), a["created_at"]),
        )
        conn.commit()


def load_assignment(assignment_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM assignments WHERE id = ?", (assignment_id,)).fetchone()
        return dict(row) if row else None


def list_class_assignments(class_id):
    with get_db() as conn:
        rows = conn.execute("""
            SELECT a.*, q.title as quiz_title, q.questions_json
            FROM assignments a
            JOIN quizzes q ON q.id = a.quiz_id
            WHERE a.class_id = ?
            ORDER BY a.created_at DESC
        """, (class_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["num_questions"] = len(json.loads(d.pop("questions_json", "[]")))
            # Submission count
            sub = conn.execute(
                "SELECT COUNT(*) c FROM leaderboard WHERE assignment_id = ?",
                (d["id"],),
            ).fetchone()
            d["submission_count"] = sub["c"]
            out.append(d)
        return out


def delete_class(class_id):
    with get_db() as conn:
        conn.execute("DELETE FROM assignments WHERE class_id = ?", (class_id,))
        conn.execute("DELETE FROM class_memberships WHERE class_id = ?", (class_id,))
        conn.execute("UPDATE leaderboard SET class_id = NULL WHERE class_id = ?", (class_id,))
        conn.execute("DELETE FROM classes WHERE id = ?", (class_id,))
        conn.commit()


def delete_assignment(assignment_id):
    with get_db() as conn:
        conn.execute("UPDATE leaderboard SET assignment_id = NULL WHERE assignment_id = ?", (assignment_id,))
        conn.execute("DELETE FROM assignments WHERE id = ?", (assignment_id,))
        conn.commit()


# ---------------------------------------------------------------------------
# Class endpoints
# ---------------------------------------------------------------------------
@app.post("/api/classes", response_model=ClassInfo)
def api_create_class(req: CreateClassRequest, teacher: dict = Depends(require_teacher)):
    c = {
        "id": str(uuid.uuid4()),
        "name": req.name.strip(),
        "code": generate_class_code(),
        "teacher_name": req.teacher_name.strip() or teacher["name"],
        "created_at": datetime.utcnow().isoformat(),
        "color": req.color or "#7c3aed",
        "icon": req.icon or "graduation",
        "teacher_id": teacher["id"],
    }
    save_class(c)
    c["student_count"] = 0
    c["assignment_count"] = 0
    return ClassInfo(**c)


@app.patch("/api/classes/{class_id}")
def api_update_class(class_id: str, req: UpdateClassRequest, teacher: dict = Depends(require_teacher)):
    _check_class_owner(class_id, teacher)
    updates = []
    params = []
    if req.name is not None:
        updates.append("name = ?")
        params.append(req.name.strip())
    if req.color is not None:
        updates.append("color = ?")
        params.append(req.color)
    if req.icon is not None:
        updates.append("icon = ?")
        params.append(req.icon)
    if not updates:
        return {"updated": class_id}
    params.append(class_id)
    with get_db() as conn:
        conn.execute(f"UPDATE classes SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    return {"updated": class_id}


@app.get("/api/classes")
def api_list_classes(teacher: dict = Depends(require_teacher)):
    return {"classes": list_classes(teacher_id=teacher["id"])}


def _check_class_owner(class_id: str, teacher: Optional[dict]) -> dict:
    """Load a class and confirm the teacher owns it. Returns the class dict."""
    c = load_class(class_id)
    if not c:
        raise HTTPException(status_code=404, detail="Class not found.")
    # Allow if class has no teacher_id (legacy) OR matches the signed-in teacher
    if c.get("teacher_id") and (not teacher or c["teacher_id"] != teacher["id"]):
        raise HTTPException(status_code=403, detail="You don't have access to this class.")
    return c


@app.get("/api/classes/{class_id}")
def api_get_class(class_id: str, teacher: Optional[dict] = Depends(optional_teacher)):
    """Class detail. Students (no token) get a minimal version. Teachers must own it."""
    c = load_class(class_id)
    if not c:
        raise HTTPException(status_code=404, detail="Class not found.")
    # If the class has an owner and the requester is the owner, return full data.
    # If no owner (legacy) OR requester is a student (no token), return public-ish data.
    members = list_class_members(class_id)
    assignments = list_class_assignments(class_id)
    is_owner = teacher and c.get("teacher_id") == teacher["id"]
    is_legacy = not c.get("teacher_id")
    if not (is_owner or is_legacy):
        # Student or non-owner: hide nothing critical, just don't allow modifications.
        # The data here is fine since students need it to take assignments.
        pass
    return {
        "class": c,
        "members": members,
        "assignments": assignments,
    }


@app.delete("/api/classes/{class_id}")
def api_delete_class(class_id: str, teacher: dict = Depends(require_teacher)):
    _check_class_owner(class_id, teacher)
    delete_class(class_id)
    return {"deleted": class_id}


@app.get("/api/classes/by-code/{code}")
def api_class_by_code(code: str):
    c = load_class_by_code(code.upper().strip())
    if not c:
        raise HTTPException(status_code=404, detail="Class not found. Check the code.")
    # Public info - don't expose teacher details beyond name
    return {
        "id": c["id"],
        "name": c["name"],
        "code": c["code"],
        "teacher_name": c["teacher_name"],
    }


@app.post("/api/classes/join")
def api_join_class(req: JoinClassRequest):
    c = load_class_by_code(req.code.upper().strip())
    if not c:
        raise HTTPException(status_code=404, detail="Class not found. Check the code.")
    add_membership(c["id"], req.student_name.strip())
    # Return active assignments for the student
    assignments = list_class_assignments(c["id"])
    return {
        "class": {
            "id": c["id"], "name": c["name"], "code": c["code"], "teacher_name": c["teacher_name"],
        },
        "student_name": req.student_name.strip(),
        "assignments": assignments,
    }


# ---------------------------------------------------------------------------
# Assignment endpoints
# ---------------------------------------------------------------------------
@app.post("/api/assignments")
def api_create_assignment(req: CreateAssignmentRequest, teacher: dict = Depends(require_teacher)):
    _check_class_owner(req.class_id, teacher)
    if not load_quiz(req.quiz_id):
        raise HTTPException(status_code=404, detail="Quiz not found.")
    a = {
        "id": str(uuid.uuid4()),
        "class_id": req.class_id,
        "quiz_id": req.quiz_id,
        "due_at": req.due_at,
        "created_at": datetime.utcnow().isoformat(),
    }
    save_assignment(a)
    return a


@app.delete("/api/assignments/{assignment_id}")
def api_delete_assignment(assignment_id: str, teacher: dict = Depends(require_teacher)):
    a = load_assignment(assignment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    _check_class_owner(a["class_id"], teacher)
    delete_assignment(assignment_id)
    return {"deleted": assignment_id}


@app.get("/api/assignments/{assignment_id}")
def api_get_assignment(assignment_id: str):
    a = load_assignment(assignment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    quiz = load_quiz(a["quiz_id"])
    cls = load_class(a["class_id"])
    return {
        "assignment": a,
        "quiz": quiz,
        "class": cls,
    }


@app.post("/api/assignments/submit")
def api_submit_assignment(req: SubmitAssignmentRequest):
    a = load_assignment(req.assignment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    quiz = load_quiz(a["quiz_id"])
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    correct, total, pct, results = _score_quiz(quiz, req.answers)
    name = req.student_name.strip() or random_animal_name()
    # Save with class_id and assignment_id for analytics
    with get_db() as conn:
        conn.execute(
            """INSERT INTO leaderboard (quiz_id, display_name, score, total, percentage, created_at, class_id, assignment_id)
               VALUES (?,?,?,?,?,?,?,?)""",
            (quiz["id"], name, correct, total, pct, datetime.utcnow().isoformat(),
             a["class_id"], a["id"]),
        )
        conn.commit()
    return {
        "assignment_id": a["id"],
        "student_name": name,
        "score": correct, "total": total, "percentage": pct,
        "results": results,
        "youtube_video_id": quiz.get("youtube_video_id"),
    }


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------
@app.get("/api/assignments/{assignment_id}/analytics")
def api_assignment_analytics(assignment_id: str, teacher: dict = Depends(require_teacher)):
    """Per-question correct rates and per-student scores."""
    a = load_assignment(assignment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    _check_class_owner(a["class_id"], teacher)
    quiz = load_quiz(a["quiz_id"])
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    with get_db() as conn:
        rows = conn.execute(
            """SELECT display_name, score, total, percentage, created_at
               FROM leaderboard WHERE assignment_id = ? ORDER BY percentage DESC""",
            (assignment_id,),
        ).fetchall()
    submissions = [dict(r) for r in rows]

    if not submissions:
        return {
            "quiz_title": quiz["title"],
            "total_submissions": 0,
            "average_pct": 0,
            "submissions": [],
            "questions": [
                {
                    "id": q["id"],
                    "question": q["question"],
                    "correct_answer": q["correct_answer"],
                    "type": q["type"],
                    "correct_rate": None,
                }
                for q in quiz["questions"]
            ],
        }

    avg = sum(s["percentage"] for s in submissions) / len(submissions)
    # We don't store individual answers, only aggregate scores. Per-question correct rate
    # requires more data than we currently capture. We'll return aggregate stats and a
    # placeholder for question-level (TODO improvement).
    questions = [
        {
            "id": q["id"],
            "question": q["question"],
            "correct_answer": q["correct_answer"],
            "type": q["type"],
            "difficulty": q.get("difficulty"),
        }
        for q in quiz["questions"]
    ]
    return {
        "quiz_title": quiz["title"],
        "total_submissions": len(submissions),
        "average_pct": round(avg, 1),
        "submissions": submissions,
        "questions": questions,
    }


@app.get("/api/assignments/{assignment_id}/export.csv")
def api_export_assignment_csv(assignment_id: str):
    """Export submissions as CSV."""
    a = load_assignment(assignment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    quiz = load_quiz(a["quiz_id"])
    cls = load_class(a["class_id"])
    with get_db() as conn:
        rows = conn.execute(
            """SELECT display_name, score, total, percentage, created_at
               FROM leaderboard WHERE assignment_id = ? ORDER BY display_name""",
            (assignment_id,),
        ).fetchall()

    import io as iolib, csv
    buf = iolib.StringIO()
    w = csv.writer(buf)
    w.writerow(["Class", "Quiz", "Student", "Score", "Total", "Percentage", "Submitted At"])
    for r in rows:
        w.writerow([
            cls["name"] if cls else "",
            quiz["title"] if quiz else "",
            r["display_name"], r["score"], r["total"], r["percentage"], r["created_at"],
        ])
    csv_text = buf.getvalue()
    filename = f"{(quiz['title'] if quiz else 'assignment').replace(' ', '_')}.csv"

    from fastapi.responses import Response
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/classes/{class_id}/export.csv")
def api_export_class_csv(class_id: str):
    """Export ALL assignment submissions for a class as a single CSV (gradebook)."""
    cls = load_class(class_id)
    if not cls:
        raise HTTPException(status_code=404, detail="Class not found.")
    with get_db() as conn:
        rows = conn.execute("""
            SELECT q.title as quiz_title, l.display_name, l.score, l.total, l.percentage, l.created_at, l.assignment_id
            FROM leaderboard l
            JOIN quizzes q ON q.id = l.quiz_id
            WHERE l.class_id = ?
            ORDER BY l.display_name, l.created_at
        """, (class_id,)).fetchall()

    import io as iolib, csv
    buf = iolib.StringIO()
    w = csv.writer(buf)
    w.writerow(["Class", "Quiz", "Student", "Score", "Total", "Percentage", "Submitted At"])
    for r in rows:
        w.writerow([
            cls["name"], r["quiz_title"], r["display_name"],
            r["score"], r["total"], r["percentage"], r["created_at"],
        ])

    from fastapi.responses import Response
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{cls["name"].replace(" ", "_")}_gradebook.csv"'},
    )


# ===========================================================================
# v6a additions — Announcements, AI Short-Answer Grading
# ===========================================================================

class CreateAnnouncementRequest(BaseModel):
    class_id: str
    author_name: str = Field(..., min_length=1, max_length=80)
    message: str = Field(..., min_length=1, max_length=2000)


class GradeShortAnswerRequest(BaseModel):
    question: str = Field(..., min_length=1)
    correct_answer: str = Field(..., min_length=1)
    student_answer: str = Field(..., min_length=1, max_length=2000)


def save_announcement(a):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO class_announcements (id, class_id, author_name, message, created_at) VALUES (?,?,?,?,?)",
            (a["id"], a["class_id"], a["author_name"], a["message"], a["created_at"]),
        )
        conn.commit()


def list_announcements(class_id):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, class_id, author_name, message, created_at FROM class_announcements WHERE class_id = ? ORDER BY created_at DESC LIMIT 100",
            (class_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def delete_announcement_db(announcement_id):
    with get_db() as conn:
        conn.execute("DELETE FROM class_announcements WHERE id = ?", (announcement_id,))
        conn.commit()


@app.post("/api/announcements")
def api_create_announcement(req: CreateAnnouncementRequest, teacher: dict = Depends(require_teacher)):
    _check_class_owner(req.class_id, teacher)
    a = {
        "id": str(uuid.uuid4()),
        "class_id": req.class_id,
        "author_name": req.author_name.strip(),
        "message": req.message.strip(),
        "created_at": datetime.utcnow().isoformat(),
    }
    save_announcement(a)
    return a


@app.get("/api/classes/{class_id}/announcements")
def api_list_announcements(class_id: str):
    if not load_class(class_id):
        raise HTTPException(status_code=404, detail="Class not found.")
    return {"announcements": list_announcements(class_id)}


@app.delete("/api/announcements/{announcement_id}")
def api_delete_announcement(announcement_id: str, teacher: dict = Depends(require_teacher)):
    # We don't store who posted, so we just trust that the route is authenticated.
    # (For stricter rules we'd store author_id and verify ownership.)
    delete_announcement_db(announcement_id)
    return {"deleted": announcement_id}


# ---------------------------------------------------------------------------
# AI short-answer grading
# ---------------------------------------------------------------------------
SHORT_ANSWER_GRADING_PROMPT = """You are an impartial grader. Compare the student's answer to the correct answer.

QUESTION: {question}
CORRECT ANSWER: {correct}
STUDENT ANSWER: {student}

Determine:
1. score: 1.0 if fully correct, 0.5 if partially correct (right idea but missing detail), 0.0 if wrong
2. feedback: 1-2 short sentences explaining the score, friendly and educational. Match the language of the answer.

Respond with ONLY a valid JSON object:
{{
  "score": 1.0,
  "feedback": "..."
}}"""


@app.post("/api/grade-short-answer")
def api_grade_short_answer(req: GradeShortAnswerRequest, request: Request):
    check_chat_rate_limit(request)
    student = req.student_answer.strip()
    correct = req.correct_answer.strip()

    # Quick pre-check: exact match (case-insensitive) is always 1.0
    if student.lower() == correct.lower():
        return {"score": 1.0, "feedback": "Exact match — well done!"}

    prompt = SHORT_ANSWER_GRADING_PROMPT.format(
        question=req.question,
        correct=correct,
        student=student,
    )
    try:
        response = client.chat.completions.create(
            model=DEPLOYMENT,
            messages=[
                {"role": "system", "content": "You grade student answers fairly and return valid JSON only."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=300,
        )
        raw = response.choices[0].message.content.strip()
        data = json.loads(raw)
        score = float(data.get("score", 0))
        if score not in (0.0, 0.5, 1.0):
            score = round(score * 2) / 2  # Snap to 0/0.5/1.0
            score = max(0.0, min(1.0, score))
        return {
            "score": score,
            "feedback": data.get("feedback", ""),
        }
    except Exception as e:
        # Fall back to substring match if AI grading fails
        if correct.lower() in student.lower() or student.lower() in correct.lower():
            return {"score": 0.5, "feedback": "Partial credit (AI grading unavailable)."}
        return {"score": 0.0, "feedback": "Could not grade. Marked as incorrect."}


# ===========================================================================
# AUTH ENDPOINTS
# ===========================================================================

class SignUpRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=6, max_length=200)
    name: str = Field(..., min_length=1, max_length=80)


class SignInRequest(BaseModel):
    email: str
    password: str


@app.post("/api/auth/signup")
def api_signup(req: SignUpRequest):
    email = req.email.strip().lower()
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Please enter a valid email.")
    with get_db() as conn:
        existing = conn.execute("SELECT 1 FROM teachers WHERE email = ?", (email,)).fetchone()
    if existing:
        raise HTTPException(status_code=400, detail="An account with this email already exists.")
    teacher_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO teachers (id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)",
            (teacher_id, email, hash_password(req.password), req.name.strip(), datetime.utcnow().isoformat()),
        )
        conn.commit()
    token = create_session(teacher_id)
    return {
        "token": token,
        "teacher": {"id": teacher_id, "email": email, "name": req.name.strip()},
    }


@app.post("/api/auth/signin")
def api_signin(req: SignInRequest):
    email = req.email.strip().lower()
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, name FROM teachers WHERE email = ?",
            (email,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=400, detail="No account with that email.")
    if not verify_password(req.password, row["password_hash"]):
        raise HTTPException(status_code=400, detail="Wrong password.")
    token = create_session(row["id"])
    return {
        "token": token,
        "teacher": {"id": row["id"], "email": row["email"], "name": row["name"]},
    }


@app.get("/api/auth/me")
def api_me(teacher: dict = Depends(require_teacher)):
    return {"teacher": teacher}


@app.post("/api/auth/signout")
def api_signout(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        return {"signed_out": True}
    token = authorization.split(None, 1)[1].strip()
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
    return {"signed_out": True}


# ===========================================================================
# LIVE QUIZ MODE
# ===========================================================================
# Polling-based real-time. Teacher creates session → students join → teacher
# advances questions → leaderboard updates as students submit.

class CreateLiveSessionRequest(BaseModel):
    quiz_id: str


class JoinLiveSessionRequest(BaseModel):
    code: str
    player_name: str = Field(..., min_length=1, max_length=80)


class SubmitLiveAnswerRequest(BaseModel):
    session_id: str
    player_id: int
    question_index: int
    answer: str


def generate_live_code() -> str:
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(random.choices(chars, k=6))
        with get_db() as conn:
            existing = conn.execute("SELECT 1 FROM live_sessions WHERE code = ? AND state != 'finished'", (code,)).fetchone()
        if not existing:
            return code


def _live_session_dict(row):
    if not row:
        return None
    d = dict(row)
    return d


def load_live_session_by_code(code: str):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE code = ?",
            (code.upper().strip(),),
        ).fetchone()
        return _live_session_dict(row)


def load_live_session(session_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM live_sessions WHERE id = ?", (session_id,)).fetchone()
        return _live_session_dict(row)


def list_live_players(session_id: str):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, player_name, score, joined_at, last_seen FROM live_players WHERE session_id = ? ORDER BY score DESC, joined_at ASC",
            (session_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def filter_live_questions(quiz: dict) -> List[dict]:
    """Live mode only supports MC and TF (per user choice)."""
    return [q for q in quiz["questions"] if q.get("type") in ("multiple_choice", "true_false")]


@app.post("/api/live/create")
def api_create_live(req: CreateLiveSessionRequest, teacher: dict = Depends(require_teacher)):
    quiz = load_quiz(req.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    valid_qs = filter_live_questions(quiz)
    if not valid_qs:
        raise HTTPException(
            status_code=400,
            detail="This quiz has no multiple-choice or true/false questions, which are the only types supported in live mode.",
        )
    sid = str(uuid.uuid4())
    code = generate_live_code()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO live_sessions (id, code, quiz_id, teacher_id, state, current_question_index, created_at)
               VALUES (?,?,?,?, 'lobby', -1, ?)""",
            (sid, code, req.quiz_id, teacher["id"], datetime.utcnow().isoformat()),
        )
        conn.commit()
    return {
        "session_id": sid,
        "code": code,
        "quiz_title": quiz["title"],
        "num_questions": len(valid_qs),
    }


@app.post("/api/live/join")
def api_join_live(req: JoinLiveSessionRequest):
    sess = load_live_session_by_code(req.code)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found. Check the code.")
    if sess["state"] != "lobby":
        raise HTTPException(status_code=400, detail="This game has already started or finished.")
    name = req.player_name.strip()
    with get_db() as conn:
        # Prevent duplicate names within a single session
        existing = conn.execute(
            "SELECT id FROM live_players WHERE session_id = ? AND player_name = ?",
            (sess["id"], name),
        ).fetchone()
        if existing:
            return {
                "session_id": sess["id"],
                "player_id": existing["id"],
                "player_name": name,
                "rejoined": True,
            }
        cursor = conn.execute(
            "INSERT INTO live_players (session_id, player_name, joined_at, last_seen) VALUES (?,?,?,?)",
            (sess["id"], name, datetime.utcnow().isoformat(), datetime.utcnow().isoformat()),
        )
        conn.commit()
        player_id = cursor.lastrowid
    return {
        "session_id": sess["id"],
        "player_id": player_id,
        "player_name": name,
        "rejoined": False,
    }


@app.get("/api/live/{session_id}/state")
def api_live_state(session_id: str, player_id: Optional[int] = None):
    """Polled by both teacher (host view) and players. Updates last_seen for the player."""
    sess = load_live_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found.")
    quiz = load_quiz(sess["quiz_id"])
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    questions = filter_live_questions(quiz)

    # Update player presence
    if player_id is not None:
        with get_db() as conn:
            conn.execute(
                "UPDATE live_players SET last_seen = ? WHERE id = ? AND session_id = ?",
                (datetime.utcnow().isoformat(), player_id, session_id),
            )
            conn.commit()

    players = list_live_players(session_id)

    # Build current_question (without correct_answer for students)
    current_q = None
    student_answer = None
    if 0 <= sess["current_question_index"] < len(questions):
        q = questions[sess["current_question_index"]]
        current_q = {
            "index": sess["current_question_index"],
            "type": q["type"],
            "question": q["question"],
            "options": q.get("options"),
            "difficulty": q.get("difficulty"),
        }
        if player_id is not None:
            with get_db() as conn:
                a = conn.execute(
                    "SELECT answer, is_correct FROM live_answers WHERE session_id = ? AND player_id = ? AND question_index = ?",
                    (session_id, player_id, sess["current_question_index"]),
                ).fetchone()
                if a:
                    student_answer = {"answer": a["answer"], "is_correct": bool(a["is_correct"])}

    # If we're showing results for a question (state == 'reveal'), include correct answer
    reveal_data = None
    if sess["state"] == "reveal" and 0 <= sess["current_question_index"] < len(questions):
        q = questions[sess["current_question_index"]]
        with get_db() as conn:
            answer_rows = conn.execute(
                "SELECT answer, COUNT(*) as count, SUM(is_correct) as correct_count FROM live_answers WHERE session_id = ? AND question_index = ? GROUP BY answer",
                (session_id, sess["current_question_index"]),
            ).fetchall()
        reveal_data = {
            "correct_answer": q["correct_answer"],
            "explanation": q.get("explanation", ""),
            "answer_distribution": [dict(r) for r in answer_rows],
        }

    return {
        "session": {
            "id": sess["id"],
            "code": sess["code"],
            "state": sess["state"],
            "current_question_index": sess["current_question_index"],
            "question_started_at": sess["question_started_at"],
        },
        "quiz_title": quiz["title"],
        "total_questions": len(questions),
        "current_question": current_q,
        "reveal": reveal_data,
        "players": players,
        "student_answer": student_answer,
    }


@app.post("/api/live/{session_id}/start")
def api_live_start(session_id: str, teacher: dict = Depends(require_teacher)):
    sess = load_live_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found.")
    if sess["teacher_id"] != teacher["id"]:
        raise HTTPException(status_code=403, detail="Not your session.")
    with get_db() as conn:
        conn.execute(
            "UPDATE live_sessions SET state = 'question', current_question_index = 0, question_started_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), session_id),
        )
        conn.commit()
    return {"started": True}


@app.post("/api/live/{session_id}/reveal")
def api_live_reveal(session_id: str, teacher: dict = Depends(require_teacher)):
    """Teacher locks current question and shows the correct answer + distribution."""
    sess = load_live_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found.")
    if sess["teacher_id"] != teacher["id"]:
        raise HTTPException(status_code=403, detail="Not your session.")
    with get_db() as conn:
        conn.execute(
            "UPDATE live_sessions SET state = 'reveal' WHERE id = ?",
            (session_id,),
        )
        conn.commit()
    return {"state": "reveal"}


@app.post("/api/live/{session_id}/next")
def api_live_next(session_id: str, teacher: dict = Depends(require_teacher)):
    """Advance to next question, or end the session if no more questions."""
    sess = load_live_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found.")
    if sess["teacher_id"] != teacher["id"]:
        raise HTTPException(status_code=403, detail="Not your session.")
    quiz = load_quiz(sess["quiz_id"])
    questions = filter_live_questions(quiz)
    next_idx = sess["current_question_index"] + 1
    if next_idx >= len(questions):
        with get_db() as conn:
            conn.execute(
                "UPDATE live_sessions SET state = 'finished' WHERE id = ?",
                (session_id,),
            )
            conn.commit()
        return {"state": "finished"}
    with get_db() as conn:
        conn.execute(
            "UPDATE live_sessions SET state = 'question', current_question_index = ?, question_started_at = ? WHERE id = ?",
            (next_idx, datetime.utcnow().isoformat(), session_id),
        )
        conn.commit()
    return {"state": "question", "current_question_index": next_idx}


@app.post("/api/live/answer")
def api_live_answer(req: SubmitLiveAnswerRequest):
    sess = load_live_session(req.session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found.")
    if sess["state"] != "question":
        raise HTTPException(status_code=400, detail="Not accepting answers right now.")
    if sess["current_question_index"] != req.question_index:
        raise HTTPException(status_code=400, detail="Wrong question index.")

    quiz = load_quiz(sess["quiz_id"])
    questions = filter_live_questions(quiz)
    q = questions[req.question_index]
    is_correct = req.answer.strip().lower() == q["correct_answer"].strip().lower()

    # Speed-bonus scoring: correct answer = 1000 base + faster = more points (max 1000 bonus)
    points = 0
    if is_correct:
        try:
            qstart = datetime.fromisoformat(sess["question_started_at"])
            elapsed = (datetime.utcnow() - qstart).total_seconds()
            # 30 sec window — faster = more bonus
            speed_bonus = max(0, int(1000 - (elapsed / 30) * 500))
            points = 1000 + speed_bonus
        except (TypeError, ValueError):
            points = 1000

    with get_db() as conn:
        # Insert OR replace based on (session, player, question)
        conn.execute(
            "DELETE FROM live_answers WHERE session_id = ? AND player_id = ? AND question_index = ?",
            (req.session_id, req.player_id, req.question_index),
        )
        conn.execute(
            "INSERT INTO live_answers (session_id, player_id, question_index, answer, is_correct, answered_at, points) VALUES (?,?,?,?,?,?,?)",
            (req.session_id, req.player_id, req.question_index, req.answer, 1 if is_correct else 0,
             datetime.utcnow().isoformat(), points),
        )
        # Recompute total score for player
        total = conn.execute(
            "SELECT COALESCE(SUM(points), 0) total FROM live_answers WHERE session_id = ? AND player_id = ?",
            (req.session_id, req.player_id),
        ).fetchone()["total"]
        conn.execute(
            "UPDATE live_players SET score = ?, last_seen = ? WHERE id = ?",
            (total, datetime.utcnow().isoformat(), req.player_id),
        )
        conn.commit()

    return {
        "is_correct": is_correct,
        "points": points,
    }

