# StressMora – AI to Database Chat

StressMora is a simple app that lets you **chat with your PostgreSQL database**.  
Ask natural language questions → AI converts them into safe SQL → runs on Postgres → returns results.

---

## ✨ Features
- Chat with your database in plain English
- AI translates NL → SQL using OpenRouter’s free `gpt-oss-20b` model
- Safe SQL execution (SELECT-only, with automatic LIMIT)
- Simple UI with query + results table
- Works with Neon (Postgres free tier) or any Postgres instance

---

## ⚙️ Tech Stack
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL (Neon free tier)
- **AI:** OpenRouter `gpt-oss-20b:free`
- **Frontend:** Minimal HTML/JS chat interface

---

## 🚀 Getting Started

### 1. Clone repo & install deps
```bash
git clone https://github.com/your-repo-link.git
cd stressmora
npm install
```

### 2. Setup environment
Create a `.env` file in the root:

```env
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxx
OPENAI_BASE_URL=https://openrouter.ai/api/v1
MODEL=openai/gpt-oss-20b:free

DATABASE_URL=postgres://user:pass@host/db?sslmode=require
PORT=3001
```

### 3. Run the server
```bash
npm run dev
```
Open [http://localhost:3001](http://localhost:3001) to chat with your DB.

---

## 🧪 Example Queries
- "How many customers do we have?"
- "List all users on the Pro plan with their emails."
- "Show total revenue by month."

---

## 📜 License
MIT License
