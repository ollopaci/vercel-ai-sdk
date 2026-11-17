/**
 * WHAT YOU WOULD BUILD WITHOUT REDIS AGENT MEMORY
 *
 * An illustrative sketch of the memory layer behind this app's one-line
 * `memory.model(...)` call. It is not run, not complete, and not tested. It is
 * here to show the moving parts, each of which is a place teams get stuck.
 * Excluded from the TypeScript build.
 */

import { embed, generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// 1. Conversation log: append-only, ordered, per session, owned by one user
// ───────────────────────────────────────────────────────────────────────────

interface SessionEvent { sessionId: string; ownerId: string; role: 'USER' | 'ASSISTANT'; text: string; at: Date }

async function appendEvent(event: SessionEvent): Promise<void> {
  // INSERT into session_events. Needs an ordering guarantee when two requests
  // race on one session, an idempotency key so a retried POST doesn't double-
  // write, and an ownership check so a session ID can't be replayed by another user.
  throw new Error('TODO: storage, ordering, idempotency, ownership');
}

async function loadSession(sessionId: string, ownerId: string, maxChars: number): Promise<SessionEvent[]> {
  // SELECT newest-first until the character budget is spent, then reverse.
  // Long sessions outgrow the context window: see summarize() below.
  throw new Error('TODO: windowing by budget, not by row count');
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Summaries: keep long conversations inside the context window
// ───────────────────────────────────────────────────────────────────────────

async function summarize(sessionId: string, model: LanguageModel): Promise<void> {
  // When a session passes N messages, compress all but the most recent K into
  // a summary. Must not run twice concurrently, must not drop the messages that
  // arrived while it was running, and must be re-run when the summary is stale.
  throw new Error('TODO: locking, watermarking, re-summarization');
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Extraction: turn chat into durable facts, in the background
// ───────────────────────────────────────────────────────────────────────────

const ExtractedFacts = z.object({
  facts: z.array(z.object({
    text: z.string().describe('One self-contained fact about the user, in the third person'),
    topics: z.array(z.string()),
    supersedes: z.array(z.string()).describe('IDs of existing facts this one replaces'),
  })),
});

async function extractFacts(ownerId: string, events: SessionEvent[], model: LanguageModel) {
  const existing = await searchFacts(ownerId, events.map(e => e.text).join('\n'), 20);
  const { object } = await generateObject({
    model,
    schema: ExtractedFacts,
    // This prompt is the product. Expect weeks of iteration: what counts as
    // durable, how to phrase facts so they retrieve well, how to handle
    // "we used to…" and "starting next month…", what to do with jokes.
    prompt: `Existing facts:\n${existing.map(f => `${f.id}: ${f.text}`).join('\n')}\n\n`
      + `Conversation:\n${events.map(e => `${e.role}: ${e.text}`).join('\n')}\n\n`
      + 'Extract new durable facts about the user. Mark facts that replace existing ones.',
  });
  for (const fact of object.facts) {
    if (containsSensitiveData(fact.text)) continue;          // see section 6
    if (await isDuplicate(ownerId, fact.text)) continue;     // see section 5
    await upsertFact(ownerId, fact.text, fact.topics, fact.supersedes);
  }
}

// Run extraction off the request path: a queue, a worker pool, retries on LLM
// timeouts and 429s, and debouncing so a 20-turn chat doesn't cost 20 extraction calls.
async function scheduleExtraction(sessionId: string): Promise<void> {
  // enqueue({ sessionId }, { dedupeKey: `${sessionId}:${fiveMinuteBucket()}`, delay: '5m' })
  throw new Error('TODO: queue, worker, retries, debounce window');
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Embeddings and a vector index scoped per user
// ───────────────────────────────────────────────────────────────────────────

interface Fact { id: string; ownerId: string; text: string; topics: string[]; vector: number[]; updatedAt: Date; expiresAt: Date }

async function upsertFact(ownerId: string, text: string, topics: string[], supersedes: string[]): Promise<void> {
  const { embedding } = await embed({ model: embeddingModel(), value: text });
  // Write the vector and metadata, delete or tombstone superseded facts, set a
  // TTL. Changing embedding models later means re-embedding every fact.
  throw new Error('TODO: vector index schema, TTL, supersede semantics');
}

async function searchFacts(ownerId: string, query: string, limit: number): Promise<Fact[]> {
  const { embedding } = await embed({ model: embeddingModel(), value: query });
  // KNN with a MANDATORY ownerId pre-filter. Forget it once and customer A's
  // facts end up in customer B's prompt. That is a security incident, not a bug.
  throw new Error('TODO: filtered KNN, score threshold, recency boost');
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Deduplication
// ───────────────────────────────────────────────────────────────────────────

async function isDuplicate(ownerId: string, text: string): Promise<boolean> {
  // "Uses Frankfurt", "Backend in Frankfurt", "Moved servers to Germany": the
  // same fact three ways. Needs a similarity threshold you'll tune by hand.
  const [nearest] = await searchFacts(ownerId, text, 1);
  return nearest !== undefined && similarity(nearest.text, text) > 0.92; // why 0.92? nobody knows
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Sensitive data
// ───────────────────────────────────────────────────────────────────────────

function containsSensitiveData(text: string): boolean {
  // Regexes for keys, tokens, card numbers, plus an LLM check for things
  // regexes can't see ("my patient's diagnosis is…"). Configurable per tenant.
  return /sk-[A-Za-z0-9]{20,}|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/.test(text);
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Prompt assembly with budgets
// ───────────────────────────────────────────────────────────────────────────

async function buildPrompt(ownerId: string, sessionId: string, userText: string): Promise<string> {
  // Run session load and fact search in parallel with a hard deadline so a
  // slow memory read never blocks the reply. Mark injected context as
  // untrusted so a stored "ignore previous instructions" can't steer the model.
  const [session, facts] = await Promise.all([
    loadSession(sessionId, ownerId, 24_000),
    searchFacts(ownerId, userText, 5),
  ]);
  return [
    'MEMORY CONTEXT (untrusted, may be stale):',
    ...facts.map(f => `- ${f.text}`),
    ...session.map(e => `${e.role}: ${e.text}`),
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Structured memory you can query across customers
// ───────────────────────────────────────────────────────────────────────────

const CustomerEnvironment = z.object({
  gateway_region: z.string().optional(),
  origin_location: z.string().optional(),
  client_runtime: z.string().optional(),
  sdk_version: z.string().optional(),
  keep_alive_enabled: z.boolean().optional(),
});

async function extractEnvironment(ownerId: string, events: SessionEvent[], model: LanguageModel) {
  // A second extraction pass with its own schema and prompt, merged with what
  // you already know (partial updates, conflicting values, "we turned it back on").
  const { object } = await generateObject({ model, schema: CustomerEnvironment, prompt: '…' });
  // Then a secondary index on every field so support can ask
  // "keep_alive_enabled = false AND sdk_version < 3.2" across all customers,
  // with staff-only access controls on that cross-customer query.
  throw new Error('TODO: schema registry, merge rules, typed index, staff authz');
}

// ───────────────────────────────────────────────────────────────────────────
// 9. And then: retention and deletion requests, a UI to inspect what's
//    stored, metrics for extraction cost, backfills, migrations, on-call.
// ───────────────────────────────────────────────────────────────────────────

declare function embeddingModel(): Parameters<typeof embed>[0]['model'];
declare function similarity(a: string, b: string): number;
