export type LintRule =
  | 'vocabulary-in-check'
  | 'named-column'
  | 'named-object'
  | 'forbidden-routine'
  | 'registry-seed'
  | 'leaky-comment'
  | 'pack-carries-judgement'

export type LintFinding = {
  file: string
  line: number
  rule: LintRule
  detail: string
}

export type LintOptions = {
  /** Names the leaky-comment rule rejects. Defaults to the placeholder list. */
  companyNames?: readonly string[]
}
