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
from contextlib import contextmanager
from typing import List, Optional, Literal
from datetime import datetime
from collections import defaultdict, deque

from fastapi import FastAPI, File, UploadFile, HTTPException, Request
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


def save_quiz(quiz_dict: dict):
    with get_db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO quizzes
            (id, title, created_at, source_text_preview, source_type, youtube_video_id, questions_json)
            VALUES (?,?,?,?,?,?,?)""",
            (
                quiz_dict["id"],
                quiz_dict["title"],
                quiz_dict["created_at"],
                quiz_dict["source_text_preview"],
                quiz_dict.get("source_type", "text"),
                quiz_dict.get("youtube_video_id"),
                json.dumps(quiz_dict["questions"]),
            ),
        )
        conn.commit()


def load_quiz(quiz_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "source_text_preview": row["source_text_preview"],
            "source_type": row["source_type"] or "text",
            "youtube_video_id": row["youtube_video_id"],
            "questions": json.loads(row["questions_json"]),
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


class GenerateRequest(BaseModel):
    text: str
    num_questions: int = Field(default=5, ge=1, le=15)
    difficulty: Literal["easy", "medium", "hard", "mixed"] = "mixed"
    question_types: List[Literal["multiple_choice", "true_false", "short_answer"]] = ["multiple_choice"]
    title: Optional[str] = "Untitled Quiz"
    source_type: Literal["text", "pdf", "youtube", "multi"] = "text"
    youtube_video_id: Optional[str] = None
    focus_concepts: Optional[List[str]] = None


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


def build_quiz(text, num_questions, difficulty, types, title, source_type="text",
               youtube_video_id=None, focus_concepts=None) -> Quiz:
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
    all_questions = all_questions[:num_questions]
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
