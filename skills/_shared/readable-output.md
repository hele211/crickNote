# Readable output: how to write notes in this vault

Humans review these notes in Obsidian. Agents read them later as raw Markdown.
Both must be able to use a note without the paper or the chat in hand.

**Required** (the checker warns): headings and their order, IDs and the references
to them, locators, attribution, closed code fences, no HTML tags. **Preferences**
(the checker only informs): sentence and paragraph length, bare pronouns, noun
stacks, diagram size. Break a preference when a qualifier, a comparison or an exact
term needs the space. Never break rule 6.

## Say it plainly

1. One idea per sentence. Aim for 20 words or fewer, and 5 sentences or fewer per
   paragraph.
2. Use the active voice and name the actor: "The authors injected tracer", not
   "Tracer was injected".
3. Use one term per concept. Do not swap synonyms for variety. Define each
   abbreviation at first use in the TL;DR and again at first use in Claims: those
   two parts are often read alone. Later sections may reuse the abbreviation.
4. Do not start a sentence with a bare pronoun (it, they, these, those). Repeat the
   noun, so that each chunk of the note stands alone.
5. Keep noun stacks to three words. Add "of", "in" or "for" beyond that.
6. **Simplify the syntax, never the qualifiers.** Keep species, condition, method
   limits and "reconstructed from…" inside the claim. Do not turn "suggests" into
   "shows".
7. Give every number a unit, a comparison and a system: "about 55% slower
   clearance, Aqp4-null vs wild type, mouse".

## Answer first

8. Start the note with a `> [!abstract] TL;DR` callout: five fields (Did, Found,
   Trust, Why it matters here, Source) and at most 160 words in total. Count
   words, not rendered lines: line breaks change with the window width.
9. Use fixed headings in a fixed order. Each section must be readable on its own.
   Do not write "as above".
10. Number what others will cite. Never renumber an ID after it is cited; give new
    items new numbers.
11. Size limits apply to the summary layer (TL;DR, Claims). They never justify
    deleting evidence. Split a long table under `###` headings instead.

## Show, do not just tell

12. Use a table for 3 or more items with 2 or more attributes each. Claims are
    the exception: they always use the bullet format in the layout, never a table.
    Use callouts only for the TL;DR (`abstract`), a caveat (`warning`) and an open
    question (`question`).
13. Use a Mermaid `flowchart TB` only when it shows something the text cannot show
    quickly: a direction of 3 or more steps, or how named molecules and cells act on
    each other. Otherwise write a list. Never invent causal structure or draw an
    interaction the source does not state. Do not use a diagram for anatomy or
    structure: Mermaid has no geometry.
14. Write no HTML tags. Do not store an image or a video as the only record of a
    fact. Link another note with a wikilink only if that note exists.

## Whose voice is it

Say whose statement each sentence is. Claims, Reasoning, Evidence and the Figure Map
state only what the paper says or shows. Limits, relevance to the lab and next
steps are the analyst's layer. Outside commentary needs its source, or the words
"not verified".

## What a checker can and cannot tell you

`lint_reading_note` checks form: headings, IDs, locators, diagram shape and
sentence length. It cannot check that a locator supports its claim, or that a label
is true. Review the science yourself. Treat `info` findings as suggestions and
`warn` findings as defects to fix once.

## Where else to look

- Reading-note layout, formats and budgets: `reading-note-layout.md` (same folder).
- A complete, lint-clean example: `examples/reading-note-v2.md`.
