# 📚 Gjenerator Kuizesh me AI

Aplikacion për krijimin automatik të kuizeve nga materialet mësimore duke përdorur Claude AI.

**Stack:** React (Vite) + FastAPI + Anthropic Claude

---

## 🎯 Veçoritë

- 📄 Ngarkim PDF ose ngjitje teksti
- 🎚️ Tre nivele vështirësie (i lehtë / mesatar / i vështirë)
- ❓ Tre lloje pyetjesh: me zgjedhje, e vërtetë/e gabuar, përgjigje e shkurtër
- ✅ Vlerësim automatik me shpjegime
- 🇦🇱 Ndërfaqe plotësisht në shqip
- 🔍 Çdo pyetje ka referencë në materialin burim (ground truth)

---

## 🏗️ Arkitektura

```
quiz-generator/
├── backend/              # FastAPI server
│   ├── main.py          # API endpoints + logjika
│   ├── requirements.txt
│   └── .env.example
└── frontend/            # React + Vite
    ├── src/
    │   ├── App.jsx      # UI kryesor
    │   ├── main.jsx
    │   └── styles.css
    ├── index.html
    ├── package.json
    └── vite.config.js
```

### Rrjedha (flow)

1. Përdoruesi ngarkon PDF ose ngjit tekst
2. Backend ekstrakton tekstin (PyMuPDF) dhe e ndan në "chunks"
3. Disa chunks zgjidhen në mënyrë të barabartë nga i gjithë dokumenti (mbulim i plotë)
4. Claude merr chunks + parametrat (numri, vështirësia, llojet) dhe kthen JSON të strukturuar
5. Frontend shfaq kuizin; përgjigjet dërgohen për vlerësim
6. Backend krahason përgjigjet dhe kthen rezultatin me shpjegime

---

## 🚀 Si ta vësh në punë

### 1. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate          # në Windows: venv\Scripts\activate
pip install -r requirements.txt

# konfiguro çelësin e API-së
cp .env.example .env
# modifiko .env dhe vendos ANTHROPIC_API_KEY-n

# starto serverin
uvicorn main:app --reload --port 8000
```

Backend-i tani është në `http://localhost:8000`. Kontrollo `http://localhost:8000/docs` për dokumentimin e API-së (Swagger UI automatik nga FastAPI).

### 2. Frontend

Në një terminal të ri:

```bash
cd frontend
npm install
npm run dev
```

Frontend-i hapet në `http://localhost:5173`. Vite e proxy-on automatikisht `/api/*` te backend-i.

---

## 🔑 Si ta marrësh çelësin e Anthropic

1. Shko te https://console.anthropic.com
2. Krijo një llogari ose hyr
3. Te seksioni "API Keys", krijo një çelës të ri
4. Vendose në `backend/.env` si:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

---

## 🧪 Testim i shpejtë

1. Sigurohu që backend-i dhe frontend-i janë të dy duke punuar
2. Hap `http://localhost:5173`
3. Kliko "Ngjit tekst" dhe ngjit p.sh. një paragraf nga Wikipedia
4. Zgjidh 3 pyetje, vështirësi mesatare, lloji "Me zgjedhje"
5. Kliko "Gjenero Kuiz"

---

## 📝 API Endpoints

### `POST /api/generate-quiz`
Gjeneron një kuiz nga materiali.

**Multipart form data:**
- `file` (opsional): skedar PDF ose .txt
- `text` (opsional): teksti i materialit
- `num_questions`: numër (1–20)
- `difficulty`: `easy` | `medium` | `hard`
- `question_types`: listë me presje, p.sh. `multiple_choice,true_false`

**Përgjigjet:**
```json
{
  "title": "...",
  "questions": [
    {
      "type": "multiple_choice",
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "correct_answer": "...",
      "explanation": "...",
      "source_chunk": "..."
    }
  ]
}
```

### `POST /api/score-quiz`
Vlerëson përgjigjet e përdoruesit.

**JSON body:**
```json
{
  "questions": [...],
  "user_answers": ["...", "...", ...]
}
```

---

## 💡 Ide për zgjerim (pas projektit bazë)

- 🎓 **Nivelet e Bloom-it**: pyetje në nivele kognitive të ndryshme
- 🎯 **Mënyra adaptive**: pas vlerësimit, gjeneron pyetje të reja për temat ku përdoruesi gaboi
- 💾 **Histori kuizesh**: ruaj në SQLite kuizet e gjeneruara
- 📤 **Eksport në PDF**: shkarko kuizin për shtyp
- 👥 **Llogari përdoruesi**: ndaj kuize me shokë klase
- 🌐 **Mbështetje për më shumë formate**: .docx, .pptx, video transcripts

---

## 🎓 Çfarë mund të prezantosh

- **Demo live**: ngarkim i një materiali të vërtetë nga ligjërata jote
- **Diagram arkitekture**: shih më lart
- **Përse RAG-light**: shpjegim pse `source_chunk` parandalon halucinacionet
- **Strategjia e chunking-ut**: paragraph-aware me mbulim të barabartë
- **Prompt engineering**: si u dizajnua promp-i për JSON i strukturuar

---

## ⚙️ Detaje teknike

- **Modeli**: Claude Sonnet 4.5 (`claude-sonnet-4-5`)
- **Chunking**: paragraph-aware, max 4000 karaktere/chunk
- **Selection**: deri në 6 chunks të zgjedhur me hap të barabartë
- **PDF**: PyMuPDF (`fitz`) — shpejt dhe i besueshëm
- **CORS**: i hapur për zhvillim (kufizoje në prodhim!)
