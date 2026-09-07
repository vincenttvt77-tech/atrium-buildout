import type { KnowledgeArticle } from './article.ts'

/**
 * Ranks approved articles against what the caller actually asked.
 *
 * Without this the agent picks the first article filed under the topic, which is how
 * "what are the gym hours" gets answered with the leasing office's hours — approved,
 * fluent, and wrong. A confidently wrong answer is worse than a refusal, because the
 * caller has no reason to doubt it.
 *
 * Deliberately lexical rather than embedding-based. The corpus per property is a hundred
 * articles, the questions are short and concrete, and a scoring function that can be read
 * and tested beats a similarity score nobody can explain when it misfires on a call.
 */

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'how', 'i', 'if', 'in',
  'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'their', 'them', 'there',
  'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'will', 'with', 'would', 'you', 'your', 'am', 'any', 'about', 'please', 'tell', 'know',
])

/** Light stemming: enough to tie "dogs" to "dog" and "heated" to "heat" without a library. */
function stem(word: string): string {
  if (word.length <= 3) return word
  for (const suffix of ['ing', 'ies', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, -suffix.length)
      return suffix === 'ies' ? `${base}y` : base
    }
  }
  return word
}

export function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
}

export interface Ranked {
  article: KnowledgeArticle
  score: number
}

/**
 * Scores each article and returns them best-first, along with a normalised confidence for
 * the top hit. The confidence feeds the property's threshold, so a property that wants the
 * agent to be more cautious simply raises it.
 */
/**
 * Scores each article and returns them best-first, along with a normalised confidence for
 * the top hit. The confidence feeds the property's threshold, so a property that wants the
 * agent to be more cautious simply raises it.
 */
export function retrieve(
  question: string, candidates: KnowledgeArticle[],
): { ranked: Ranked[]; confidence: number } {
  const asked = tokenize(question)
  if (asked.length === 0 || candidates.length === 0) return { ranked: [], confidence: 0 }
  const askedSet = new Set(asked)

  const fields = candidates.map((article) => ({
    article,
    inQuestion: new Set(tokenize(article.question)),
    inAnswer: new Set(tokenize(article.answer)),
    keywords: new Set((article.keywords ?? []).flatMap((k) => tokenize(k))),
  }))

  /*
   * Weight each term by how rare it is across this property's corpus.
   *
   * Without it, "can I use the coworking space" scores the same for "coworking" as for
   * "use" and "space" — words in half the articles — and two dead weights drag a correct
   * match below the confidence threshold into a needless refusal. Rare terms are what the
   * caller is actually asking about.
   */
  const weight = new Map<string, number>()
  for (const term of askedSet) {
    const df = fields.filter(
      (f) => f.inQuestion.has(term) || f.inAnswer.has(term) || f.keywords.has(term),
    ).length
    // Unseen terms still carry full weight: a word in no article is highly specific, and
    // failing to find it is exactly what should lower confidence.
    weight.set(term, Math.log(1 + candidates.length / (1 + df)))
  }

  const totalWeight = [...askedSet].reduce((s, t) => s + (weight.get(t) ?? 0), 0)
  if (totalWeight === 0) return { ranked: [], confidence: 0 }

  const scored = fields.map((f) => {
    let score = 0
    let foundWeight = 0
    let titleWeight = 0

    for (const term of askedSet) {
      const w = weight.get(term) ?? 0
      // A term matching the article's own question or keywords is far stronger evidence
      // than one appearing somewhere in its body.
      if (f.inQuestion.has(term) || f.keywords.has(term)) {
        score += 3 * w
        titleWeight += w
        foundWeight += w
      } else if (f.inAnswer.has(term)) {
        score += 1 * w
        foundWeight += w
      }
    }

    // Reward articles whose question is largely covered by what was asked, so a short
    // precise article beats a long one that happens to mention the same words.
    const covered = [...f.inQuestion].filter((t) => askedSet.has(t)).length
    if (f.inQuestion.size > 0) score += 2 * (covered / f.inQuestion.size)

    return { article: f.article, score, foundWeight, titleWeight }
  })

  const ranked = scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score)
  if (ranked.length === 0) return { ranked: [], confidence: 0 }

  const best = ranked[0]!

  /*
   * Confidence answers "how much of what they asked did we actually find", not "how close
   * is this to a perfect score". Normalising against a perfect score punishes every real
   * question: "what are the gym hours" can never have both terms in an article titled
   * "What time does the gym open?", so a correct match scored 0.46 and got refused.
   */
  let confidence = 0.5 * (best.foundWeight / totalWeight) + 0.5 * (best.titleWeight / totalWeight)

  // A close second means the corpus does not clearly distinguish them; say so by lowering
  // confidence rather than picking one and sounding certain.
  const second = ranked[1]?.score ?? 0
  if (second > 0 && best.score - second < 0.15 * best.score) confidence *= 0.85

  return {
    ranked: ranked.map(({ article, score }) => ({ article, score })),
    confidence: Math.min(1, confidence),
  }
}
