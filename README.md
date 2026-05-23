# Refinr — AI-Powered Academic Reference Manager

> Format. Verify. Submit with confidence.

**Refinr** is an AI-powered academic reference manager that formats, cleans and verifies academic reference lists in seconds. Paste messy, incomplete or incorrectly formatted references and get them back clean, alphabetically sorted, duplicate-free and verified against 370 million academic records.

🔗 **Live app:** https://refinr-murex.vercel.app

---

## What Refinr Does

Refinr solves one of the most painful problems in academic writing — reference formatting and verification. What used to take hours of manual work now takes seconds.

### The Problem
- Formatting 100 references manually from Google Scholar one by one
- Switching between Harvard, APA, MLA and Chicago styles
- Hunting for duplicates manually
- Verifying that years, authors and titles are correct
- Finding DOIs for references that don't have them

### The Solution
Paste your references — messy, incomplete, wrong format, doesn't matter. Refinr handles everything.

---

## Features

### 📋 Clean & Format References
- Supports **Harvard, APA, MLA and Chicago** citation styles
- Clean and alphabetize only (preserves your existing format)
- Number references sequentially (auto-adjusts if any are removed)
- Removes duplicates automatically
- Flags missing author names
- Preserves all bibliographic details — volume, issue, page numbers, DOIs, URLs
- Handles messy, incomplete and scattered reference details intelligently
- Automatically resolves DOIs and ISBNs mixed into your reference list

### 🔍 Verify References (Pro)
- Checks every reference against **CrossRef (130M records)** and **OpenAlex (240M records)**
- Returns an **accuracy score** — e.g. "87% accurate — 2 mismatches found"
- Flags wrong years, wrong authors, wrong titles and wrong journal names
- Provides **suggested corrections** for every mismatch
- Shareable verification report link — share with your supervisor, no account needed

### 📝 In-Text Citations
- Generates in-text citations from your reference list automatically
- Applies correct et al. rules — 1 author: (Smith, 2020), 2 authors: (Smith and Jones, 2020), 3+ authors: (Smith et al., 2020)
- Returns a clean numbered list ready to use

### 🔎 Reference Lookup Tools
Three lookup methods in one tabbed interface:

**DOI / ISBN Lookup**
- Paste multiple DOIs or ISBNs (one per line)
- Refinr fetches full bibliographic details from CrossRef and OpenLibrary
- Returns formatted references in your chosen citation style
- One-click load into input for immediate cleaning

**URL to Reference**
- Paste any academic webpage URL
- Refinr extracts reference details automatically
- Handles standard DOI URLs, PubMed links, Nature, Science, Cell and more
- Falls back to formatted webpage citation for any URL

**Find by Title / Author**
- Paste an article title or author name
- Refinr searches CrossRef and OpenAlex
- Returns the full formatted reference plus DOI
- Works for messy or partial titles

---

## How It Works
User pastes references
↓
Refinr detects DOIs/ISBNs inline and resolves them via CrossRef/OpenLibrary
↓
Groq AI (llama-3.3-70b-versatile) formats everything in requested citation style
↓
CrossRef + OpenAlex verify each reference against 370M academic records
↓
User receives clean formatted verified reference list with accuracy score
---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript (single file) |
| Backend | Vercel Serverless Functions |
| AI Model | Groq API — llama-3.3-70b-versatile |
| Primary Verification | CrossRef API (130M records, free) |
| Backup Verification | OpenAlex API (240M records, free) |
| ISBN Lookup | OpenLibrary API (free) |
| PubMed Lookup | NCBI eUtils API (free) |
| Report Storage | JSONBin.io |
| Hosting | Vercel (free tier) |
| Analytics | Vercel Analytics |

---

## API Routes

| Endpoint | Method | Description |
|---|---|---|
| `/api/clean` | POST | Format and clean references via Groq AI |
| `/api/verify` | POST | Verify single reference against CrossRef + OpenAlex |
| `/api/intext` | POST | Generate in-text citations from reference list |
| `/api/lookup` | POST | Mass DOI/ISBN lookup via CrossRef + OpenLibrary |
| `/api/urllookup` | POST | Extract reference from URL |
| `/api/titlelookup` | POST | Find reference by title/author search |
| `/api/report` | POST/GET | Save and retrieve shareable verification reports |
| `/api/ratelimit` | — | Rate limiting utility (30 req/hour clean, 10 req/hour verify) |

---

## Supported Citation Styles

- Harvard
- APA (American Psychological Association)
- MLA (Modern Language Association)
- Chicago
- Clean and alphabetize only (preserves existing style)
- Numbered list (sequential, auto-adjusts)

*More styles coming: Vancouver, IEEE, AMA, ACS*

---

## Verification Databases

| Database | Records | Coverage |
|---|---|---|
| CrossRef | 130M+ | Journals, books, conference papers, datasets |
| OpenAlex | 240M+ | Open access works, broader coverage |
| PubMed (via eUtils) | 35M+ | Medical and life sciences |
| OpenLibrary | Millions | Books via ISBN |

---

## Competitive Advantage

| Feature | Refinr | Zotero | Mendeley | Citation generators |
|---|---|---|---|---|
| Mass paste (100+ refs) | ✅ | ❌ | ❌ | ❌ |
| No setup required | ✅ | ❌ | ❌ | ✅ |
| CrossRef verification | ✅ | ❌ | ❌ | ❌ |
| Accuracy score | ✅ | ❌ | ❌ | ❌ |
| Suggested corrections | ✅ | ❌ | ❌ | ❌ |
| Mixed DOI + ref input | ✅ | ❌ | ❌ | ❌ |
| Shareable report | ✅ | ❌ | ❌ | ❌ |
| Free to start | ✅ | ✅ | ✅ | ✅ |

---

## Roadmap

### Coming Soon
- [ ] User accounts and persistent credits
- [ ] Stripe payment integration
- [ ] Narrative vs parenthetical in-text citation toggle
- [ ] Vancouver and IEEE citation styles
- [ ] Word document export (.docx)
- [ ] Reference completeness checker
- [ ] Accept suggestions one-click correction

### Future Features
- [ ] Full paper / dissertation reference analysis and scoring
- [ ] PDF and Word document upload and reference extraction
- [ ] Chrome extension
- [ ] Microsoft Word plugin
- [ ] Journal-specific formatting (Elsevier, Springer, IEEE)
- [ ] Institutional licensing
- [ ] Referral program for supervisors and researchers

---

## Target Users

- University students formatting dissertations and essays
- Researchers and academics managing reference lists
- Project supervisors verifying student submissions
- Journal editors checking submitted papers
- Essay writers handling multiple client projects
- University librarians supporting research workflows

---

## Privacy

Refinr is designed to collect minimal data. References submitted for processing are not stored permanently. See our full privacy policy at https://refinr-murex.vercel.app/privacy

---

## Contact & Feedback

- 📧 Email: hello.refinr@gmail.com
- 🐦 X/Twitter: [@GetRefinr](https://x.com/GetRefinr)
- 💬 Feedback: [Submit feedback](https://tally.so/r/GxJNNz)

---

## License

Refinr is proprietary software. All rights reserved.

© 2026 Refinr
