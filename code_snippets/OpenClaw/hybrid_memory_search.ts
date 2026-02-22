/**
 * Hybrid Memory Search (Vector + FTS + Temporal Decay)
 *
 * Pattern: Combine vector and keyword search with weighted merging.
 * From: OpenClaw src/memory/manager.ts
 *
 * Key ideas:
 * - Vector search catches semantic similarity (paraphrases, concepts)
 * - FTS/keyword search catches exact terms (names, IDs, codes)
 * - Weighted merge combines both ranking signals
 * - Temporal decay down-weights older memories
 * - MMR (Maximal Marginal Relevance) promotes diversity
 * - Graceful degradation: FTS-only mode if no embedding provider
 */

// --- Types ---

interface MemorySearchResult {
  id: string;
  path: string;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
  source: string;
  updatedAt?: number; // timestamp ms
}

interface VectorResult extends MemorySearchResult {
  vectorScore: number;
}

interface KeywordResult extends MemorySearchResult {
  textScore: number;
}

interface HybridConfig {
  enabled: boolean;
  vectorWeight: number;   // Default ~0.7
  textWeight: number;     // Default ~0.3
  candidateMultiplier: number; // Fetch more candidates than needed, then re-rank
  mmr?: {
    enabled: boolean;
    lambda: number;        // Balance relevance vs diversity (0=diverse, 1=relevant)
  };
  temporalDecay?: {
    enabled: boolean;
    halfLifeDays: number;  // Memories lose half their score every N days
  };
}

interface SearchConfig {
  minScore: number;    // Default ~0.3
  maxResults: number;  // Default ~5
  hybrid: HybridConfig;
}

// --- Keyword extraction ---

function extractKeywords(query: string): string[] {
  // Simple keyword extraction: split on whitespace, remove stop words, deduplicate
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "in", "on", "at",
    "to", "for", "of", "with", "and", "or", "not", "this", "that",
    "what", "how", "when", "where", "who", "which",
  ]);

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .filter((word, i, arr) => arr.indexOf(word) === i); // deduplicate
}

// --- Temporal decay ---

function applyTemporalDecay(
  score: number,
  updatedAt: number | undefined,
  halfLifeDays: number,
): number {
  if (!updatedAt) return score;

  const ageMs = Date.now() - updatedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decayFactor = Math.pow(0.5, ageDays / halfLifeDays);

  return score * decayFactor;
}

// --- MMR (Maximal Marginal Relevance) ---

function cosineSimilarity(a: string, b: string): number {
  // Simple character-level Jaccard similarity as proxy
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function applyMMR(
  results: MemorySearchResult[],
  lambda: number,
  maxResults: number,
): MemorySearchResult[] {
  if (results.length <= 1) return results;

  const selected: MemorySearchResult[] = [];
  const remaining = [...results];

  // Always select the highest-scoring result first
  selected.push(remaining.shift()!);

  while (selected.length < maxResults && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const relevance = candidate.score;

      // Max similarity to any already-selected result
      const maxSim = Math.max(
        ...selected.map((s) => cosineSimilarity(candidate.snippet, s.snippet)),
      );

      // MMR score: balance relevance vs diversity
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }

  return selected;
}

// --- Hybrid merge ---

function mergeHybridResults(params: {
  vector: VectorResult[];
  keyword: KeywordResult[];
  vectorWeight: number;
  textWeight: number;
  mmr?: { enabled: boolean; lambda: number };
  temporalDecay?: { enabled: boolean; halfLifeDays: number };
}): MemorySearchResult[] {
  const { vector, keyword, vectorWeight, textWeight } = params;

  // Build lookup maps
  const vectorMap = new Map(vector.map((r) => [r.id, r]));
  const keywordMap = new Map(keyword.map((r) => [r.id, r]));

  // Collect all unique IDs
  const allIds = new Set([...vectorMap.keys(), ...keywordMap.keys()]);

  // Compute hybrid score for each result
  const merged: MemorySearchResult[] = [];

  for (const id of allIds) {
    const vecResult = vectorMap.get(id);
    const kwResult = keywordMap.get(id);

    const vecScore = vecResult?.vectorScore ?? 0;
    const kwScore = kwResult?.textScore ?? 0;

    // Weighted combination
    let hybridScore = vecScore * vectorWeight + kwScore * textWeight;

    // Apply temporal decay
    const updatedAt = vecResult?.updatedAt ?? kwResult?.updatedAt;
    if (params.temporalDecay?.enabled && updatedAt) {
      hybridScore = applyTemporalDecay(
        hybridScore,
        updatedAt,
        params.temporalDecay.halfLifeDays,
      );
    }

    const base = vecResult ?? kwResult!;
    merged.push({ ...base, score: hybridScore });
  }

  // Sort by hybrid score
  merged.sort((a, b) => b.score - a.score);

  // Apply MMR if enabled
  if (params.mmr?.enabled) {
    return applyMMR(merged, params.mmr.lambda, merged.length);
  }

  return merged;
}

// --- Main search function ---

async function hybridSearch(params: {
  query: string;
  config: SearchConfig;
  searchVector: (queryVec: number[], limit: number) => Promise<VectorResult[]>;
  searchKeyword: (query: string, limit: number) => Promise<KeywordResult[]>;
  embedQuery: (query: string) => Promise<number[]>;
  hasEmbeddingProvider: boolean;
}): Promise<MemorySearchResult[]> {
  const { query, config, searchVector, searchKeyword, embedQuery } = params;
  const { minScore, maxResults, hybrid } = config;

  const cleaned = query.trim();
  if (!cleaned) return [];

  const candidates = Math.min(
    200,
    Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
  );

  // --- FTS-only mode (no embedding provider) ---
  if (!params.hasEmbeddingProvider) {
    const keywords = extractKeywords(cleaned);
    const searchTerms = keywords.length > 0 ? keywords : [cleaned];

    // Search with each keyword and merge
    const resultSets = await Promise.all(
      searchTerms.map((term) => searchKeyword(term, candidates).catch(() => [])),
    );

    // Merge and deduplicate
    const seenIds = new Map<string, MemorySearchResult>();
    for (const results of resultSets) {
      for (const result of results) {
        const existing = seenIds.get(result.id);
        if (!existing || result.score > existing.score) {
          seenIds.set(result.id, result);
        }
      }
    }

    return [...seenIds.values()]
      .sort((a, b) => b.score - a.score)
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults);
  }

  // --- Hybrid mode: vector + keyword ---
  const [keywordResults, queryVec] = await Promise.all([
    hybrid.enabled ? searchKeyword(cleaned, candidates).catch(() => []) : [],
    embedQuery(cleaned),
  ]);

  const hasVector = queryVec.some((v) => v !== 0);
  const vectorResults = hasVector
    ? await searchVector(queryVec, candidates).catch(() => [])
    : [];

  // If hybrid is disabled, use vector-only
  if (!hybrid.enabled) {
    return vectorResults
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults);
  }

  // Merge hybrid results
  const merged = mergeHybridResults({
    vector: vectorResults,
    keyword: keywordResults,
    vectorWeight: hybrid.vectorWeight,
    textWeight: hybrid.textWeight,
    mmr: hybrid.mmr,
    temporalDecay: hybrid.temporalDecay,
  });

  return merged
    .filter((entry) => entry.score >= minScore)
    .slice(0, maxResults);
}

// --- Usage example ---

/*
const config: SearchConfig = {
  minScore: 0.3,
  maxResults: 5,
  hybrid: {
    enabled: true,
    vectorWeight: 0.7,
    textWeight: 0.3,
    candidateMultiplier: 4,
    mmr: { enabled: true, lambda: 0.7 },
    temporalDecay: { enabled: true, halfLifeDays: 30 },
  },
};

const results = await hybridSearch({
  query: "How does the authentication system work?",
  config,
  searchVector: async (vec, limit) => {
    // Query sqlite-vec or pgvector
    return await db.vectorSearch(vec, limit);
  },
  searchKeyword: async (query, limit) => {
    // Query FTS5 table
    return await db.ftsSearch(query, limit);
  },
  embedQuery: async (query) => {
    // Call OpenAI/Voyage/Gemini embeddings API
    return await embeddingProvider.embed(query);
  },
  hasEmbeddingProvider: true,
});
*/
