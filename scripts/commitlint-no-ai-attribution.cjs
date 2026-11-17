/**
 * @fileoverview A commitlint plugin that refuses a commit message naming an AI tool as its author or its reviewer.
 * @layer scripts
 *
 * Wire it in the commitlint configuration:
 *
 *   plugins: [require('./scripts/commitlint-no-ai-attribution.cjs')],
 *   rules: { 'no-ai-attribution': [2, 'always'] },
 *
 * A repository on the narrow profile builds the plugin with `require(...).build('narrow')` instead.
 */
'use strict'

/** The strict profile: every repository but the narrow ones. */
const STRICT =
  '(?im)(^[ \\t>*_`-]*(\\d+[.)][ \\t]*)?[*_`]*[a-z][a-z-]*-by[*_`]*[ \\t]*:(([^\\n]*[^a-z0-9])?(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|[ \\t]*(ai|llm)[ \\t]*(<[^>\\n]*>)?[ \\t]*\\r?$)|noreply@(anthropic|openai|claude)\\.|(^|[^a-z0-9])(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)\\[bot\\]|^[ \\t>*_-]*(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)[ -]bot[ \\t.]*\\r?$|🤖([^\\n]*[^a-z0-9])?(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\b(made|built|crafted)\\s+with\\s+[^\\n]{1,12}\\s+and\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\bwith\\s+(the\\s+)?help\\s+(of|from)\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\b(thanks\\s+to|courtesy\\s+of|powered\\s+by)\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\bpair[- ]programm(ed|ing)\\s+with\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|(^|[^a-z0-9])(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)\\s+(reviewed|wrote|authored|generated|created|co-authored|approved|drafted|suggested|proposed)\\s+(this|it|these|the\\s+(change|commit|pr|patch|code))\\b|\\b(review|approval|authorship|co-authorship|assistance|sign-off)\\s+(by|from)\\s+(the\\s+)?(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|^[ \\t>*_-]*[\\[(]?(ai[- ](generated|assisted|authored|written)|(generated|assisted|authored|written|created|made)\\s+(with|by)\\s+ai)[\\])]?[ \\t.]*\\r?$|\\b((generated|authored|co-authored|assisted|drafted|created|produced)\\s+(with|by|using|via|through)|(reviewed|approved|audited|verified|checked|proposed|suggested)\\s+by|(written|made|built|fixed|implemented)\\s+by)[\\s:*_`"\'\\[(@<>{}~|“”‘’-]+((the|a|an|our|my|new|latest|github|google|microsoft|meta|amazon|open|our own|ai)[\\s:*_`"\'\\[(@<>{}~|“”‘’-]+)*(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|^[ \\t>*_`(\\[-]*(\\d+[.)][ \\t]*)?(written)\\s+(by|with)[\\s:*_`"\'\\[(@<>{}~|“”‘’-]+((the|a|an|our|my|new|latest|github|google|microsoft|meta|amazon|open|our own|ai)[\\s:*_`"\'\\[(@<>{}~|“”‘’-]+)*(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|(^|[^a-z0-9])(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)[ -](agent|assistant)\\b|(^|[^@\\w])(codex|anthropic|chatgpt)\\b|\\bclaude([^.]|$))'

/** The narrow profile: a repository whose subject matter names the products. */
const NARROW =
  '(?im)(^[ \\t>*_`-]*(\\d+[.)][ \\t]*)?[*_`]*[a-z][a-z-]*-by[*_`]*[ \\t]*:(([^\\n]*[^a-z0-9])?(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|[ \\t]*(ai|llm)[ \\t]*(<[^>\\n]*>)?[ \\t]*\\r?$)|noreply@(anthropic|openai|claude)\\.|(^|[^a-z0-9])(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)\\[bot\\]|^[ \\t>*_-]*(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)[ -]bot[ \\t.]*\\r?$|🤖([^\\n]*[^a-z0-9])?(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\b(made|built|crafted)\\s+with\\s+[^\\n]{1,12}\\s+and\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\bwith\\s+(the\\s+)?help\\s+(of|from)\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\b(thanks\\s+to|courtesy\\s+of|powered\\s+by)\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\bpair[- ]programm(ed|ing)\\s+with\\s+(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|(^|[^a-z0-9])(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)\\s+(reviewed|wrote|authored|generated|created|co-authored|approved|drafted|suggested|proposed)\\s+(this|it|these|the\\s+(change|commit|pr|patch|code))\\b|\\b(review|approval|authorship|co-authorship|assistance|sign-off)\\s+(by|from)\\s+(the\\s+)?(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|^[ \\t>*_-]*[\\[(]?(ai[- ](generated|assisted|authored|written)|(generated|assisted|authored|written|created|made)\\s+(with|by)\\s+ai)[\\])]?[ \\t.]*\\r?$|^[ \\t>*_`(\\[-]*(\\d+[.)][ \\t]*)?((generated|authored|co-authored|assisted|drafted|created|produced)\\s+(with|by|using|via|through)|(reviewed|approved|audited|verified|checked|proposed|suggested)\\s+by|(written)\\s+(by|with))[\\s:*_`"\'\\[(@<>{}~|“”‘’-]+((the|a|an|our|my|new|latest|github|google|microsoft|meta|amazon|open|our own|ai)[\\s:*_`"\'\\[(@<>{}~|“”‘’-]+)*(claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|windsurf|devin|aider|codeium|tabnine|bard|grok|deepseek|mistral|kiro|perplexity|cursoragent|chat gpt|chat-gpt|open ai|open-ai|github copilot|github-copilot|google gemini|microsoft copilot)([^a-z0-9]|$)|\\b(claude|codex)\\s*(\\+|and|&|/|,)\\s*(claude|codex)\\b|\\b(claude|codex)\\b[^\\n]{0,20}\\b(review|reviews|pass|reviewer|bot|finding|findings)\\b)'

/**
 * The JavaScript form of a pattern: the leading `(?im)` becomes the `im` flags.
 *
 * @param {string} pattern A pattern as the organisation rulesets carry it.
 * @returns {RegExp} The same pattern as a regular expression.
 */
function compile(pattern) {
  return new RegExp(pattern.slice('(?im)'.length), 'im')
}

/** The line git writes above the diff under `git commit -v`, with exactly this many dashes. */
const SCISSORS = '# ------------------------ >8 ------------------------'

/**
 * The text the rule reads. commitlint's own view of the message (its header, body and footer, which it reads with the
 * comment character of the repository's git configuration) when it gives one; otherwise the raw text, all of it up
 * to the scissors line, so a message the rule cannot split is read whole and not in part.
 *
 * @param {{ raw?: string, header?: string | null, body?: string | null, footer?: string | null }} parsed
 *   The commit as commitlint parsed it.
 * @returns {string} The text to read.
 */
function messageOf(parsed) {
  const parts = [parsed.header, parsed.body, parsed.footer].filter(
    (part) => typeof part === 'string' && part !== '',
  )
  if (parts.length > 0) return parts.join('\n')
  const lines = (parsed.raw ?? '').split(/\r?\n/)
  const end = lines.indexOf(SCISSORS)
  return (end === -1 ? lines : lines.slice(0, end)).join('\n')
}

/**
 * The text shown to the committer on one line: a control character or a line or paragraph separator becomes a space.
 *
 * @param {string} text The text that matched.
 * @returns {string} At most 80 characters on one line.
 */
function oneLine(text) {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0)
    return code < 32 || (code >= 127 && code <= 133) || code === 0x2028 || code === 0x2029
      ? ' '
      : character
  })
    .join('')
    .slice(0, 80)
}

/**
 * The plugin for one profile.
 *
 * @param {'strict' | 'narrow'} [profile] The profile to apply; strict when omitted.
 * @returns {{ rules: Record<string, (parsed: { raw?: string }) => [boolean, string?]> }} A commitlint plugin.
 */
function build(profile = 'strict') {
  if (profile !== 'strict' && profile !== 'narrow')
    throw new Error('the profile must be strict or narrow')
  const pattern = compile(profile === 'narrow' ? NARROW : STRICT)
  return {
    rules: {
      'no-ai-attribution': (parsed, when = 'always') => {
        if (when !== 'always')
          throw new Error(
            "no-ai-attribution has an always form only: configure it as [2, 'always']",
          )
        const match = pattern.exec(messageOf(parsed))
        if (match === null) return [true]
        const found = oneLine(match[0])
        return [
          false,
          `the message names an AI tool as its author or its reviewer ("${found}"); reword it, no commit does this`,
        ]
      },
    },
  }
}

module.exports = build()
module.exports.build = build
module.exports.patterns = { strict: STRICT, narrow: NARROW }
