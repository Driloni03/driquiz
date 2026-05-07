"""
Quiz Generator API - FastAPI backend (Azure OpenAI version, deployment-ready)
"""
import os
import json
import uuid
import time
from typing import List, Optional, Literal
from datetime import datetime
from collections import defaultdict, deque

from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openai import AzureOpenAI
import fitz  # PyMuPDF
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
app = FastAPI(title="Quiz Generator API", version="1.0.0")

# Read allowed origins from env (comma-separated). Falls back to localhost for dev.
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5173,http://localhost:3000",
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

QUIZZES: dict = {}

# ---------------------------------------------------------------------------
# Simple per-IP rate limiting (5 quiz generations per hour)
# ---------------------------------------------------------------------------
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "5"))
RATE_LIMIT_WINDOW_SEC = int(os.getenv("RATE_LIMIT_WINDOW_SEC", "3600"))
_request_log: dict = defaultdict(deque)


def check_rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    log = _request_log[ip]
    while log and log[0] < now - RATE_LIMIT_WINDOW_SEC:
        log.popleft()
    if len(log) >= RATE_LIMIT_REQUESTS:
        retry_in = int(RATE_LIMIT_WINDOW_SEC - (now - log[0]))
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit reached. Try again in ~{retry_in // 60} min.",
        )
    log.append(now)


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


class Quiz(BaseModel):
    id: str
    title: str
    created_at: str
    questions: List[Question]
    source_text_preview: str


class GenerateRequest(BaseModel):
    text: str
    num_questions: int = Field(default=5, ge=1, le=15)
    difficulty: Literal["easy", "medium", "hard", "mixed"] = "mixed"
    question_types: List[Literal["multiple_choice", "true_false", "short_answer"]] = [
        "multiple_choice"
    ]
    title: Optional[str] = "Untitled Quiz"


class AnswerSubmission(BaseModel):
    question_id: str
    user_answer: str


class SubmitQuizRequest(BaseModel):
    quiz_id: str
    answers: List[AnswerSubmission]


# ---------------------------------------------------------------------------
# PDF & Chunking
# ---------------------------------------------------------------------------
def extract_pdf_text(file_bytes: bytes) -> str:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = []
    for page in doc:
        text = page.get_text("text")
        if text.strip():
            pages.append(text)
    doc.close()
    return "\n\n".join(pages)


def chunk_text(text: str, max_chars: int = 4000) -> List[str]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: List[str] = []
    current = ""
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

IMPORTANT INSTRUCTIONS:
1. Questions must be based ONLY on the provided material - do not invent information.
2. Each question must include a "source_chunk" that is a short citation (1-2 sentences) from the material justifying the correct answer.
3. For multiple_choice: provide exactly 4 options, only one correct. "correct_answer" must be the FULL TEXT of the correct option (not just a letter).
4. For true_false: "correct_answer" must be exactly "True" or "False".
5. For short_answer: "correct_answer" must be a short answer (max 10 words).
6. Explanations should be clear and educational.
7. Match the language of the questions to the language of the source material.

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
      "difficulty": "easy|medium|hard"
    }}
  ]
}}

For true_false and short_answer questions, set "options": null.
"""


def generate_questions_from_chunk(chunk, num_questions, difficulty, types):
    types_str = ", ".join(types)
    prompt = QUIZ_PROMPT.format(
        content=chunk,
        num_questions=num_questions,
        difficulty=difficulty,
        types=types_str,
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
        raise HTTPException(status_code=500, detail=f"LLM returned invalid JSON: {e}. Raw: {raw[:200]}")
    return data.get("questions", [])


def build_quiz(text, num_questions, difficulty, types, title) -> Quiz:
    chunks = chunk_text(text)
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
        qs = generate_questions_from_chunk(chunk, n, difficulty, types)
        all_questions.extend(qs)
    all_questions = all_questions[:num_questions]
    questions = [
        Question(
            id=str(uuid.uuid4()),
            type=q.get("type", "multiple_choice"),
            question=q.get("question", ""),
            options=q.get("options"),
            correct_answer=q.get("correct_answer", ""),
            explanation=q.get("explanation", ""),
            source_chunk=q.get("source_chunk", ""),
            difficulty=q.get("difficulty", "medium"),
        )
        for q in all_questions
    ]
    quiz_id = str(uuid.uuid4())
    quiz = Quiz(
        id=quiz_id,
        title=title,
        created_at=datetime.utcnow().isoformat(),
        questions=questions,
        source_text_preview=text[:300] + ("..." if len(text) > 300 else ""),
    )
    QUIZZES[quiz_id] = quiz
    return quiz


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def root():
    return {"status": "ok", "service": "Quiz Generator API"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed.")
    contents = await file.read()
    if len(contents) > 10 * 1024 * 1024:  # 10 MB cap on free tier
        raise HTTPException(status_code=400, detail="PDF too large (max 10 MB).")
    try:
        text = extract_pdf_text(contents)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {e}")
    if not text.strip():
        raise HTTPException(status_code=400, detail="PDF contains no readable text (it may be scanned).")
    return {"text": text, "char_count": len(text)}


@app.post("/api/generate-quiz", response_model=Quiz)
def generate_quiz(req: GenerateRequest, request: Request):
    check_rate_limit(request)
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is empty.")
    if len(req.text) < 100:
        raise HTTPException(status_code=400, detail="Text is too short (minimum 100 characters).")
    if len(req.text) > 30000:
        raise HTTPException(status_code=400, detail="Text is too long (max 30,000 characters).")
    return build_quiz(
        text=req.text,
        num_questions=req.num_questions,
        difficulty=req.difficulty,
        types=req.question_types,
        title=req.title or "Untitled Quiz",
    )


@app.get("/api/quiz/{quiz_id}", response_model=Quiz)
def get_quiz(quiz_id: str):
    quiz = QUIZZES.get(quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    return quiz


@app.post("/api/submit-quiz")
def submit_quiz(req: SubmitQuizRequest):
    quiz = QUIZZES.get(req.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    answers_map = {a.question_id: a.user_answer for a in req.answers}
    results = []
    correct_count = 0
    for q in quiz.questions:
        user_ans = answers_map.get(q.id, "").strip()
        is_correct = user_ans.lower() == q.correct_answer.strip().lower()
        if is_correct:
            correct_count += 1
        results.append({
            "question_id": q.id,
            "question": q.question,
            "user_answer": user_ans,
            "correct_answer": q.correct_answer,
            "is_correct": is_correct,
            "explanation": q.explanation,
            "source_chunk": q.source_chunk,
        })
    total = len(quiz.questions)
    score_pct = round(100 * correct_count / total, 1) if total else 0
    return {
        "quiz_id": req.quiz_id,
        "score": correct_count,
        "total": total,
        "percentage": score_pct,
        "results": results,
    }
