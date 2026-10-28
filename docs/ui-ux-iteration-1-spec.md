# Refinr UI/UX Iteration 1 — Implementation Specification

Status: Approved implementation specification
Branch: `feature/search-by-idea-v2-phase1`
Baseline when this spec was created: `3c99ac56743c63b78ec8d6efeac243ef2be1a08e`
Scope: Public front door, information hierarchy, visual consolidation, and safe handoff into existing product flows.

## 1. Purpose

Iteration 1 improves how people understand and enter Refinr without rewriting the proven product machinery underneath it.

The current application has useful research and reference capabilities, but its front door primarily presents a reference-processing workspace. Refinr's broader product direction begins earlier in the research journey: a person may arrive with only a question, an existing reference list, a DOI/title, or a document.

The first screen should therefore organize the product around what the person is trying to accomplish rather than around Refinr's internal feature names.

Primary journey:

`Curiosity / problem -> discover -> understand -> find credible research -> work with papers -> build/use references -> preserve/use results -> return`

Iteration 1 does not implement the entire future journey. It makes the current application communicate that journey clearly while preserving current backend behavior.

## 2. Product principles

### 2.1 North star

Every material UI decision should answer:

> Does this make credible academic work more accessible, or are we just adding another feature?

Refinr's three product pillars are:

- Credibility
- Discoverability
- Accessibility

### 2.2 User-burden principle

The user should bring the research problem. Refinr should carry as much research-system complexity as it can safely carry.

Do not require a visitor to understand academic database syntax, source-provider names, citation infrastructure, or internal feature taxonomy before they can begin.

### 2.3 Organizing principle

> Organize Refinr around what the person is trying to accomplish, not around internal feature names.

### 2.4 Credibility boundary

Refinr must distinguish search framing from research findings.

For example, when interpreting a question, Refinr may say:

> I’m looking for research connecting drainage and flooding in riverine communities with economic vulnerability, livelihoods, infrastructure and poverty.

It must not present an unverified causal conclusion such as:

> Poor drainage causes poverty through...

before evidence has established that relationship.

Future evidence synthesis must be able to say when warranted:

- The available research does not support that conclusion.
- I found related research, but not enough evidence to establish the relationship.
- There is evidence of association, but not causation.

Those future synthesis capabilities are not part of Iteration 1.

## 3. Current product capabilities that must survive

Iteration 1 is not a rebuild. Preserve the existing working functionality and API contracts unless this specification explicitly says otherwise.

Keep:

- Reference textarea/workflow
- Clean references
- Verify references
- In-text citations
- DOI/ISBN/URL/title lookup
- Search by Idea legacy flow
- PDF extraction/analysis
- Deep Dive machinery
- Citation-style infrastructure
- Output/result card
- Accept Suggestions behavior
- Copy result
- Share result
- Authentication/session behavior
- Credits and payments
- Feedback
- Social links
- Light/dark themes

Do not rewrite backend endpoints merely to accommodate the new visual hierarchy.

## 4. New public front-door architecture

### 4.1 Primary promise

The first screen should no longer begin by assuming the visitor already has references.

Recommended hierarchy:

**Research starts with a question.**

Supporting copy:

**Discover credible academic research, or work with references you already have.**

Primary question field:

**What are you trying to find out?**

Example placeholder:

`e.g. Why do small businesses in Nigeria struggle to survive their first five years?`

Primary CTA:

**Explore research**

Then provide a clear secondary route:

**Or start with what you have**

Entry choices:

- References
- DOI / Title
- PDF

Do not create a long menu of every Refinr feature above the fold.

### 4.2 Intent routing

The three front-door routes map to existing functionality:

**Research question -> Search by Idea**

**References -> existing reference workspace**

**DOI / Title -> existing Lookup tools**

**PDF -> existing upload/analyse flow**

The user should not have to understand that these are separate internal tools.

### 4.3 Reference route

When References is selected, reveal or focus the existing reference workspace rather than rebuilding it.

The existing actions remain available:

- Clean
- Verify
- In-text
- Lookup

Search by Idea should no longer be presented as just another equally weighted reference-tool button once the new research-question entry exists.

### 4.4 DOI / Title route

Route into the existing lookup interface. Preserve DOI/ISBN, URL and title lookup behavior.

### 4.5 Document route

Route into the existing upload interface.

Current implementation accepts PDF for actual processing but rejects Word documents as not yet supported. Iteration 1 must not advertise Word as currently usable. Public-facing upload copy should accurately say PDF until Word support actually exists.

## 5. Research-question handoff — Iteration 1

The homepage question must travel directly into the existing Search by Idea flow.

Do not make the user type the same research question twice.

Safe Iteration 1 behavior:

1. Visitor enters a question on the public front door.
2. Visitor selects Explore research.
3. Preserve the question in UI state.
4. If the visitor is not authenticated, present authentication before the paid retrieval occurs.
5. After successful authentication, resume the intended Search by Idea path with the preserved question populated.
6. Existing credit rules remain unchanged.
7. Existing legacy Search by Idea endpoint remains the retrieval path for this iteration.

Do not implement a true anonymous paid search or anonymous acquisition entitlement in this iteration. That requires a separate rate-limit, abuse, economics and security design.

The purpose of the front-door question before authentication is to create context and intent, not to bypass the current paid/authenticated retrieval model.

## 6. Search by Idea boundaries

### 6.1 Current behavior retained

Iteration 1 may improve presentation and routing around the current Search by Idea experience, but it must preserve current functional behavior:

- authentication requirement before retrieval
- current 2-credit charge
- current year filters
- current citation-style selection
- current paper retrieval endpoint
- current ability to select papers
- current View paper link
- current ability to load selected papers into references

### 6.2 Existing bridge to preserve

Current product already contains an important lifecycle bridge:

`Idea -> Papers -> References`

Do not break it.

### 6.3 Not Iteration 1

Do not expose the Phase 2A session backend merely because it exists on the feature branch.

Do not implement in Iteration 1:

- conversational refinement
- research angles generated by a new LLM flow
- persistent research projects
- Save/Reject paper lifecycle
- Next/Previous session pagination UI
- new credit model
- major-pull charging
- anonymous acquisition
- Compare/Summarize selected papers
- future research-native AI agent

These belong to later approved phases.

## 7. Result experience

Results should answer three questions clearly:

1. What did Refinr produce?
2. What can I do with it now?
3. What is the natural next step?

Do not present every possible future action as four equal buttons.

### 7.1 Existing result actions

Preserve current:

- Copy
- Share
- Accept Suggestions where applicable

### 7.2 Search result priorities

For academic paper discovery, access to the original scholarly source is a successful outcome.

`View paper` should remain obvious. Do not optimize signup at the expense of letting the user reach credible source material.

`Load selected into references` remains the bridge from discovery into Refinr's reference workflow.

### 7.3 Reference result priorities

For formatted/cleaned/citation output, Copy is a natural immediate action. Share remains secondary.

Future Save and Download/Export should be anticipated in layout but are not to be implemented merely as decorative disabled controls in Iteration 1.

## 8. Share architecture and current privacy boundary

Current frontend behavior:

- Share creation is offered to authenticated users.
- A share URL is generated in the form `?report=<id>`.
- A recipient can open the report without a Refinr account.
- The shared result is shown first.

Preserve that recipient-first principle:

> Shared result first. No recipient authentication wall.

However, the current report backend stores the shared report in a publicly readable JSONBin and has no defined expiry/revocation model. Therefore:

- Do not describe current Share as private storage.
- Do not imply confidential or unpublished research is protected by an account boundary merely because the link is hard to guess.
- Do not broaden the share feature in Iteration 1.
- A future hardening task should move shared reports to a deliberately designed storage model with ownership, revocation and optional expiry/privacy controls.
- Server-side authentication/authorization for share creation should also be reviewed separately; frontend gating alone is not a complete security boundary.

The shared-link recipient experience may later include a subtle CTA such as `Explore your own research in Refinr`, but the result itself must remain primary.

## 9. Authentication and conversion philosophy

Long-term conversion principle:

`Visitor -> value -> account`

Where economics and security allow, Refinr should ask for commitment after demonstrating value.

Iteration 1 does not yet create a full anonymous paid-search preview. Instead, it improves the motivation and continuity around the existing authentication boundary by allowing the visitor to state the research question first and preserving it through authentication.

Do not use deceptive auto-signup behavior.

Do not hold completed free work hostage solely to obtain signup.

Future account value should center on continuity, organization and preservation of work rather than merely access to a button.

## 10. Credits presentation

Credits are part of the product economy, not the primary anonymous value proposition.

For logged-in users, credit balance remains useful and visible.

For anonymous visitors, do not give the current `Verification credits: 5 remaining / Get more credits` bar prime visual prominence before they understand what Refinr does.

Iteration 1 may hide or substantially de-emphasize that bar while logged out, provided logged-in credit behavior and purchasing remain intact.

Do not change credit amounts or charging rules in this iteration.

## 11. Verification semantics — future boundary

The current verification implementation already performs real checking and produces confirmed/mismatch/not-found outcomes plus an accuracy report and Accept Suggestions behavior.

Do not cosmetically relabel these results into a new evidence taxonomy without corresponding backend semantics.

Future verification architecture may distinguish concepts such as:

- Verified
- Verified Correction
- Ambiguous
- Unverified

but this is not a visual-only change and is outside Iteration 1.

## 12. Visual system — consolidate V6, do not transplant it

The supplied `refinr_v6_source_code.txt` is an aesthetic reference and visual prototype, not the canonical functional source.

Use its winning visual decisions as the visual foundation:

- night-sky / knowledge-discovery atmosphere
- Refinr R mark and REFINR brand lockup where assets are available in the repository/current implementation
- cyan / blue / green palette
- controlled glass surfaces
- stronger visual depth
- polished cards, buttons and modals
- clear focus states
- subtle motion
- dark/light themes
- touch-friendly mobile controls
- reduced-motion support

### 12.1 Consolidation rule

Do not copy the prototype's accumulated Experience Layer + V3 + V5 + V6 override stack into production.

The prototype contains historical CSS experimentation and many later overrides/`!important` rules. Extract the final design decisions and express them as one coherent stylesheet/system inside the current application.

Avoid CSS archaeology.

### 12.2 Restraint rule

Atmosphere supports the research; it must not compete with it.

Paper titles, evidence, references, verification outcomes and source links must remain more visually important than stars, glow, glass or animation.

Use stronger atmosphere around brand/front-door areas and calmer surfaces in dense research/result areas.

## 13. Mobile requirements

Mobile is first-class, not a desktop shrink.

Iteration 1 must be checked at common narrow widths, including Android-like mobile widths.

Requirements:

- Primary question and CTA visible without confusing hierarchy.
- Touch targets remain comfortable.
- Header controls do not crowd the brand.
- Reference actions wrap/reflow cleanly.
- Modals remain usable within viewport height.
- Search result cards remain readable.
- Source links remain easy to activate without accidentally toggling card selection.
- Decorative atmosphere is quieter on small screens.
- Reduced-motion preference is respected.

Do not infer market dominance from the current small analytics sample, but do treat the observed mobile traffic as sufficient reason to test mobile seriously.

## 14. Public page structure below the first screen

Iteration 1 should reuse current components where possible rather than inventing a large marketing site.

Suggested order:

1. Research-question / intent front door
2. Existing functional workspace when an intent requires it
3. `See the transformation` proof/demo, adapted if necessary to fit the broader product story
4. Credibility/trust cue emphasizing traceability to original sources
5. Existing feedback/social/privacy footer

A future public knowledge/content layer may introduce research stories, topic pages and guides. Do not build that publishing system in Iteration 1.

## 15. Future architecture to preserve space for, not implement now

### Approved direction, later implementation

- Research Session UI using the validated Phase 2A backend
- conversational refinement via strict research actions
- Save/Reject paper lifecycle
- persistent research workspace/projects
- result preservation
- Download/export
- better shared-link recipient growth loop
- analytics event instrumentation after journey design stabilizes

### Experimental / requires separate decision

- limited anonymous research preview
- email-result workflow
- exact Save/Download formats
- public research-topic pages
- Content Intelligence integration details

### Long-term

- Nigerian university thesis/journal indexing
- research-native evidence synthesis
- institutional decision-support workflows
- geographic knowledge intelligence
- question -> evidence -> synthesis -> traceable report experience

Do not pull long-term concepts into the current engineering backlog merely because they appear in this document.

## 16. Explicitly forbidden scope for Iteration 1

Do not:

- modify production infrastructure
- merge to `main`
- deploy to production
- disable Vercel Deployment Protection
- modify Phase 2A database schema/functions
- expose production session actions
- change the current credit model
- implement the proposed future 3-credit/major-pull model
- create a React migration or framework rewrite
- create new API functions unnecessarily
- rewrite Search by Idea retrieval
- rewrite verification semantics
- implement a general chatbot or autonomous agent
- implement research projects/Save lifecycle prematurely
- replace working reference tools with mockups
- copy the entire V6 prototype stylesheet wholesale
- advertise unsupported Word processing
- describe current shared reports as private/confidential storage

## 17. Implementation safety

Before implementation:

1. Work only on `feature/search-by-idea-v2-phase1` unless a later instruction explicitly changes this.
2. Verify expected branch and HEAD.
3. Verify clean working tree.
4. Read this specification and inspect current `index.html` before mutation.
5. Preserve existing element IDs/functions/API contracts wherever possible.
6. Treat current backend functionality as working machinery, not redesign material.

After implementation:

1. Run existing automated tests/static checks relevant to the repository.
2. Perform targeted checks of the altered frontend flows.
3. Verify no production configuration/credentials were changed.
4. Report every mutated file.
5. Report any behavior intentionally changed.
6. Report any known limitations.
7. Do not merge or production-deploy without explicit approval.

## 18. Acceptance journeys

Iteration 1 is successful only if these journeys remain coherent.

### Journey A — research question, logged out

Visitor lands -> understands Refinr can discover academic research -> enters question -> Explore research -> question is preserved -> authentication occurs before paid retrieval -> after authentication user can continue the existing Search by Idea flow without retyping the question.

### Journey B — research question, logged in

User lands -> enters question -> Explore research -> existing Search by Idea flow opens/continues with question already populated -> current credit rules remain visible at the appropriate point -> retrieval works as before.

### Journey C — references

Visitor chooses References -> existing reference workspace becomes the focus -> Clean/In-text remain usable under current rules -> Verify follows current authentication/credit rules -> outputs remain copyable/shareable under current rules.

### Journey D — DOI/title

Visitor chooses DOI / Title -> existing Lookup opens -> result can flow into the reference workspace as it does today.

### Journey E — PDF

Visitor chooses PDF -> current authentication rule applies -> upload copy accurately describes PDF support -> current extraction/options behavior remains functional.

### Journey F — shared link

Recipient opens an existing shared report link -> result is visible without authentication -> Share is not falsely described as private -> result remains the primary content.

### Journey G — mobile

At narrow width, user can understand the first screen, enter a question, select alternate routes, authenticate, use the reference workspace and read result cards without horizontal overflow or unusable controls.

### Journey H — existing user

Returning authenticated user retains session display, credit balance, account dropdown, payment access and existing tools after the redesign.

## 19. Definition of done

Iteration 1 is done when Refinr feels like one research journey rather than a collection of unrelated utilities, while existing functional behavior remains intact.

The intended mental model is:

`What are you working on?`

-> Research idea -> Discover research

-> References -> Clean / Verify / Cite

-> Paper / PDF -> Lookup / Analyse

and all routes lead toward useful research work rather than feature-menu navigation.

The visual identity should feel recognizably Refinr, using the strongest parts of the V6 direction, but the product's evidence and research content must remain the centre of attention.

---

Implementation reminder: architecture first, evidence second, visual polish third. Do not trade credibility or working functionality for aesthetic novelty.