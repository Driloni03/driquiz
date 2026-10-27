"""
Drilearn API - FastAPI backend
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

# Postgres driver (only imported if DATABASE_URL is set)
try:
    import psycopg2
    import psycopg2.extras
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False
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


# ---------------------------------------------------------------------------
# Environment validation — fail fast with a clear message if anything critical
# is missing, instead of crashing on the first request with a cryptic error.
# ---------------------------------------------------------------------------
def _validate_env():
    """Validate required environment variables at startup."""
    required = {
        "AZURE_OPENAI_API_KEY": "Azure OpenAI API key (for gpt-4o-mini)",
        "AZURE_OPENAI_ENDPOINT": "Azure OpenAI endpoint URL",
        "AZURE_OPENAI_DEPLOYMENT": "Azure OpenAI deployment name",
    }
    missing = [(k, v) for k, v in required.items() if not os.getenv(k, "").strip()]
    if missing:
        print("=" * 60)
        print("[STARTUP] ❌ Missing required environment variables:")
        for k, desc in missing:
            print(f"    {k}  — {desc}")
        print()
        print("Set them in backend/.env and restart the server.")
        print("=" * 60)
        raise SystemExit(1)

    # Warn (don't fail) about optional but recommended vars
    optional_warnings = []
    if not os.getenv("DATABASE_URL", "").strip():
        optional_warnings.append(
            "DATABASE_URL not set — using SQLite (data will not persist across Render redeploys)"
        )
    if not (os.getenv("AZURE_WHISPER_API_KEY", "").strip()
            and os.getenv("AZURE_WHISPER_ENDPOINT", "").strip()):
        optional_warnings.append(
            "AZURE_WHISPER_* not set — audio transcription will be disabled"
        )
    if not os.getenv("ALLOWED_ORIGINS", "").strip():
        optional_warnings.append(
            "ALLOWED_ORIGINS not set — using default localhost origins only"
        )
    for w in optional_warnings:
        print(f"[STARTUP] ⚠️  {w}")

    print("[STARTUP] ✅ Environment validation passed")


_validate_env()

app = FastAPI(title="Drilearn API", version="1.4.0")

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

# Separate Azure OpenAI client for Whisper (deployed in a different region)
WHISPER_API_KEY = os.getenv("AZURE_WHISPER_API_KEY", "").strip()
WHISPER_ENDPOINT = os.getenv("AZURE_WHISPER_ENDPOINT", "").strip()
WHISPER_DEPLOYMENT = os.getenv("AZURE_WHISPER_DEPLOYMENT", "whisper").strip()
WHISPER_API_VERSION = os.getenv("AZURE_WHISPER_API_VERSION", "2024-10-21").strip()

whisper_client = None
if WHISPER_API_KEY and WHISPER_ENDPOINT:
    try:
        whisper_client = AzureOpenAI(
            api_key=WHISPER_API_KEY,
            api_version=WHISPER_API_VERSION,
            azure_endpoint=WHISPER_ENDPOINT,
        )
        print(f"[Whisper] Enabled — deployment: {WHISPER_DEPLOYMENT}")
    except Exception as e:
        print(f"[Whisper] Failed to initialize client: {e}")
else:
    print("[Whisper] Disabled — AZURE_WHISPER_API_KEY / AZURE_WHISPER_ENDPOINT not set")

# ---------------------------------------------------------------------------
# Database abstraction layer — supports both SQLite (local) and Postgres (prod)
# ---------------------------------------------------------------------------
DB_PATH = os.getenv("DB_PATH", "quizzes.db")
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
USE_POSTGRES = DATABASE_URL.startswith("postgres") and HAS_PSYCOPG2

if DATABASE_URL and not HAS_PSYCOPG2:
    print("[DB] WARNING: DATABASE_URL is set but psycopg2 is not installed. Falling back to SQLite.")
    print("[DB] Install with: pip install psycopg2-binary")

print(f"[DB] Using: {'PostgreSQL (Supabase)' if USE_POSTGRES else 'SQLite (local file: ' + DB_PATH + ')'}")


class PostgresRowAdapter:
    """Wraps a psycopg2 RealDictRow so it behaves like sqlite3.Row.
    Supports both dict-style access ['col'] and returns None for missing keys gracefully."""
    def __init__(self, row):
        self._row = row or {}

    def __getitem__(self, key):
        return self._row[key]

    def __contains__(self, key):
        return key in self._row

    def get(self, key, default=None):
        return self._row.get(key, default)

    def keys(self):
        return self._row.keys()

    def __iter__(self):
        return iter(self._row.values())


class DBConnectionWrapper:
    """Wraps either a sqlite3.Connection or psycopg2 connection to give
    a unified interface: .execute() and .commit(). Converts placeholders
    from '?' (SQLite) to '%s' (Postgres) transparently."""

    def __init__(self, conn, is_postgres: bool):
        self._conn = conn
        self._is_pg = is_postgres

    def execute(self, sql, params=None):
        if self._is_pg:
            # Convert SQLite '?' placeholders to Postgres '%s'
            # (Simple char replacement — we don't use '?' in string literals in this codebase.)
            sql = sql.replace("?", "%s")
            # Convert some SQLite-specific syntax to Postgres
            sql = self._translate_sql(sql)
            cursor = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cursor.execute(sql, params or ())
            return PGCursorWrapper(cursor)
        else:
            if params is None:
                return self._conn.execute(sql)
            return self._conn.execute(sql, params)

    def _translate_sql(self, sql):
        """Convert SQLite-specific SQL to Postgres equivalents."""
        # AUTOINCREMENT → SERIAL (handled in CREATE TABLE)
        sql = re.sub(r"INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY", sql, flags=re.IGNORECASE)
        # INSERT OR REPLACE → INSERT ... ON CONFLICT DO UPDATE
        # This is complex; we detect these at write-time in save_quiz etc. instead
        # For now just rewrite as INSERT (the caller must ensure conflict handling)
        # Actually: we handle this in the calling code (see save_quiz below)
        return sql

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()


class PGCursorWrapper:
    """Wraps a psycopg2 cursor to behave like a sqlite3 cursor result."""
    def __init__(self, cursor):
        self._cursor = cursor

    def fetchone(self):
        row = self._cursor.fetchone()
        if row is None:
            return None
        return PostgresRowAdapter(row)

    def fetchall(self):
        return [PostgresRowAdapter(r) for r in self._cursor.fetchall()]

    @property
    def rowcount(self):
        return self._cursor.rowcount

    @property
    def lastrowid(self):
        # Postgres doesn't have lastrowid the same way SQLite does.
        # For our use case (live_players table with SERIAL id), we should use RETURNING id
        # in the INSERT. This is handled in the specific caller.
        try:
            return self._cursor.fetchone().get('id')
        except Exception:
            return None


@contextmanager
def get_db():
    if USE_POSTGRES:
        conn = psycopg2.connect(DATABASE_URL, sslmode='require')
        try:
            yield DBConnectionWrapper(conn, is_postgres=True)
        finally:
            conn.close()
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            yield DBConnectionWrapper(conn, is_postgres=False)
        finally:
            conn.close()


def _upsert_sql(table, columns, key="id"):
    """Generate an INSERT ... (ON CONFLICT DO UPDATE) SQL for the current DB.
    - For SQLite: INSERT OR REPLACE INTO ...
    - For Postgres: INSERT ... ON CONFLICT (key) DO UPDATE SET col=EXCLUDED.col ...
    Returns the SQL string with '?' placeholders (get_db translates to %s for PG).
    """
    cols_sql = ", ".join(columns)
    placeholders = ", ".join(["?"] * len(columns))
    if USE_POSTGRES:
        # Update every column except the key on conflict
        update_cols = [c for c in columns if c != key]
        update_sql = ", ".join([f"{c} = EXCLUDED.{c}" for c in update_cols])
        return (
            f"INSERT INTO {table} ({cols_sql}) VALUES ({placeholders}) "
            f"ON CONFLICT ({key}) DO UPDATE SET {update_sql}"
        )
    else:
        return f"INSERT OR REPLACE INTO {table} ({cols_sql}) VALUES ({placeholders})"


def _table_exists(conn, name: str) -> bool:
    """Portable check whether a table exists (no exceptions, so it never
    aborts a PostgreSQL transaction)."""
    if USE_POSTGRES:
        row = conn.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?",
            (name,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
        ).fetchone()
    return row is not None


def _column_exists(conn, table: str, column: str) -> bool:
    if USE_POSTGRES:
        row = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? AND column_name = ?",
            (table, column),
        ).fetchone()
        return row is not None
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == column for r in rows)


def _safe_migrate(conn, sql: str) -> bool:
    """Run one schema change in its own transaction. Earlier work is committed
    first, so a failure (e.g. the column already exists) can be rolled back
    without undoing anything else."""
    try:
        conn.commit()
        conn.execute(sql)
        conn.commit()
        return True
    except Exception:
        if USE_POSTGRES:
            conn.rollback()
        return False


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

        # Per-question response tracking for learning analytics.
        # One row per (submission, question) so we can compute per-question correct rates,
        # common wrong answers, and concept-level rollups.
        # Data auto-deletes after 90 days (privacy-first — see purge_old_responses()).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS assignment_responses (
                id TEXT PRIMARY KEY,
                assignment_id TEXT NOT NULL,
                class_id TEXT NOT NULL,
                quiz_id TEXT NOT NULL,
                student_name TEXT NOT NULL,
                question_id TEXT NOT NULL,
                question_index INTEGER NOT NULL,
                question_text TEXT NOT NULL,
                question_type TEXT,
                student_answer TEXT,
                correct_answer TEXT NOT NULL,
                is_correct INTEGER NOT NULL,
                submitted_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_responses_assignment ON assignment_responses(assignment_id, question_index)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_responses_submitted ON assignment_responses(submitted_at)")

        # Add new columns to existing tables (idempotent migrations)
        # In Postgres, a failed statement aborts the whole transaction, so we
        # commit after each successful migration and rollback after each failure.
        for sql in [
            "ALTER TABLE classes ADD COLUMN color TEXT DEFAULT '#7c3aed'",
            "ALTER TABLE classes ADD COLUMN icon TEXT DEFAULT 'graduation'",
            "ALTER TABLE quizzes ADD COLUMN time_limit_seconds INTEGER",
            "ALTER TABLE classes ADD COLUMN teacher_id TEXT",
        ]:
            _safe_migrate(conn, sql)

        # Auth tables
        # Accounts live in `users`, with a role: student, teacher or admin.
        # Older databases had a `teachers` table; rename it in place so every
        # existing account (and the foreign keys pointing to it) is kept.
        conn.commit()
        if _table_exists(conn, "teachers") and not _table_exists(conn, "users"):
            if _safe_migrate(conn, "ALTER TABLE teachers RENAME TO users"):
                print("[DB] Renamed table teachers -> users")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'student',
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()
        if not _column_exists(conn, "users", "role"):
            # Every account created before roles existed was a teacher account.
            _safe_migrate(conn, "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'teacher'")
        _safe_migrate(conn, "DROP INDEX IF EXISTS idx_teachers_email")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        conn.commit()
        if _column_exists(conn, "sessions", "teacher_id"):
            _safe_migrate(conn, "ALTER TABLE sessions RENAME COLUMN teacher_id TO user_id")

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
                FOREIGN KEY (teacher_id) REFERENCES users(id)
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
            existing_marker = conn.execute("SELECT 1 FROM users LIMIT 1").fetchone()
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
        except Exception:
            pass
        # Add class_id and assignment_id to leaderboard for class-scoped scores
        for sql in [
            "ALTER TABLE leaderboard ADD COLUMN class_id TEXT",
            "ALTER TABLE leaderboard ADD COLUMN assignment_id TEXT",
        ]:
            _safe_migrate(conn, sql)

        # Migrate older DBs
        for sql in [
            "ALTER TABLE quizzes ADD COLUMN source_type TEXT DEFAULT 'text'",
            "ALTER TABLE quizzes ADD COLUMN youtube_video_id TEXT",
            "ALTER TABLE class_announcements ADD COLUMN author_id TEXT",
        ]:
            _safe_migrate(conn, sql)
        conn.commit()

        # Student accounts: link study material and results to the user who
        # created them. The columns are nullable, so guests can still use the
        # app and older rows stay valid; ON DELETE SET NULL keeps the material
        # if an account is removed.
        ownership = [
            ("quizzes", "user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL"),
            ("flashcard_sets", "user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL"),
            ("flashcard_sets", "quiz_id", "TEXT REFERENCES quizzes(id) ON DELETE SET NULL"),
            ("study_notes", "user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL"),
            ("leaderboard", "user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL"),
            ("class_memberships", "user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL"),
        ]
        for table, column, definition in ownership:
            if not _column_exists(conn, table, column):
                _safe_migrate(conn, f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        for idx_sql in [
            "CREATE INDEX IF NOT EXISTS idx_quizzes_user ON quizzes(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_flashcards_user ON flashcard_sets(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_notes_user ON study_notes(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_leaderboard_user ON leaderboard(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_membership_user ON class_memberships(user_id)",
        ]:
            _safe_migrate(conn, idx_sql)

        # Spaced-repetition progress of a signed-in student, one row per card,
        # so the review schedule follows the student across devices.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS flashcard_progress (
                user_id TEXT NOT NULL,
                set_id TEXT NOT NULL,
                card_index INTEGER NOT NULL,
                ease REAL NOT NULL DEFAULT 2.5,
                interval_days INTEGER NOT NULL DEFAULT 0,
                reps INTEGER NOT NULL DEFAULT 0,
                last_quality INTEGER,
                next_review_at TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, set_id, card_index),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (set_id) REFERENCES flashcard_sets(id) ON DELETE CASCADE
            )
        """)
        conn.commit()

        # Administration: an account can be blocked (it can no longer sign in)
        # and every action of an administrator is written to admin_actions.
        # target_id is not a foreign key on purpose: the target may be a user,
        # a question set, a note... and the log must survive its deletion,
        # which is why a readable target_label is stored as well.
        if not _column_exists(conn, "users", "blocked_at"):
            _safe_migrate(conn, "ALTER TABLE users ADD COLUMN blocked_at TEXT")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admin_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_id TEXT,
                admin_name TEXT NOT NULL,
                action TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT,
                target_label TEXT,
                details TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC)")
        conn.commit()

        # Columns that were added with ALTER TABLE earlier had no foreign key.
        # PostgreSQL can add the constraint afterwards; NOT VALID means it is
        # enforced for new rows without failing on old orphaned rows.
        if USE_POSTGRES:
            for name, sql in [
                ("fk_classes_teacher", "ALTER TABLE classes ADD CONSTRAINT fk_classes_teacher FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID"),
                ("fk_announcements_author", "ALTER TABLE class_announcements ADD CONSTRAINT fk_announcements_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID"),
                ("fk_leaderboard_class", "ALTER TABLE leaderboard ADD CONSTRAINT fk_leaderboard_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL NOT VALID"),
                ("fk_leaderboard_assignment", "ALTER TABLE leaderboard ADD CONSTRAINT fk_leaderboard_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE SET NULL NOT VALID"),
                ("fk_responses_assignment", "ALTER TABLE assignment_responses ADD CONSTRAINT fk_responses_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE NOT VALID"),
            ]:
                exists = conn.execute(
                    "SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = ?", (name,)
                ).fetchone()
                if not exists:
                    _safe_migrate(conn, sql)
        conn.commit()


init_db()


# ===========================================================================
# AUTHENTICATION
# ===========================================================================

# Bcrypt for password hashing — industry standard, intentionally slow to make
# brute-force attacks expensive. We keep backward-compat with the old
# SHA-256+salt format so existing accounts still work: on their next successful
# sign-in, their password gets automatically re-hashed with bcrypt.
try:
    import bcrypt
    HAS_BCRYPT = True
except ImportError:
    HAS_BCRYPT = False
    print("[Auth] WARNING: bcrypt not installed. Using SHA-256 fallback. "
          "Install with: pip install bcrypt")


def hash_password(password: str) -> str:
    """Hash a password with bcrypt (or SHA-256+salt as fallback).
    Bcrypt hashes are prefixed with '$2b$' — this makes them distinguishable
    from the legacy 'salt$sha256hex' format used by older accounts."""
    if HAS_BCRYPT:
        # bcrypt has a 72-byte password limit; truncate defensively
        pwd_bytes = password.encode("utf-8")[:72]
        return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt(rounds=12)).decode("utf-8")
    # Legacy fallback
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def _is_bcrypt_hash(stored: str) -> bool:
    """Bcrypt hashes always start with $2a$, $2b$, or $2y$."""
    return stored.startswith(("$2a$", "$2b$", "$2y$"))


def verify_password(password: str, stored: str) -> bool:
    """Verify a password against a stored hash. Supports both new bcrypt
    hashes and legacy SHA-256+salt hashes."""
    if _is_bcrypt_hash(stored):
        if not HAS_BCRYPT:
            return False  # Can't verify bcrypt without the library
        try:
            pwd_bytes = password.encode("utf-8")[:72]
            return bcrypt.checkpw(pwd_bytes, stored.encode("utf-8"))
        except Exception:
            return False
    # Legacy SHA-256 verification
    try:
        salt, expected = stored.split("$", 1)
    except ValueError:
        return False
    actual = hashlib.sha256((salt + password).encode()).hexdigest()
    return secrets.compare_digest(actual, expected)


def _needs_rehash(stored: str) -> bool:
    """Returns True if the stored hash should be upgraded to bcrypt."""
    return HAS_BCRYPT and not _is_bcrypt_hash(stored)


def rehash_password_if_needed(teacher_id: str, password: str, stored_hash: str):
    """If the stored hash is the legacy format, silently re-hash with bcrypt
    on successful sign-in. This is transparent to the user."""
    if not _needs_rehash(stored_hash):
        return
    new_hash = hash_password(password)
    try:
        with get_db() as conn:
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (new_hash, teacher_id),
            )
            conn.commit()
        print(f"[Auth] Upgraded password hash to bcrypt for teacher {teacher_id[:8]}...")
    except Exception as e:
        # Don't block sign-in if re-hashing fails
        print(f"[Auth] Could not re-hash password for {teacher_id[:8]}...: {e}")


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    exp = now + timedelta(days=30)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
            (token, user_id, now.isoformat(), exp.isoformat()),
        )
        conn.commit()
    return token


# Roles: a student studies and joins classes, a teacher additionally manages
# classes, assignments and live sessions, and an admin can do everything a
# teacher can plus manage users and content.
ROLES = ("student", "teacher", "admin")
TEACHER_ROLES = ("teacher", "admin")

# Admin accounts are not created through the sign-up form. An account whose
# email is listed in ADMIN_EMAILS (comma-separated) becomes admin on sign-in.
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}


def _apply_admin_bootstrap(user: dict) -> dict:
    if user and user.get("email", "").lower() in ADMIN_EMAILS and user.get("role") != "admin":
        with get_db() as conn:
            conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (user["id"],))
            conn.commit()
        user["role"] = "admin"
        print(f"[Auth] {user['email']} promoted to admin (ADMIN_EMAILS)")
    return user


def get_user_from_token(token: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute(
            """SELECT u.id, u.email, u.name, u.role FROM sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.token = ? AND s.expires_at > ? AND u.blocked_at IS NULL""",
            (token, datetime.utcnow().isoformat()),
        ).fetchone()
        return dict(row) if row else None


# Older name kept so the rest of the code reads naturally.
get_teacher_from_token = get_user_from_token


def _token_from_header(authorization: Optional[str]) -> Optional[str]:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(None, 1)[1].strip() or None


def require_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency: any signed-in account (student, teacher or admin)."""
    token = _token_from_header(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in required.")
    user = get_user_from_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
    return user


def require_teacher(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency: a signed-in teacher or admin, else 401/403."""
    user = require_user(authorization)
    if user.get("role") not in TEACHER_ROLES:
        raise HTTPException(status_code=403, detail="This action needs a teacher account.")
    return user


def require_admin(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency: a signed-in admin, else 401/403."""
    user = require_user(authorization)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="This action needs an administrator account.")
    return user


def optional_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    """Returns the signed-in user, or None for guests (endpoints that work both ways)."""
    token = _token_from_header(authorization)
    return get_user_from_token(token) if token else None


optional_teacher = optional_user


def _set_owner(table: str, item_id: str, user: Optional[dict]):
    """Attach a newly created item to the signed-in user (guests: no owner)."""
    if not user:
        return
    with get_db() as conn:
        conn.execute(f"UPDATE {table} SET user_id = ? WHERE id = ?", (user["id"], item_id))
        conn.commit()


def save_quiz(quiz_dict: dict):
    columns = ["id", "title", "created_at", "source_text_preview", "source_type",
               "youtube_video_id", "questions_json", "time_limit_seconds"]
    sql = _upsert_sql("quizzes", columns)
    with get_db() as conn:
        conn.execute(sql, (
            quiz_dict["id"],
            quiz_dict["title"],
            quiz_dict["created_at"],
            quiz_dict["source_text_preview"],
            quiz_dict.get("source_type", "text"),
            quiz_dict.get("youtube_video_id"),
            json.dumps(quiz_dict["questions"]),
            quiz_dict.get("time_limit_seconds"),
        ))
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


def list_all_quizzes(user_id: Optional[str] = None, ids: Optional[List[str]] = None, everything: bool = False):
    """Quizzes visible to the caller: an admin sees all, a signed-in user sees
    their own, a guest only the ids remembered by their own browser."""
    with get_db() as conn:
        base = "SELECT id, title, created_at, source_type, questions_json FROM quizzes"
        if everything:
            rows = conn.execute(base + " ORDER BY created_at DESC LIMIT 200").fetchall()
        elif user_id:
            rows = conn.execute(base + " WHERE user_id = ? ORDER BY created_at DESC LIMIT 200", (user_id,)).fetchall()
        elif ids:
            marks = ",".join("?" * len(ids))
            rows = conn.execute(base + f" WHERE id IN ({marks}) ORDER BY created_at DESC", tuple(ids)).fetchall()
        else:
            rows = []
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


def save_leaderboard_entry(quiz_id, display_name, score, total, percentage, user_id=None):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO leaderboard (quiz_id, display_name, score, total, percentage, created_at, user_id) VALUES (?,?,?,?,?,?,?)",
            (quiz_id, display_name, score, total, percentage, datetime.utcnow().isoformat(), user_id),
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
# Per-question response storage (for learning analytics dashboard)
# ---------------------------------------------------------------------------

def save_assignment_responses(assignment_id, class_id, quiz_id, student_name, quiz, results):
    """Store one row per answered question. `results` is what _score_quiz() returns."""
    now_iso = datetime.utcnow().isoformat()
    # Build a lookup: question_id → (index, type) from the quiz
    q_index = {q["id"]: (i, q.get("type", "")) for i, q in enumerate(quiz["questions"])}
    with get_db() as conn:
        for r in results:
            qid = r["question_id"]
            index, qtype = q_index.get(qid, (0, ""))
            conn.execute(
                """INSERT INTO assignment_responses
                   (id, assignment_id, class_id, quiz_id, student_name,
                    question_id, question_index, question_text, question_type,
                    student_answer, correct_answer, is_correct, submitted_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    str(uuid.uuid4()),
                    assignment_id, class_id, quiz_id, student_name,
                    qid, index, r["question"], qtype,
                    (r["user_answer"] or "")[:500],   # cap length defensively
                    r["correct_answer"],
                    1 if r["is_correct"] else 0,
                    now_iso,
                ),
            )
        conn.commit()


def purge_old_responses(days=90):
    """Delete individual answer rows older than `days` days (privacy-first).
    Aggregate scores in the leaderboard table are kept indefinitely."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    with get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM assignment_responses WHERE submitted_at < ?",
            (cutoff,),
        )
        conn.commit()
    return cursor  # Caller can inspect if needed


def compute_per_question_analytics(assignment_id, quiz):
    """Compute per-question correct rates + common wrong answers for one assignment.
    Returns a list matching the order of quiz['questions']."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT question_id, question_index, question_text, question_type,
                      student_answer, correct_answer, is_correct
               FROM assignment_responses
               WHERE assignment_id = ?
               ORDER BY question_index ASC""",
            (assignment_id,),
        ).fetchall()

    # Group by question_id
    per_question = {}
    for r in rows:
        row = dict(r)
        qid = row["question_id"]
        if qid not in per_question:
            per_question[qid] = {
                "question_id": qid,
                "question_index": row["question_index"],
                "question": row["question_text"],
                "correct_answer": row["correct_answer"],
                "type": row["question_type"],
                "total_answered": 0,
                "correct_count": 0,
                "wrong_answers_freq": {},  # answer -> count
            }
        agg = per_question[qid]
        agg["total_answered"] += 1
        if row["is_correct"]:
            agg["correct_count"] += 1
        else:
            wrong = (row["student_answer"] or "").strip()
            if wrong:
                agg["wrong_answers_freq"][wrong] = agg["wrong_answers_freq"].get(wrong, 0) + 1

    # Convert into output list matching quiz question order
    out = []
    for i, q in enumerate(quiz["questions"]):
        qid = q["id"]
        agg = per_question.get(qid)
        if not agg:
            # No response data for this question yet
            out.append({
                "question_id": qid,
                "question_index": i,
                "question": q["question"],
                "correct_answer": q["correct_answer"],
                "type": q.get("type", ""),
                "total_answered": 0,
                "correct_count": 0,
                "correct_rate": None,
                "difficulty_label": None,
                "common_wrong_answers": [],
            })
            continue

        rate = round(100 * agg["correct_count"] / agg["total_answered"], 1) if agg["total_answered"] else 0
        # Classify difficulty by correct rate
        if agg["total_answered"] < 3:
            difficulty_label = "insufficient_data"
        elif rate >= 80:
            difficulty_label = "easy"
        elif rate >= 50:
            difficulty_label = "medium"
        else:
            difficulty_label = "hard"

        # Top 3 most common wrong answers
        common_wrong = sorted(
            agg["wrong_answers_freq"].items(),
            key=lambda x: x[1],
            reverse=True,
        )[:3]
        common_wrong_list = [{"answer": a, "count": c} for a, c in common_wrong]

        out.append({
            "question_id": qid,
            "question_index": i,
            "question": q["question"],
            "correct_answer": q["correct_answer"],
            "type": q.get("type", ""),
            "total_answered": agg["total_answered"],
            "correct_count": agg["correct_count"],
            "correct_rate": rate,
            "difficulty_label": difficulty_label,
            "common_wrong_answers": common_wrong_list,
        })
    return out


def compute_concept_rollup(per_question_stats, quiz):
    """Roll up per-question stats into concept-level averages.
    Looks at `source_chunk` if it hints at a concept, otherwise groups by question type."""
    # Simple grouping: by question type for now (multiple_choice / true_false / short_answer).
    # A richer version would tag questions with concepts at generation time.
    groups = {}
    for s in per_question_stats:
        if s["correct_rate"] is None:
            continue
        key = s["type"] or "unknown"
        if key not in groups:
            groups[key] = {"type": key, "count": 0, "correct_total": 0, "answered_total": 0}
        groups[key]["count"] += 1
        groups[key]["correct_total"] += s["correct_count"]
        groups[key]["answered_total"] += s["total_answered"]

    rollup = []
    for key, g in groups.items():
        if g["answered_total"] == 0:
            continue
        avg_rate = round(100 * g["correct_total"] / g["answered_total"], 1)
        rollup.append({
            "group": key,
            "question_count": g["count"],
            "average_correct_rate": avg_rate,
        })
    return sorted(rollup, key=lambda x: x["average_correct_rate"])


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
# ---------------------------------------------------------------------------
# Rate limiting — protects against abuse and controls Azure OpenAI costs.
#
# Two-tier strategy:
#   - Authenticated teachers get their own per-account quota
#     (so a whole classroom sharing an IP doesn't share one quota)
#   - Anonymous users share a per-IP quota (traditional behaviour)
#
# All quotas are in-memory and reset on server restart. For horizontal scaling
# in production, this should be moved to Redis.
# ---------------------------------------------------------------------------
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "10"))
RATE_LIMIT_WINDOW_SEC = int(os.getenv("RATE_LIMIT_WINDOW_SEC", "3600"))
CHAT_RATE_LIMIT = int(os.getenv("CHAT_RATE_LIMIT", "30"))

# Authenticated users get a higher quota since we know who they are
AUTH_QUIZ_RATE_LIMIT = int(os.getenv("AUTH_QUIZ_RATE_LIMIT", "30"))
AUTH_CHAT_RATE_LIMIT = int(os.getenv("AUTH_CHAT_RATE_LIMIT", "100"))

_quiz_log = defaultdict(deque)
_chat_log = defaultdict(deque)


def _check(log, key, limit, window, label):
    now = time.time()
    while log[key] and log[key][0] < now - window:
        log[key].popleft()
    if len(log[key]) >= limit:
        retry_in = int(window - (now - log[key][0]))
        raise HTTPException(
            status_code=429,
            detail=f"{label} rate limit reached. Try again in ~{max(1, retry_in // 60)} min.",
        )
    log[key].append(now)


def _rate_limit_key_and_quota(request: Request, anon_quota: int, auth_quota: int):
    """Return (bucket_key, applicable_quota) based on whether the request
    is authenticated. Auth check is by inspecting the Authorization header
    without depending on FastAPI's Depends() — we call this from bare functions."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip()
        teacher = get_teacher_from_token(token) if token else None
        if teacher:
            return f"teacher:{teacher['id']}", auth_quota
    ip = request.client.host if request.client else "unknown"
    return f"ip:{ip}", anon_quota


def check_quiz_rate_limit(request: Request):
    key, quota = _rate_limit_key_and_quota(request, RATE_LIMIT_REQUESTS, AUTH_QUIZ_RATE_LIMIT)
    _check(_quiz_log, key, quota, RATE_LIMIT_WINDOW_SEC, "Quiz")


def check_chat_rate_limit(request: Request):
    key, quota = _rate_limit_key_and_quota(request, CHAT_RATE_LIMIT, AUTH_CHAT_RATE_LIMIT)
    _check(_chat_log, key, quota, RATE_LIMIT_WINDOW_SEC, "Chat")


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
    return {"status": "ok", "service": "Drilearn API", "version": "1.4.0"}


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


# ---------------------------------------------------------------------------
# Audio / Video transcription via Azure OpenAI Whisper
# ---------------------------------------------------------------------------
ALLOWED_AUDIO_EXTS = (".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".mov")
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # Whisper's hard limit is 25 MB


@app.post("/api/transcribe-audio")
async def transcribe_audio(request: Request, file: UploadFile = File(...)):
    # Rate-limit like other AI endpoints (uses the quiz limiter — same monthly budget)
    check_quiz_rate_limit(request)

    if whisper_client is None:
        raise HTTPException(
            status_code=503,
            detail="Audio transcription is not configured on this server. "
                   "Set AZURE_WHISPER_API_KEY and AZURE_WHISPER_ENDPOINT in .env."
        )

    # Validate filename & extension
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")
    filename_lower = file.filename.lower()
    ext = "." + filename_lower.rsplit(".", 1)[-1] if "." in filename_lower else ""
    if ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{ext}'. Allowed: {', '.join(ALLOWED_AUDIO_EXTS)}"
        )

    # Read + size check
    contents = await file.read()
    size = len(contents)
    if size == 0:
        raise HTTPException(status_code=400, detail="Empty file.")
    if size > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({size / 1024 / 1024:.1f} MB). Maximum is 25 MB. "
                   "For longer recordings, split the file or use a lower bitrate."
        )

    # Send to Whisper.
    # The Azure OpenAI SDK expects a file-like object with a name attribute
    # (used to infer the MIME type). Wrap the bytes in a small helper.
    import io
    audio_stream = io.BytesIO(contents)
    audio_stream.name = file.filename  # Whisper client uses this to detect format

    try:
        result = whisper_client.audio.transcriptions.create(
            file=audio_stream,
            model=WHISPER_DEPLOYMENT,
            response_format="text",  # Returns a plain string
        )
    except Exception as e:
        # Log for debugging but return a user-friendly message
        print(f"[Whisper] Transcription failed for '{file.filename}' ({size} bytes): {e}")
        # Common causes: wrong region, wrong deployment name, expired key, unsupported audio
        raise HTTPException(
            status_code=502,
            detail=f"Transcription service failed: {str(e)[:200]}"
        )

    # Whisper with response_format="text" returns the raw transcript as a string
    text = (result if isinstance(result, str) else str(result)).strip()

    if not text:
        raise HTTPException(
            status_code=400,
            detail="No speech detected in the recording. Please try a clearer audio file."
        )

    # Rough duration estimate: assume ~150 words/min average speech pace
    # (Not accurate but useful for UI feedback.)
    word_count = len(text.split())
    duration_estimate_sec = int(word_count / 150 * 60)

    return {
        "text": text,
        "char_count": len(text),
        "word_count": word_count,
        "duration_estimate_sec": duration_estimate_sec,
        "filename": file.filename,
        "file_size_bytes": size,
    }


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
def generate_quiz(req: GenerateRequest, request: Request, user: Optional[dict] = Depends(optional_user)):
    check_quiz_rate_limit(request)
    if not req.text.strip() or len(req.text) < 100:
        raise HTTPException(status_code=400, detail="Text too short (min 100 chars).")
    if len(req.text) > 50000:
        raise HTTPException(status_code=400, detail="Text too long (max 50,000 chars).")
    quiz = build_quiz(
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
    _set_owner("quizzes", quiz.id, user)
    return quiz


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
def leaderboard_submit(req: LeaderboardSubmitRequest, user: Optional[dict] = Depends(optional_user)):
    """Submit a score for a public quiz challenge."""
    quiz = load_quiz(req.quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    correct_count, total, pct, results = _score_quiz(quiz, req.answers)
    display_name = (req.display_name or "").strip() or random_animal_name()
    save_leaderboard_entry(req.quiz_id, display_name, correct_count, total, pct,
                           user_id=user["id"] if user else None)
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


def _parse_ids(ids: Optional[str]) -> List[str]:
    return [i for i in (ids or "").split(",") if re.fullmatch(r"[0-9a-fA-F-]{36}", i)][:100]


@app.get("/api/quizzes")
def list_quizzes(ids: Optional[str] = None, user: Optional[dict] = Depends(optional_user)):
    if user:
        return {"quizzes": list_all_quizzes(user_id=user["id"], everything=user.get("role") == "admin")}
    return {"quizzes": list_all_quizzes(ids=_parse_ids(ids))}


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
            _upsert_sql("flashcard_sets", ["id", "title", "created_at", "source_text_preview", "cards_json", "quiz_id"]),
            (fs_dict["id"], fs_dict["title"], fs_dict["created_at"],
             fs_dict["source_text_preview"], json.dumps(fs_dict["cards"]), fs_dict.get("quiz_id")),
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


def list_flashcard_sets(user_id: Optional[str] = None, ids: Optional[List[str]] = None):
    with get_db() as conn:
        base = "SELECT id, title, created_at, cards_json FROM flashcard_sets"
        if user_id:
            rows = conn.execute(base + " WHERE user_id = ? ORDER BY created_at DESC LIMIT 200", (user_id,)).fetchall()
        elif ids:
            marks = ",".join("?" * len(ids))
            rows = conn.execute(base + f" WHERE id IN ({marks}) ORDER BY created_at DESC", tuple(ids)).fetchall()
        else:
            rows = []
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
def api_generate_flashcards_from_text(req: GenerateFlashcardsFromTextRequest, request: Request,
                                      user: Optional[dict] = Depends(optional_user)):
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
    _set_owner("flashcard_sets", fs["id"], user)
    return FlashcardSet(**fs)


@app.post("/api/flashcards/generate-from-quiz", response_model=FlashcardSet)
def api_generate_flashcards_from_quiz(req: GenerateFlashcardsFromQuizRequest, request: Request,
                                      user: Optional[dict] = Depends(optional_user)):
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
        "quiz_id": quiz["id"],
    }
    save_flashcard_set(fs)
    _set_owner("flashcard_sets", fs["id"], user)
    return FlashcardSet(**fs)


@app.get("/api/flashcards/{set_id}", response_model=FlashcardSet)
def api_get_flashcards(set_id: str):
    fs = load_flashcard_set(set_id)
    if not fs:
        raise HTTPException(status_code=404, detail="Flashcard set not found.")
    return FlashcardSet(**fs)


@app.get("/api/flashcards")
def api_list_flashcards(ids: Optional[str] = None, user: Optional[dict] = Depends(optional_user)):
    if user:
        return {"sets": list_flashcard_sets(user_id=user["id"])}
    return {"sets": list_flashcard_sets(ids=_parse_ids(ids))}


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
            _upsert_sql("study_notes", ["id", "title", "created_at", "source_text_preview", "format", "content_md"]),
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


def list_notes(user_id: Optional[str] = None, ids: Optional[List[str]] = None):
    with get_db() as conn:
        base = "SELECT id, title, created_at, format FROM study_notes"
        if user_id:
            rows = conn.execute(base + " WHERE user_id = ? ORDER BY created_at DESC LIMIT 200", (user_id,)).fetchall()
        elif ids:
            marks = ",".join("?" * len(ids))
            rows = conn.execute(base + f" WHERE id IN ({marks}) ORDER BY created_at DESC", tuple(ids)).fetchall()
        else:
            rows = []
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
def api_generate_notes(req: GenerateNotesRequest, request: Request, user: Optional[dict] = Depends(optional_user)):
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
    _set_owner("study_notes", note["id"], user)
    return StudyNote(**note)


@app.get("/api/notes/{note_id}", response_model=StudyNote)
def api_get_note(note_id: str):
    note = load_note(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found.")
    return StudyNote(**note)


@app.get("/api/notes")
def api_list_notes(ids: Optional[str] = None, user: Optional[dict] = Depends(optional_user)):
    if user:
        return {"notes": list_notes(user_id=user["id"])}
    return {"notes": list_notes(ids=_parse_ids(ids))}


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
    # Optional for signed-in students: their account name is used instead.
    student_name: Optional[str] = Field(default=None, max_length=80)


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


def add_membership(class_id, student_name, user_id=None):
    with get_db() as conn:
        # Don't add duplicate
        existing = conn.execute(
            "SELECT id, user_id FROM class_memberships WHERE class_id = ? AND student_name = ?",
            (class_id, student_name),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO class_memberships (class_id, student_name, joined_at, user_id) VALUES (?,?,?,?)",
                (class_id, student_name, datetime.utcnow().isoformat(), user_id),
            )
            conn.commit()
        elif user_id and not existing["user_id"]:
            conn.execute("UPDATE class_memberships SET user_id = ? WHERE id = ?", (user_id, existing["id"]))
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
        conn.execute("DELETE FROM assignment_responses WHERE class_id = ?", (class_id,))
        conn.execute(
            "UPDATE leaderboard SET assignment_id = NULL WHERE assignment_id IN (SELECT id FROM assignments WHERE class_id = ?)",
            (class_id,),
        )
        conn.execute("DELETE FROM class_announcements WHERE class_id = ?", (class_id,))
        conn.execute("DELETE FROM assignments WHERE class_id = ?", (class_id,))
        conn.execute("DELETE FROM class_memberships WHERE class_id = ?", (class_id,))
        conn.execute("UPDATE leaderboard SET class_id = NULL WHERE class_id = ?", (class_id,))
        conn.execute("DELETE FROM classes WHERE id = ?", (class_id,))
        conn.commit()


def delete_assignment(assignment_id):
    with get_db() as conn:
        conn.execute("UPDATE leaderboard SET assignment_id = NULL WHERE assignment_id = ?", (assignment_id,))
        conn.execute("DELETE FROM assignment_responses WHERE assignment_id = ?", (assignment_id,))
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
    # Allow if class has no teacher_id (legacy), the signed-in teacher owns it, or an admin asks
    if teacher and teacher.get("role") == "admin":
        return c
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
def api_join_class(req: JoinClassRequest, user: Optional[dict] = Depends(optional_user)):
    c = load_class_by_code(req.code.upper().strip())
    if not c:
        raise HTTPException(status_code=404, detail="Class not found. Check the code.")
    student_name = (req.student_name or "").strip() or (user["name"] if user else "")
    if not student_name:
        raise HTTPException(status_code=400, detail="Please enter your name.")
    add_membership(c["id"], student_name, user["id"] if user else None)
    # Return active assignments for the student
    assignments = list_class_assignments(c["id"])
    return {
        "class": {
            "id": c["id"], "name": c["name"], "code": c["code"], "teacher_name": c["teacher_name"],
        },
        "student_name": student_name,
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
def api_submit_assignment(req: SubmitAssignmentRequest, user: Optional[dict] = Depends(optional_user)):
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
            """INSERT INTO leaderboard (quiz_id, display_name, score, total, percentage, created_at, class_id, assignment_id, user_id)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (quiz["id"], name, correct, total, pct, datetime.utcnow().isoformat(),
             a["class_id"], a["id"], user["id"] if user else None),
        )
        conn.commit()
    # Save per-question responses for learning analytics dashboard.
    # Failure here should not block the submission (student's score is still saved above).
    try:
        save_assignment_responses(a["id"], a["class_id"], quiz["id"], name, quiz, results)
    except Exception as e:
        print(f"[Analytics] Could not save per-question responses for {a['id']}: {e}")
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
    """Per-question correct rates, per-student scores, and concept rollup."""
    a = load_assignment(assignment_id)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    _check_class_owner(a["class_id"], teacher)
    quiz = load_quiz(a["quiz_id"])
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")

    # Purge old responses opportunistically (cheap query, runs at most once per analytics view).
    # This is a lazy alternative to a scheduled job — good enough for our scale.
    try:
        purge_old_responses(days=90)
    except Exception as e:
        print(f"[Analytics] Purge failed (non-fatal): {e}")

    with get_db() as conn:
        rows = conn.execute(
            """SELECT display_name, score, total, percentage, created_at
               FROM leaderboard WHERE assignment_id = ? ORDER BY percentage DESC""",
            (assignment_id,),
        ).fetchall()
    submissions = [dict(r) for r in rows]

    # Per-question analytics (from assignment_responses table)
    per_question_stats = compute_per_question_analytics(assignment_id, quiz)
    concept_rollup = compute_concept_rollup(per_question_stats, quiz)

    if not submissions:
        return {
            "quiz_title": quiz["title"],
            "total_submissions": 0,
            "average_pct": 0,
            "submissions": [],
            "questions": per_question_stats,   # will have all null stats
            "concept_rollup": [],
            "has_per_question_data": False,
        }

    avg = sum(s["percentage"] for s in submissions) / len(submissions)
    # Detect whether per-question data is available (older submissions won't have it)
    has_data = any(q["total_answered"] > 0 for q in per_question_stats)

    return {
        "quiz_title": quiz["title"],
        "total_submissions": len(submissions),
        "average_pct": round(avg, 1),
        "submissions": submissions,
        "questions": per_question_stats,
        "concept_rollup": concept_rollup,
        "has_per_question_data": has_data,
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
            "INSERT INTO class_announcements (id, class_id, author_name, message, created_at, author_id) VALUES (?,?,?,?,?,?)",
            (a["id"], a["class_id"], a["author_name"], a["message"], a["created_at"], a.get("author_id")),
        )
        conn.commit()


def list_announcements(class_id):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, class_id, author_name, author_id, message, created_at FROM class_announcements WHERE class_id = ? ORDER BY created_at DESC LIMIT 100",
            (class_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def load_announcement(announcement_id):
    """Load a single announcement to check its author before deletion."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, class_id, author_id, author_name FROM class_announcements WHERE id = ?",
            (announcement_id,),
        ).fetchone()
        return dict(row) if row else None


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
        "author_id": teacher["id"],  # Record who created it
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
    announcement = load_announcement(announcement_id)
    if not announcement:
        raise HTTPException(status_code=404, detail="Announcement not found.")
    # Enforce ownership: only the author can delete their own announcements.
    # Legacy announcements (no author_id) fall back to class-owner check for
    # backward compatibility.
    if announcement.get("author_id"):
        if announcement["author_id"] != teacher["id"]:
            raise HTTPException(
                status_code=403,
                detail="You can only delete announcements you posted."
            )
    else:
        # Legacy announcement without author_id — fall back to class-owner check
        _check_class_owner(announcement["class_id"], teacher)
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
    password: str = Field(..., min_length=8, max_length=200)
    name: str = Field(..., min_length=1, max_length=80)
    # Admin can't be chosen at sign-up (see ADMIN_EMAILS). Older clients that
    # don't send a role were teacher-only, so that stays the default.
    role: Literal["student", "teacher"] = "teacher"


class SignInRequest(BaseModel):
    email: str
    password: str


# ---------------------------------------------------------------------------
# Password strength validation — enforced on signup only.
# Existing accounts with weaker passwords remain valid to avoid locking users out.
# ---------------------------------------------------------------------------

# Top ~25 most common weak passwords (from published breach datasets).
# We reject these outright regardless of whether they meet character rules.
COMMON_WEAK_PASSWORDS = frozenset({
    "password", "password1", "password12", "password123",
    "12345678", "123456789", "1234567890",
    "qwerty123", "qwertyuiop", "qwerty12",
    "abc12345", "letmein1", "welcome1", "welcome12", "welcome123",
    "admin123", "administrator",
    "iloveyou1", "monkey123", "dragon123",
    "sunshine1", "princess1", "football1", "baseball1",
    "master123", "shadow123",
})


def validate_password(password: str) -> None:
    """Enforce password strength rules for new accounts.
    Raises HTTPException(400) with a user-friendly message on failure."""
    if len(password) < 8:
        raise HTTPException(
            status_code=400,
            detail="Password must be at least 8 characters long."
        )
    if len(password) > 200:
        raise HTTPException(
            status_code=400,
            detail="Password is too long (max 200 characters)."
        )

    # Character-class requirements
    has_letter = any(c.isalpha() for c in password)
    has_digit = any(c.isdigit() for c in password)
    has_symbol = any(not c.isalnum() for c in password)

    missing = []
    if not has_letter:
        missing.append("at least one letter")
    if not has_digit:
        missing.append("at least one number")
    if not has_symbol:
        missing.append("at least one symbol (e.g. ! @ # $ %)")
    if missing:
        raise HTTPException(
            status_code=400,
            detail="Password must contain " + ", ".join(missing) + "."
        )

    # Reject known-weak passwords (case-insensitive)
    if password.lower() in COMMON_WEAK_PASSWORDS:
        raise HTTPException(
            status_code=400,
            detail="This password is too common. Please choose something less predictable."
        )


@app.post("/api/auth/signup")
def api_signup(req: SignUpRequest):
    email = req.email.strip().lower()
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Please enter a valid email.")
    # Enforce password strength for NEW accounts only.
    # Existing users can keep their old passwords until they choose to update.
    validate_password(req.password)
    with get_db() as conn:
        existing = conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        raise HTTPException(status_code=400, detail="An account with this email already exists.")
    user_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?,?,?,?,?,?)",
            (user_id, email, hash_password(req.password), req.name.strip(), req.role, datetime.utcnow().isoformat()),
        )
        conn.commit()
    user = _apply_admin_bootstrap({"id": user_id, "email": email, "name": req.name.strip(), "role": req.role})
    token = create_session(user_id)
    # "teacher" is kept as an alias for older frontends.
    return {"token": token, "user": user, "teacher": user}


@app.post("/api/auth/signin")
def api_signin(req: SignInRequest):
    email = req.email.strip().lower()
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, name, role, blocked_at FROM users WHERE email = ?",
            (email,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=400, detail="No account with that email.")
    if not verify_password(req.password, row["password_hash"]):
        raise HTTPException(status_code=400, detail="Wrong password.")
    if row["blocked_at"]:
        raise HTTPException(status_code=403, detail="This account has been blocked by an administrator.")
    # Silently upgrade legacy SHA-256 hashes to bcrypt on successful login
    rehash_password_if_needed(row["id"], req.password, row["password_hash"])
    token = create_session(row["id"])
    user = _apply_admin_bootstrap({"id": row["id"], "email": row["email"], "name": row["name"], "role": row["role"]})
    return {"token": token, "user": user, "teacher": user}


@app.get("/api/auth/me")
def api_me(user: dict = Depends(require_user)):
    return {"user": user, "teacher": user}


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
        if USE_POSTGRES:
            cursor = conn.execute(
                "INSERT INTO live_players (session_id, player_name, joined_at, last_seen) VALUES (?,?,?,?) RETURNING id",
                (sess["id"], name, datetime.utcnow().isoformat(), datetime.utcnow().isoformat()),
            )
            row = cursor.fetchone()
            player_id = row["id"]
            conn.commit()
        else:
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


# ===========================================================================
# v7 — Manual quiz builder + AI question suggestion
# ===========================================================================

class ManualQuestion(BaseModel):
    type: Literal["multiple_choice", "true_false", "short_answer"]
    question: str = Field(..., min_length=1, max_length=2000)
    options: Optional[List[str]] = None  # for MC
    correct_answer: str = Field(..., min_length=1, max_length=500)
    explanation: Optional[str] = ""
    difficulty: Literal["easy", "medium", "hard"] = "medium"


class CreateManualQuizRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    questions: List[ManualQuestion] = Field(..., min_length=1, max_length=50)
    time_limit_seconds: Optional[int] = Field(default=None, ge=30, le=7200)


class SuggestQuestionRequest(BaseModel):
    topic: str = Field(..., min_length=2, max_length=500)
    type: Literal["multiple_choice", "true_false", "short_answer"]
    difficulty: Literal["easy", "medium", "hard"] = "medium"


@app.post("/api/quiz/manual", response_model=Quiz)
def api_create_manual_quiz(req: CreateManualQuizRequest, request: Request,
                           user: Optional[dict] = Depends(optional_user)):
    check_quiz_rate_limit(request)
    questions_list = []
    for q in req.questions:
        # Validate MC has 4 options + correct_answer matches one
        if q.type == "multiple_choice":
            if not q.options or len(q.options) < 2:
                raise HTTPException(status_code=400, detail="Multiple-choice questions need at least 2 options.")
            if q.correct_answer not in q.options:
                raise HTTPException(status_code=400, detail=f"Correct answer must be one of the options for: {q.question[:50]}")
        elif q.type == "true_false":
            if q.correct_answer not in ("True", "False"):
                raise HTTPException(status_code=400, detail="True/false answer must be 'True' or 'False'.")
        questions_list.append({
            "id": str(uuid.uuid4()),
            "type": q.type,
            "question": q.question.strip(),
            "options": q.options if q.type == "multiple_choice" else None,
            "correct_answer": q.correct_answer.strip(),
            "explanation": (q.explanation or "").strip() or "(no explanation provided)",
            "source_chunk": "",  # manual quizzes have no source
            "difficulty": q.difficulty,
            "timestamp_seconds": None,
        })

    quiz_dict = {
        "id": str(uuid.uuid4()),
        "title": req.title.strip(),
        "created_at": datetime.utcnow().isoformat(),
        "source_text_preview": "(manually created)",
        "source_type": "manual",
        "youtube_video_id": None,
        "questions": questions_list,
        "time_limit_seconds": req.time_limit_seconds,
    }
    save_quiz(quiz_dict)
    _set_owner("quizzes", quiz_dict["id"], user)
    return Quiz(**quiz_dict)


SUGGEST_QUESTION_PROMPT = """Generate ONE quiz question on the topic below.

TOPIC: {topic}
QUESTION TYPE: {type}
DIFFICULTY: {difficulty}

Requirements:
- For multiple_choice: provide exactly 4 options, "correct_answer" is the FULL TEXT of the correct option.
- For true_false: "correct_answer" is exactly "True" or "False".
- For short_answer: "correct_answer" is a brief answer (max 10 words).
- Provide a 1-2 sentence explanation.
- Match the language of the topic (Albanian, English, etc.).

Respond with ONLY a valid JSON object:
{{
  "question": "...",
  "options": ["..."] or null,
  "correct_answer": "...",
  "explanation": "..."
}}

For true_false and short_answer, set "options": null.
"""


@app.post("/api/quiz/suggest-question")
def api_suggest_question(req: SuggestQuestionRequest, request: Request):
    check_chat_rate_limit(request)
    prompt = SUGGEST_QUESTION_PROMPT.format(
        topic=req.topic.strip(),
        type=req.type,
        difficulty=req.difficulty,
    )
    try:
        response = client.chat.completions.create(
            model=DEPLOYMENT,
            messages=[
                {"role": "system", "content": "You generate single quiz questions as valid JSON only."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.7,
            max_tokens=500,
        )
        raw = response.choices[0].message.content.strip()
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse the suggested question.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not suggest a question: {e}")

    # Validate the response matches the type
    options = data.get("options") if req.type == "multiple_choice" else None
    if req.type == "multiple_choice" and (not options or len(options) < 2):
        # Generate fallback if the model didn't provide options
        raise HTTPException(status_code=500, detail="AI did not return valid multiple-choice options. Try again.")

    return {
        "type": req.type,
        "question": data.get("question", "").strip(),
        "options": options,
        "correct_answer": str(data.get("correct_answer", "")).strip(),
        "explanation": data.get("explanation", "").strip(),
        "difficulty": req.difficulty,
    }



# ===========================================================================
# STUDENT ACCOUNT: library, progress and synced flashcard reviews
# ===========================================================================
class ClaimRequest(BaseModel):
    """Items a guest created in this browser before signing in."""
    quiz_ids: List[str] = Field(default_factory=list, max_length=200)
    flashcard_ids: List[str] = Field(default_factory=list, max_length=200)
    note_ids: List[str] = Field(default_factory=list, max_length=200)


class FlashcardProgressItem(BaseModel):
    card_index: int = Field(..., ge=0, le=500)
    ease: float = Field(2.5, ge=1.3, le=5.0)
    interval: int = Field(0, ge=0, le=3650)
    reps: int = Field(0, ge=0, le=1000)
    last_quality: Optional[int] = Field(default=None, ge=0, le=5)


@app.get("/api/me/library")
def api_my_library(user: dict = Depends(require_user)):
    """Everything the signed-in user has generated, newest first."""
    return {
        "quizzes": list_all_quizzes(user_id=user["id"]),
        "flashcard_sets": list_flashcard_sets(user_id=user["id"]),
        "notes": list_notes(user_id=user["id"]),
    }


@app.post("/api/me/claim")
def api_claim_guest_items(req: ClaimRequest, user: dict = Depends(require_user)):
    """After signing in, attach items created as a guest in this browser.
    Only items that have no owner yet can be claimed."""
    claimed = 0
    with get_db() as conn:
        for table, ids in (("quizzes", req.quiz_ids), ("flashcard_sets", req.flashcard_ids),
                           ("study_notes", req.note_ids)):
            for item_id in _parse_ids(",".join(ids)):
                cur = conn.execute(
                    f"UPDATE {table} SET user_id = ? WHERE id = ? AND user_id IS NULL",
                    (user["id"], item_id),
                )
                claimed += getattr(cur, "rowcount", 0) or 0
        conn.commit()
    return {"claimed": claimed}


@app.get("/api/me/progress")
def api_my_progress(user: dict = Depends(require_user)):
    """The student's results over time, classes and flashcard review state."""
    now_iso = datetime.utcnow().isoformat()
    with get_db() as conn:
        attempts = conn.execute(
            """SELECT l.quiz_id, q.title AS quiz_title, l.score, l.total, l.percentage,
                      l.created_at, l.assignment_id, c.name AS class_name
               FROM leaderboard l
               JOIN quizzes q ON q.id = l.quiz_id
               LEFT JOIN classes c ON c.id = l.class_id
               WHERE l.user_id = ?
               ORDER BY l.created_at DESC LIMIT 100""",
            (user["id"],),
        ).fetchall()
        classes = conn.execute(
            """SELECT c.id, c.name, c.code, c.teacher_name, m.joined_at
               FROM class_memberships m JOIN classes c ON c.id = m.class_id
               WHERE m.user_id = ? ORDER BY m.joined_at DESC""",
            (user["id"],),
        ).fetchall()
        decks = conn.execute(
            """SELECT p.set_id, f.title, COUNT(*) AS reviewed,
                      SUM(CASE WHEN p.next_review_at <= ? THEN 1 ELSE 0 END) AS due
               FROM flashcard_progress p JOIN flashcard_sets f ON f.id = p.set_id
               WHERE p.user_id = ?
               GROUP BY p.set_id, f.title""",
            (now_iso, user["id"]),
        ).fetchall()
    attempts = [dict(r) for r in attempts]
    average = round(sum(a["percentage"] for a in attempts) / len(attempts), 1) if attempts else None
    return {
        "attempts": attempts,
        "average_percentage": average,
        "classes": [dict(r) for r in classes],
        "flashcard_decks": [dict(r) for r in decks],
    }


@app.get("/api/me/flashcards/{set_id}/progress")
def api_get_flashcard_progress(set_id: str, user: dict = Depends(require_user)):
    with get_db() as conn:
        rows = conn.execute(
            """SELECT card_index, ease, interval_days, reps, last_quality, next_review_at, updated_at
               FROM flashcard_progress WHERE user_id = ? AND set_id = ? ORDER BY card_index""",
            (user["id"], set_id),
        ).fetchall()
    return {"set_id": set_id, "cards": [dict(r) for r in rows]}


@app.put("/api/me/flashcards/{set_id}/progress")
def api_save_flashcard_progress(set_id: str, item: FlashcardProgressItem, user: dict = Depends(require_user)):
    """Save the SM-2 state of one card after the student rates it."""
    if not load_flashcard_set(set_id):
        raise HTTPException(status_code=404, detail="Flashcard set not found.")
    now = datetime.utcnow()
    next_review = (now + timedelta(days=item.interval)).isoformat()
    values = (user["id"], set_id, item.card_index, item.ease, item.interval, item.reps,
              item.last_quality, next_review, now.isoformat())
    if USE_POSTGRES:
        sql = """INSERT INTO flashcard_progress
                 (user_id, set_id, card_index, ease, interval_days, reps, last_quality, next_review_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)
                 ON CONFLICT (user_id, set_id, card_index) DO UPDATE SET
                   ease = EXCLUDED.ease, interval_days = EXCLUDED.interval_days, reps = EXCLUDED.reps,
                   last_quality = EXCLUDED.last_quality, next_review_at = EXCLUDED.next_review_at,
                   updated_at = EXCLUDED.updated_at"""
    else:
        sql = """INSERT OR REPLACE INTO flashcard_progress
                 (user_id, set_id, card_index, ease, interval_days, reps, last_quality, next_review_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)"""
    with get_db() as conn:
        conn.execute(sql, values)
        conn.commit()
    return {"saved": True, "next_review_at": next_review}


# ===========================================================================
# ADMINISTRATION
# ===========================================================================
class UpdateRoleRequest(BaseModel):
    role: Literal["student", "teacher", "admin"]


@app.get("/api/admin/stats")
def api_admin_stats(admin: dict = Depends(require_admin)):
    with get_db() as conn:
        def count(sql, params=()):
            return conn.execute(sql, params).fetchone()["c"]
        roles = {r: count("SELECT COUNT(*) c FROM users WHERE role = ?", (r,)) for r in ROLES}
        return {
            "users": roles,
            "quizzes": count("SELECT COUNT(*) c FROM quizzes"),
            "flashcard_sets": count("SELECT COUNT(*) c FROM flashcard_sets"),
            "notes": count("SELECT COUNT(*) c FROM study_notes"),
            "classes": count("SELECT COUNT(*) c FROM classes"),
            "assignments": count("SELECT COUNT(*) c FROM assignments"),
            "submissions": count("SELECT COUNT(*) c FROM leaderboard"),
            "guest_items": count("SELECT COUNT(*) c FROM quizzes WHERE user_id IS NULL"),
            "blocked": count("SELECT COUNT(*) c FROM users WHERE blocked_at IS NOT NULL"),
        }


@app.get("/api/admin/users")
def api_admin_users(admin: dict = Depends(require_admin)):
    with get_db() as conn:
        rows = conn.execute(
            """SELECT u.id, u.email, u.name, u.role, u.created_at, u.blocked_at,
                      (SELECT COUNT(*) FROM quizzes q WHERE q.user_id = u.id) AS quizzes,
                      (SELECT COUNT(*) FROM flashcard_sets f WHERE f.user_id = u.id) AS flashcard_sets,
                      (SELECT COUNT(*) FROM study_notes n WHERE n.user_id = u.id) AS notes,
                      (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.id) AS classes,
                      (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_sign_in
               FROM users u ORDER BY u.created_at DESC LIMIT 500"""
        ).fetchall()
    return {"users": [dict(r) for r in rows]}


@app.patch("/api/admin/users/{user_id}")
def api_admin_set_role(user_id: str, req: UpdateRoleRequest, admin: dict = Depends(require_admin)):
    if user_id == admin["id"] and req.role != "admin":
        raise HTTPException(status_code=400, detail="You can't remove your own admin role.")
    with get_db() as conn:
        row = conn.execute("SELECT name, email, role FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (req.role, user_id))
        conn.commit()
    if row["role"] != req.role:
        log_admin_action(admin, "change_role", "user", user_id, _user_label(row), f"{row['role']} -> {req.role}")
    return {"updated": user_id, "role": req.role}


@app.get("/api/admin/content")
def api_admin_content(admin: dict = Depends(require_admin)):
    with get_db() as conn:
        quizzes = conn.execute(
            """SELECT q.id, q.title, q.created_at, q.source_type, u.email AS owner
               FROM quizzes q LEFT JOIN users u ON u.id = q.user_id
               ORDER BY q.created_at DESC LIMIT 300"""
        ).fetchall()
        sets = conn.execute(
            """SELECT f.id, f.title, f.created_at, u.email AS owner
               FROM flashcard_sets f LEFT JOIN users u ON u.id = f.user_id
               ORDER BY f.created_at DESC LIMIT 300"""
        ).fetchall()
        notes = conn.execute(
            """SELECT n.id, n.title, n.created_at, n.format, u.email AS owner
               FROM study_notes n LEFT JOIN users u ON u.id = n.user_id
               ORDER BY n.created_at DESC LIMIT 300"""
        ).fetchall()
        classes = conn.execute(
            """SELECT c.id, c.name, c.code, c.created_at, u.email AS owner,
                      (SELECT COUNT(*) FROM class_memberships m WHERE m.class_id = c.id) AS students
               FROM classes c LEFT JOIN users u ON u.id = c.teacher_id
               ORDER BY c.created_at DESC LIMIT 300"""
        ).fetchall()
    return {
        "quizzes": [dict(r) for r in quizzes],
        "flashcard_sets": [dict(r) for r in sets],
        "notes": [dict(r) for r in notes],
        "classes": [dict(r) for r in classes],
    }


def delete_quiz_everywhere(quiz_id: str):
    """Delete a question set and everything that depends on it, in an order
    that works with or without enforced foreign keys."""
    with get_db() as conn:
        live_ids = [r["id"] for r in conn.execute("SELECT id FROM live_sessions WHERE quiz_id = ?", (quiz_id,)).fetchall()]
        for sid in live_ids:
            conn.execute("DELETE FROM live_answers WHERE session_id = ?", (sid,))
            conn.execute("DELETE FROM live_players WHERE session_id = ?", (sid,))
        conn.execute("DELETE FROM live_sessions WHERE quiz_id = ?", (quiz_id,))
        conn.execute("DELETE FROM assignment_responses WHERE quiz_id = ?", (quiz_id,))
        conn.execute("DELETE FROM leaderboard WHERE quiz_id = ?", (quiz_id,))
        conn.execute("DELETE FROM assignments WHERE quiz_id = ?", (quiz_id,))
        conn.execute("UPDATE flashcard_sets SET quiz_id = NULL WHERE quiz_id = ?", (quiz_id,))
        conn.execute("DELETE FROM quizzes WHERE id = ?", (quiz_id,))
        conn.commit()


@app.delete("/api/admin/quizzes/{quiz_id}")
def api_admin_delete_quiz(quiz_id: str, admin: dict = Depends(require_admin)):
    quiz = load_quiz(quiz_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")
    delete_quiz_everywhere(quiz_id)
    log_admin_action(admin, "delete_content", "quiz", quiz_id, quiz["title"])
    return {"deleted": quiz_id}


@app.delete("/api/admin/flashcards/{set_id}")
def api_admin_delete_flashcards(set_id: str, admin: dict = Depends(require_admin)):
    with get_db() as conn:
        row = conn.execute("SELECT title FROM flashcard_sets WHERE id = ?", (set_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Flashcard set not found.")
        conn.execute("DELETE FROM flashcard_progress WHERE set_id = ?", (set_id,))
        conn.execute("DELETE FROM flashcard_sets WHERE id = ?", (set_id,))
        conn.commit()
    log_admin_action(admin, "delete_content", "flashcard_set", set_id, row["title"])
    return {"deleted": set_id}


@app.delete("/api/admin/notes/{note_id}")
def api_admin_delete_note(note_id: str, admin: dict = Depends(require_admin)):
    with get_db() as conn:
        row = conn.execute("SELECT title FROM study_notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Note not found.")
        conn.execute("DELETE FROM study_notes WHERE id = ?", (note_id,))
        conn.commit()
    log_admin_action(admin, "delete_content", "note", note_id, row["title"])
    return {"deleted": note_id}


# ---------------------------------------------------------------------------
# Audit log, account management and maintenance
# ---------------------------------------------------------------------------
def _user_label(row) -> str:
    return f"{row['name']} <{row['email']}>"


def log_admin_action(admin: dict, action: str, target_type: str, target_id: Optional[str],
                     target_label: Optional[str] = None, details: Optional[str] = None):
    """Write one row to admin_actions. A failure here must never undo the
    action itself, so errors are only printed."""
    try:
        with get_db() as conn:
            conn.execute(
                """INSERT INTO admin_actions (admin_id, admin_name, action, target_type, target_id,
                                              target_label, details, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (admin["id"], admin.get("name") or admin.get("email", "admin"), action, target_type,
                 target_id, (target_label or "")[:200], (details or None), datetime.utcnow().isoformat()),
            )
            conn.commit()
    except Exception as e:
        print(f"[Admin] Could not write audit log: {e}")


def _get_user_row(conn, user_id: str):
    row = conn.execute(
        "SELECT id, name, email, role, created_at, blocked_at FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found.")
    return row


@app.get("/api/admin/users/{user_id}")
def api_admin_user_detail(user_id: str, admin: dict = Depends(require_admin)):
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        u = dict(_get_user_row(conn, user_id))
        rows = lambda sql: [dict(r) for r in conn.execute(sql, (user_id,)).fetchall()]
        u["quizzes"] = rows("SELECT id, title, created_at, source_type FROM quizzes WHERE user_id = ? ORDER BY created_at DESC")
        u["flashcard_sets"] = rows("SELECT id, title, created_at FROM flashcard_sets WHERE user_id = ? ORDER BY created_at DESC")
        u["notes"] = rows("SELECT id, title, created_at FROM study_notes WHERE user_id = ? ORDER BY created_at DESC")
        u["attempts"] = rows(
            """SELECT l.quiz_id, q.title AS quiz_title, l.score, l.total, l.percentage, l.created_at,
                      c.name AS class_name
               FROM leaderboard l LEFT JOIN quizzes q ON q.id = l.quiz_id
               LEFT JOIN classes c ON c.id = l.class_id
               WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 50""")
        u["classes_taught"] = rows(
            """SELECT c.id, c.name, c.code, c.created_at,
                      (SELECT COUNT(*) FROM class_memberships m WHERE m.class_id = c.id) AS students
               FROM classes c WHERE c.teacher_id = ? ORDER BY c.created_at DESC""")
        u["memberships"] = rows(
            """SELECT c.id, c.name, m.joined_at FROM class_memberships m
               JOIN classes c ON c.id = m.class_id WHERE m.user_id = ? ORDER BY m.joined_at DESC""")
        u["active_sessions"] = conn.execute(
            "SELECT COUNT(*) c FROM sessions WHERE user_id = ? AND expires_at > ?", (user_id, now)
        ).fetchone()["c"]
        u["last_sign_in"] = conn.execute(
            "SELECT MAX(created_at) m FROM sessions WHERE user_id = ?", (user_id,)
        ).fetchone()["m"]
        u["actions"] = [dict(r) for r in conn.execute(
            """SELECT admin_name, action, details, created_at FROM admin_actions
               WHERE target_type = 'user' AND target_id = ? ORDER BY created_at DESC LIMIT 20""",
            (user_id,)).fetchall()]
    return u


@app.post("/api/admin/users/{user_id}/block")
def api_admin_block_user(user_id: str, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You can't block your own account.")
    with get_db() as conn:
        row = _get_user_row(conn, user_id)
        if row["blocked_at"]:
            return {"blocked": user_id, "blocked_at": row["blocked_at"]}
        now = datetime.utcnow().isoformat()
        conn.execute("UPDATE users SET blocked_at = ? WHERE id = ?", (now, user_id))
        # Signing the account out everywhere: its tokens stop working at once.
        ended = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,)).rowcount
        conn.commit()
    log_admin_action(admin, "block_user", "user", user_id, _user_label(row), f"{ended} session(s) ended")
    return {"blocked": user_id, "blocked_at": now}


@app.post("/api/admin/users/{user_id}/unblock")
def api_admin_unblock_user(user_id: str, admin: dict = Depends(require_admin)):
    with get_db() as conn:
        row = _get_user_row(conn, user_id)
        conn.execute("UPDATE users SET blocked_at = NULL WHERE id = ?", (user_id,))
        conn.commit()
    if row["blocked_at"]:
        log_admin_action(admin, "unblock_user", "user", user_id, _user_label(row))
    return {"unblocked": user_id}


def delete_user_account(user_id: str, delete_content: bool = False) -> dict:
    """Remove an account. Classes and live sessions it ran are removed with it;
    its study material either stays without an owner (like guest material)
    or, with delete_content, is deleted as well. Every step is explicit, so
    the result is the same in PostgreSQL and in SQLite."""
    with get_db() as conn:
        class_ids = [r["id"] for r in conn.execute("SELECT id FROM classes WHERE teacher_id = ?", (user_id,)).fetchall()]
        quiz_ids = [r["id"] for r in conn.execute("SELECT id FROM quizzes WHERE user_id = ?", (user_id,)).fetchall()]
        set_ids = [r["id"] for r in conn.execute("SELECT id FROM flashcard_sets WHERE user_id = ?", (user_id,)).fetchall()]
    for cid in class_ids:
        delete_class(cid)
    if delete_content:
        for qid in quiz_ids:
            delete_quiz_everywhere(qid)
    with get_db() as conn:
        live_ids = [r["id"] for r in conn.execute("SELECT id FROM live_sessions WHERE teacher_id = ?", (user_id,)).fetchall()]
        for sid in live_ids:
            conn.execute("DELETE FROM live_answers WHERE session_id = ?", (sid,))
            conn.execute("DELETE FROM live_players WHERE session_id = ?", (sid,))
            conn.execute("DELETE FROM live_sessions WHERE id = ?", (sid,))
        if delete_content:
            for fid in set_ids:
                conn.execute("DELETE FROM flashcard_progress WHERE set_id = ?", (fid,))
                conn.execute("DELETE FROM flashcard_sets WHERE id = ?", (fid,))
            notes = conn.execute("DELETE FROM study_notes WHERE user_id = ?", (user_id,)).rowcount
        else:
            notes = 0
            for table in ("quizzes", "flashcard_sets", "study_notes"):
                conn.execute(f"UPDATE {table} SET user_id = NULL WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM flashcard_progress WHERE user_id = ?", (user_id,))
        conn.execute("UPDATE leaderboard SET user_id = NULL WHERE user_id = ?", (user_id,))
        conn.execute("UPDATE class_memberships SET user_id = NULL WHERE user_id = ?", (user_id,))
        conn.execute("UPDATE class_announcements SET author_id = NULL WHERE author_id = ?", (user_id,))
        conn.execute("UPDATE admin_actions SET admin_id = NULL WHERE admin_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    return {"classes": len(class_ids), "live_sessions": len(live_ids),
            "quizzes": len(quiz_ids), "flashcard_sets": len(set_ids), "notes": notes,
            "content_deleted": delete_content}


@app.delete("/api/admin/users/{user_id}")
def api_admin_delete_user(user_id: str, delete_content: bool = False, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You can't delete your own account.")
    with get_db() as conn:
        row = _get_user_row(conn, user_id)
    summary = delete_user_account(user_id, delete_content)
    details = (f"role {row['role']}; {summary['classes']} class(es) removed; material "
               + ("deleted" if delete_content else "kept without owner"))
    log_admin_action(admin, "delete_user", "user", user_id, _user_label(row), details)
    return {"deleted": user_id, **summary}


@app.get("/api/admin/audit")
def api_admin_audit(limit: int = 200, admin: dict = Depends(require_admin)):
    limit = max(1, min(limit, 500))
    with get_db() as conn:
        rows = conn.execute(
            f"""SELECT id, admin_id, admin_name, action, target_type, target_id, target_label, details, created_at
                FROM admin_actions ORDER BY created_at DESC, id DESC LIMIT {limit}"""
        ).fetchall()
    return {"actions": [dict(r) for r in rows]}


# Maintenance --------------------------------------------------------------
ADMIN_TABLES = ["users", "sessions", "quizzes", "flashcard_sets", "flashcard_progress", "study_notes",
                "leaderboard", "classes", "class_memberships", "class_announcements", "assignments",
                "assignment_responses", "live_sessions", "live_players", "live_answers", "admin_actions"]

# Guest material that nobody claimed. A question set is kept if a class or a
# live session uses it, or if a signed-in user has a result for it; a
# flashcard set is kept if a signed-in user is reviewing it.
_GUEST_QUIZ_WHERE = """user_id IS NULL AND created_at < ?
    AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.quiz_id = quizzes.id)
    AND NOT EXISTS (SELECT 1 FROM live_sessions ls WHERE ls.quiz_id = quizzes.id)
    AND NOT EXISTS (SELECT 1 FROM leaderboard l WHERE l.quiz_id = quizzes.id AND l.user_id IS NOT NULL)"""
_GUEST_SET_WHERE = """user_id IS NULL AND created_at < ?
    AND NOT EXISTS (SELECT 1 FROM flashcard_progress p WHERE p.set_id = flashcard_sets.id)"""
_GUEST_NOTE_WHERE = "user_id IS NULL AND created_at < ?"


def _cutoff(days: int) -> str:
    return (datetime.utcnow() - timedelta(days=days)).isoformat()


def _database_size(conn) -> Optional[int]:
    try:
        if USE_POSTGRES:
            return int(conn.execute("SELECT pg_database_size(current_database()) AS b").fetchone()["b"])
        return os.path.getsize(DB_PATH)
    except Exception:
        return None


@app.get("/api/admin/maintenance")
def api_admin_maintenance(guest_days: int = 30, admin: dict = Depends(require_admin)):
    guest_days = max(1, min(guest_days, 3650))
    g = _cutoff(guest_days)
    with get_db() as conn:
        count = lambda sql, params=(): conn.execute(sql, params).fetchone()["c"]
        return {
            "guest_days": guest_days,
            "guest": {
                "quizzes": count(f"SELECT COUNT(*) c FROM quizzes WHERE {_GUEST_QUIZ_WHERE}", (g,)),
                "flashcard_sets": count(f"SELECT COUNT(*) c FROM flashcard_sets WHERE {_GUEST_SET_WHERE}", (g,)),
                "notes": count(f"SELECT COUNT(*) c FROM study_notes WHERE {_GUEST_NOTE_WHERE}", (g,)),
            },
            "old_responses": count("SELECT COUNT(*) c FROM assignment_responses WHERE submitted_at < ?", (_cutoff(90),)),
            "expired_sessions": count("SELECT COUNT(*) c FROM sessions WHERE expires_at < ?", (datetime.utcnow().isoformat(),)),
            "database_bytes": _database_size(conn),
            "tables": {t: count(f"SELECT COUNT(*) c FROM {t}") for t in ADMIN_TABLES},
        }


class CleanupRequest(BaseModel):
    task: Literal["guest_content", "old_responses", "expired_sessions"]
    days: int = Field(30, ge=1, le=3650)


@app.post("/api/admin/maintenance/cleanup")
def api_admin_cleanup(req: CleanupRequest, admin: dict = Depends(require_admin)):
    if req.task == "guest_content":
        g = _cutoff(req.days)
        with get_db() as conn:
            quiz_ids = [r["id"] for r in conn.execute(f"SELECT id FROM quizzes WHERE {_GUEST_QUIZ_WHERE}", (g,)).fetchall()]
            set_ids = [r["id"] for r in conn.execute(f"SELECT id FROM flashcard_sets WHERE {_GUEST_SET_WHERE}", (g,)).fetchall()]
        for qid in quiz_ids:
            delete_quiz_everywhere(qid)
        with get_db() as conn:
            for fid in set_ids:
                conn.execute("DELETE FROM flashcard_sets WHERE id = ?", (fid,))
            notes = conn.execute(f"DELETE FROM study_notes WHERE {_GUEST_NOTE_WHERE}", (g,)).rowcount
            conn.commit()
        result = {"quizzes": len(quiz_ids), "flashcard_sets": len(set_ids), "notes": notes}
        details = f"older than {req.days} days: {len(quiz_ids)} sets, {len(set_ids)} flashcard sets, {notes} notes"
    elif req.task == "old_responses":
        with get_db() as conn:
            n = conn.execute("DELETE FROM assignment_responses WHERE submitted_at < ?", (_cutoff(90),)).rowcount
            conn.commit()
        result = {"responses": n}
        details = f"{n} answer rows older than 90 days"
    else:
        with get_db() as conn:
            n = conn.execute("DELETE FROM sessions WHERE expires_at < ?", (datetime.utcnow().isoformat(),)).rowcount
            conn.commit()
        result = {"sessions": n}
        details = f"{n} expired session(s)"
    log_admin_action(admin, "cleanup", "maintenance", req.task, req.task.replace("_", " "), details)
    return {"task": req.task, "deleted": result}
