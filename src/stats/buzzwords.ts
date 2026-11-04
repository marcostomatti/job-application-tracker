/**
 * Words that say nothing about a market: English function words, and the words nearly every
 * posting uses about itself. A term is kept only when it is not one of these.
 */
const STOPWORDS = new Set(
  (
    'a about above after again all also am an and any are as at be been before being below between both but by can could did do does ' +
    'doing down during each etc few for from further had has have having he her here hers him his how i if in into is it its itself ' +
    'just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the ' +
    'their theirs them then there these they this those through to too under until up very was we were what when where which while who ' +
    'whom why will with would you your yours ' +
    'ability able across apply applicant applicants candidate candidates company day days years year experience experienced ' +
    'good great help join looking must new opportunity part per plus position preferred required requirements responsibilities ' +
    'role roles skills strong team teams use using work working within well want based including include includes like make ' +
    'ensure environment knowledge level offer people provide role-based similar support time understanding way'
  ).split(/\s+/),
)

const MIN_TERM_LENGTH = 3

/** How many terms the cloud keeps. */
export const BUZZWORD_LIMIT = 40

/** The distinct terms of one text: lower-cased words of letters, digits and `+#.-`, trimmed of edge punctuation. */
export function termsOf(text: string): Set<string> {
  const terms = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}+#.-]+/u)) {
    const term = raw.replace(/^[.-]+|[.-]+$/g, '')
    if ((term.length < MIN_TERM_LENGTH && !/[+#]/.test(term)) || term.length < 2 || STOPWORDS.has(term) || /^\d+$/.test(term)) continue
    terms.add(term)
  }
  return terms
}

/**
 * The most common terms across texts, by how many texts use each (a term repeated in one
 * posting counts once), most common first, ties alphabetical. A term in a single text is left
 * out: it is that posting's word, not the market's.
 */
export function buzzwords(texts: readonly string[], limit: number = BUZZWORD_LIMIT): { label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const text of texts) for (const term of termsOf(text)) counts.set(term, (counts.get(term) ?? 0) + 1)
  return [...counts]
    .filter(([, count]) => count > 1)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }))
}
