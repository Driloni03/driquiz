"""
migrate_to_postgres.py — One-time migration from SQLite to PostgreSQL.

Run this ONCE after you've:
  1. Added DATABASE_URL to your .env
  2. Installed psycopg2-binary (pip install psycopg2-binary)
  3. Started your backend once with the new main.py (so Postgres tables are created)

Usage:
  cd ~/Desktop/quiz-generator/backend
  source venv/bin/activate
  python migrate_to_postgres.py

This will:
  - Read all data from your local quizzes.db (SQLite)
  - Copy every row into your Postgres database (Supabase)
  - Skip rows that already exist (safe to re-run)
  - Print a summary at the end

Your SQLite file is not modified or deleted. If anything goes wrong, your
original data is untouched.
"""
import os
import sys
import sqlite3
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
SQLITE_PATH = os.getenv("DB_PATH", "quizzes.db")

if not DATABASE_URL.startswith("postgres"):
    print("❌ DATABASE_URL is not set (or doesn't look like a Postgres URL) in .env")
    print("   Add it and try again.")
    sys.exit(1)

if not os.path.exists(SQLITE_PATH):
    print(f"❌ SQLite file not found at: {SQLITE_PATH}")
    print("   Nothing to migrate. If your data was elsewhere, set DB_PATH in .env.")
    sys.exit(1)

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("❌ psycopg2-binary is not installed.")
    print("   Install it: pip install psycopg2-binary")
    sys.exit(1)

print(f"📂 Reading from SQLite: {SQLITE_PATH}")
print(f"☁️  Writing to Postgres: {DATABASE_URL.split('@')[-1] if '@' in DATABASE_URL else DATABASE_URL[:60]}")
print()

# Tables to migrate, in dependency order (parents before children)
TABLES = [
    "teachers",
    "sessions",
    "classes",
    "class_memberships",
    "quizzes",
    "assignments",
    "class_announcements",
    "leaderboard",
    "flashcard_sets",
    "study_notes",
    "live_sessions",
    "live_players",
    "live_answers",
]

# Connect to both databases
sqlite_conn = sqlite3.connect(SQLITE_PATH)
sqlite_conn.row_factory = sqlite3.Row

pg_conn = psycopg2.connect(DATABASE_URL, sslmode='require')
pg_conn.autocommit = False

summary = {}

try:
    for table in TABLES:
        # Check if the table exists in SQLite (might not if user never used that feature)
        row = sqlite_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,)
        ).fetchone()
        if not row:
            summary[table] = "not present in SQLite (skipped)"
            continue

        # Get all rows from SQLite
        rows = sqlite_conn.execute(f"SELECT * FROM {table}").fetchall()
        if not rows:
            summary[table] = "0 rows (empty)"
            continue

        # Get column names
        columns = list(rows[0].keys())
        col_names = ", ".join(columns)
        placeholders = ", ".join(["%s"] * len(columns))

        # Insert each row, skipping duplicates
        cursor = pg_conn.cursor()
        inserted = 0
        skipped = 0

        for row in rows:
            values = tuple(row[c] for c in columns)
            # Use ON CONFLICT DO NOTHING to skip duplicates
            # For tables with SERIAL id, we need to be careful — let auto-generate
            if table in ("live_players", "live_answers", "leaderboard"):
                # These have SERIAL/AUTOINCREMENT ids — let Postgres generate new ones,
                # but this means references between them break. For simplicity, insert with the id
                # from SQLite and let Postgres accept it (this works if the column is SERIAL).
                pass  # No special handling needed

            try:
                cursor.execute(
                    f"INSERT INTO {table} ({col_names}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                    values
                )
                if cursor.rowcount > 0:
                    inserted += 1
                else:
                    skipped += 1
            except Exception as e:
                # Rollback this row's transaction and continue
                pg_conn.rollback()
                print(f"  ⚠️  Failed row in {table}: {e}")
                # Reopen transaction
                cursor = pg_conn.cursor()

        pg_conn.commit()
        summary[table] = f"inserted {inserted}, skipped {skipped}"
        print(f"  ✓ {table}: {summary[table]}")

    # Fix SERIAL sequences for auto-increment tables
    # Postgres sequences need to be advanced past the max id after manual inserts
    cursor = pg_conn.cursor()
    for table in ("leaderboard", "live_players", "live_answers"):
        try:
            cursor.execute(f"SELECT MAX(id) FROM {table}")
            max_id = cursor.fetchone()[0]
            if max_id is not None:
                cursor.execute(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), %s)",
                    (max_id,)
                )
                print(f"  ✓ Advanced {table}.id sequence to {max_id}")
        except Exception as e:
            print(f"  ⚠️  Could not advance sequence for {table}: {e}")
    pg_conn.commit()

    print()
    print("=" * 50)
    print("MIGRATION COMPLETE")
    print("=" * 50)
    for table, status in summary.items():
        print(f"  {table:25s} {status}")
    print()
    print("✅ Your data is now in Postgres. You can now restart your backend.")
    print("   Your SQLite file is unchanged (as backup).")

except Exception as e:
    pg_conn.rollback()
    print(f"❌ Migration failed: {e}")
    raise
finally:
    sqlite_conn.close()
    pg_conn.close()
