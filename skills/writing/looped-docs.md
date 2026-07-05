---
name: looped-docs
description: How to write docs and copy for Looped - voice, rules, and examples of what to do and what to avoid.
---

# Writing docs for Looped

Write like an engineer explaining a design to a peer. The reader is technical,
busy, and probably hates feeling like they're being sold on something. They also hate AI written slop. 

Every sentence you write needs to sound like it was written by a human, for a human.

I like Tailscale's engineering explainers: conversational,
second person, walks the reader through the problem before landing the design. Where possible, you should try to use their style as a reference. 

## Hard rules

**Never use the "X, not Y" pattern.** No negation-contrast constructions:
"a dialect, not a vendor", "knowledge, never capability", "an answer, not an
interruption". State the positive claim and let it stand. If the contrast
genuinely matters, give the alternative its own sentence.

```text
Bad:  Configs hold references, never secret values.
Good: The config names an environment variable; the value stays out of the file.

Bad:  ## A denial is an answer, not an interruption
Good: ## A denial is an answer
```

**No marketing adjectives.** Never: seamlessly, effortlessly, powerful,
blazing, robust, delightful, quietly. If a claim needs an adverb to sound good, the
claim is weak - make it concrete instead.

```text
Bad:  Deploy agents seamlessly with a single command.
Good: Use `docker run` to start the agent.
```

**No em dashes.** Use a regular dash `-` where a dash is needed, and prefer a
period, comma, or semicolon over a dash in the first place.

```text
Bad:  The image is minimal on purpose — no browser, no extras.
Good: The image is minimal on purpose - no browser, no extras.
```

**No throat-clearing.** Never open with "In this section, we will…" or
"This page describes…". Start with the thing itself, or with the reader's
problem.

## Voice

**Write like you're explaining it out loud to a colleague.** A first-draft
spoken explanation is closer to the target than a polished aphorism.

**Use "you" and "we".** "We" for decisions made building the framework, "you"
for the reader's side of things. "We created a minimal image" beats "The
image is minimal on purpose"; saying "we" carries the intent on its own.

**Keep the connective tissue.** "This means that", "and then", "For most
integrations, you don't need". Tight editing calls these words filler, but
they're what makes a sentence sound like a person said it. The same goes for
longer spoken verb phrases: "you're not going to be able to" over "can't",
"is allowed to do" over "may".

```text
Compressed: This makes the agent file a complete statement of blast radius.
Spoken:     This means that the agent file completely defines what an agent
            is allowed to do.
```

**Say what mechanically happens, in the product's own vocabulary.** Context,
turn, skill, trigger. Translate metaphors and coined phrases ("blast
radius") into literal words, and swap claims about behaviour for the
mechanism itself.

```text
Rhetorical: A denied action comes back to the agent as information it adapts to.
Mechanical: A denied action goes back to the agent as context for its next turn.
```

**Recommendations over arguments.** Drop the abstract thesis, the vivid number
picked for effect, the comparison built to persuade. State the concrete
advice and let it stand. Hedge by fronting the scope of the claim ("For most
integrations, …") and by modest idiom ("can go a long way").

```text
Persuasive: Most integrations don't need an MCP server - a good CLI plus a page of
            instructions serves a small model better than forty tool schemas.
Plain:      For most integrations, you don't need an MCP server. A CLI and a
            well written skill can go a long way.
```

**Walk the reader to the design.** This is the Tailscale move: present the
problem first, let it be felt, then land the design as the way out. A
conclusion the reader arrives at beats a pronouncement.

```text
Verdict-first: Permission prompts don't scale. So permissions are declared once in config.
Walked:        A service agent runs at 3am, triggered by a webhook, on a machine nobody
               is watching. There is no one to ask "may I run this?" - so the question
               has to be answered before the agent starts.
```

**Name the costs.** Say what a design gives up, when a feature is the wrong
choice, and what isn't built yet. One honest limitation buys more trust than
a page of strengths. (See "What is deliberately not configurable" in the
models doc for the shape.)

## Rhythm

**Mid-length flowing sentences are the default.** Avoid the short punchy
register where every sentence is a compressed, quotable beat; a page of
those reads as written-by-machine. A single short fragment at the end of a
normal sentence is fine as spoken emphasis ("Nothing extra."), and that's
about as punchy as it should get.

**Where a dash would chain two thoughts, end the sentence.** Start a new one
instead. If a dash survives, it's a regular dash, one aside per paragraph at
most.

**Full grammatical sentences over stylized fragments.** Give the sentence a
subject and let the verbs connect: "It waits for an event, does its job and
then goes idle" rather than the imperative list "wait for an event, do its
one job, go idle".

**No serial comma.** "the runtime, the framework and bash".

**Prefer concrete nouns to abstractions.** "a Discord message, a webhook, a
cron tick" beats "various event sources". Lists of three real things beat a
category name.

## Structure

- Open with a claim or with the reader's problem. A definition of the page
  wastes the opening.
- One idea per paragraph; when a paragraph needs "and also", it is two
  paragraphs.
- Headings are claims where possible ("A denial is an answer"), plain labels
  otherwise ("API keys"). Never questions.
- Link to the page that owns a topic instead of re-explaining it.

## Self-check before publishing

1. Search the draft for ", not " and ", never " - rewrite any contrast hits.
2. Search for "—" (the em dash) - replace every one with a regular dash or
   restructure the sentence.
3. Search for: seamless, effortless, powerful, robust, simply, just, quietly -
   justify or delete each.
4. Read the first sentence of every section aloud. If two in a row have the
   same shape, vary one.
5. Read the page out loud. Any sentence you wouldn't actually say, rewrite
   the way you'd say it.
6. Does the page admit a limitation? If it can't, it's marketing.
