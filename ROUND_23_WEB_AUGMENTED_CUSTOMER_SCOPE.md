# Round 23 — Web-Augmented Customer Creation

Authored: 2026-05-10 (Claude session)
Status: **Spec only.** Triggered by Michael's question: "Add a new customer Plymouth Square in Detroit and it finds the address phone number anything needed?"

Held until after deploy (Round 22) — needs production-grade web search before being safe to ship to real customers.

---

## The question

Naive answer ("yes, AI does a Google search"): bad. Hallucinated phone numbers get real wrong-number calls. Stale Yellow Pages data lands in your DB. Multiple businesses with the same name → wrong entity attached.

Right answer: AI returns **candidates with sources**, user picks one before save. The propose-then-confirm pattern from Round 16 already supports this — we just enrich the proposal with web-fetched options.

---

## How it works

User in chat: *"add Plymouth Square Apartments in Detroit as a customer"*

Server:
1. Keyword matcher detects "add ... customer" → triggers `create_customer` flow
2. Before showing confirmation card, server calls a new `enrichEntity({ name, location_hint })` helper that:
   - Searches the web for `"Plymouth Square Apartments" Detroit` (use whatever search API we wire)
   - Returns the top 3 results with: name, address, phone, website, source URL
3. Confirmation card now shows candidates instead of (or in addition to) bare summary lines:

```
I found 2 matches for "Plymouth Square Apartments Detroit":

  ○ Plymouth Square Apartments
    4400 Plymouth Rd, Detroit MI 48227
    (313) 555-1234 · plymouthsquareapts.com
    source: yelp.com/biz/plymouth-square-detroit

  ○ Plymouth Square Co-op
    1234 Different St, Detroit MI 48228  
    (313) 555-5678
    source: detroit.gov/co-ops/plymouth-square

  ○ Enter manually instead

[Confirm with selection]  [Cancel]
```

4. User clicks one of the candidate radio buttons.
5. Confirmation submits `{ confirmation_id, accept: true, candidate_index: 0 }` — server uses that candidate's data to perform the create.

---

## Web-fetch options

In rough order of suitability:

| Option | Cost | Reliability | Notes |
|---|---|---|---|
| Brave Search API | Free tier 2k/mo, then $3/1k | Good | Easy to wire, no Google T&C issues |
| Google Custom Search API | $5/1k, 100/day free | Best results | Has CSE setup overhead |
| SerpAPI | $50/mo for 5k searches | Best UX | Wrapper around Google, expensive |
| Direct site scraping (Yelp / Yellow Pages) | Free | Brittle, ToS-borderline | Skip |

**Recommendation:** Brave Search API for v1 — cheap, no auth dance, JSON results. Move to Google CSE if quality is insufficient.

For the actual entity details (address, phone), search results often include the data in the snippet/meta. Where they don't, second pass: WebFetch the top result URL and let the LLM extract structured fields with the existing AI extraction layer (services/ai.js).

---

## Architecture

### Server
- New service: `src/services/web-enrichment.js`
  - `searchEntity(name, location_hint)` → top 3 candidates with name, source URL, snippet
  - `extractEntityDetails(url)` → uses AI extraction to pull phone/email/address from a fetched page
  - Cache results in a new `entity_cache` table keyed by query (TTL 30 days) so the same business doesn't get re-searched
- Update `proposeCreateCustomer` in `src/services/ai-tools.js`:
  - If args contain only a name + location hint and no concrete fields, call `searchEntity` first
  - Build a `candidates` array, attach to the confirmation payload
- Update `executeCreateCustomer`: accept `candidate_index` and use that candidate's resolved fields

### Client
- Update `renderConfirmCard` in `public/js/ai-chat.js` to handle a new optional `candidates` array on confirm payloads. Render as radio buttons. When user picks a radio, the Confirm button submits with `candidate_index` selected.
- "Enter manually instead" radio falls through to the existing summary_lines flow with whatever args the AI parsed.

### Permissions
- Manager + admin only (matches `create_customer`)
- Workers don't get web search

---

## Other entities this works for

Same pattern applies to:
- `create_vendor` ("add Eastern Electric as a vendor" → finds website + phone)
- `create_job` (less useful — addresses come from the customer)
- Looking up a customer's existing data when asked "who is Plymouth Square again?" (a search tool, not a mutation)

Phase 1 (this round): just `create_customer` and `create_vendor`. Add others if useful.

---

## Cost guardrails

- Cache aggressively (30-day TTL)
- Reject queries with fewer than 3 chars
- Rate limit per user (10 enrichment-backed proposals per hour)
- Show the "I'll search the web for this" affordance in the proposal flow so the user knows it's happening — they can opt out by entering full details manually
- Track web search usage in the existing `/admin/ai-usage` page so cost is visible

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hallucinated phone number entered as fact | Always show source URL; user must click a candidate radio |
| Wrong Plymouth Square chosen | Show top 3 with disambiguating address + source |
| Stale data | Source attribution lets user double-check; cache TTL 30d |
| Privacy / data terms | Use Brave/Google official APIs, never scrape Yelp directly |
| Cost runaway | Cache + rate limit + admin visibility |

---

## Smoke tests

1. As manager, "add Plymouth Square Apartments in Detroit as a customer" → 2-3 candidates with sources.
2. Pick first candidate → customer created with that data.
3. Same query again within 30 days → cache hit, same candidates, no API call (verify in usage page).
4. "Enter manually instead" radio → falls back to standard summary_lines flow.
5. Worker tries the same → polite refusal (manager+ only).
6. Search returns zero results → falls back to "no candidates found, enter manually."
7. Network error from search API → graceful fallback to manual entry; chat reply explains.
8. Rate limit triggered (11th in an hour) → polite limit message.

---

## Estimated effort

- Brave Search API integration: ~1 hour
- entity_cache table + caching logic: ~1 hour
- proposeCreateCustomer enrichment branch: ~1.5 hours
- Client confirm card with candidates: ~1.5 hours
- Tests + cleanup: ~1 hour

**Total: ~6 hours. Round-22 deploy should land first since this needs a production env to test the search API key handling.**

---

## Verdict on Michael's "is that just doing too much?"

It's the right amount of "AI augmentation" — exactly the kind of task where AI saves real typing. The trick is the suggest-then-confirm pattern keeps it safe. Naive auto-fill would be doing too much; sourced-candidates with explicit user choice is doing it right.

Build it after deploy. Until then it's cleanly held in this scope doc.

— Claude
