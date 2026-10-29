<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/alexvinasdev/learnharness/issues">Issues</a>
</p>

> A fork of [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness), restructured around a persistent **scope**, deterministic exercises, and a zero-token practice loop. The original's teaching and practice sessions are retired here; the knowledge graph and the chat interface remain.

LearnHarness uses AI to interview you into a persistent **scope** — the weighted topic tree of what you want to learn — then turns each leaf into a cheatsheet (the lesson) and a batch of exercises. A **class** walks the tree with you; the grind loop measures what you actually retain, deterministically, without a model in the loop.

![LearnHarness class session](docs/assets/teaching-session.png)

## How it works

1. **Map the scope.** A scope session interviews you about what you want to learn and what it's for — even if you don't know yet. The result is a topic tree with per-objective importance: what matters for *your* goal, what's optional, what's excluded.
2. **Cheatsheets.** Each leaf of the tree earns a schematized one-page theory reference, generated on demand or in bulk — the lesson itself, kept as plain markdown you can reread anytime.
3. **Exercises.** Each leaf can generate a batch of six universal types — flashcards, cloze, ordering, matching, spot-the-error, numeric. Batches land straight in the pool; bury is the only curation.
4. **Class.** A chat session walks the scope's leaves with you — teaching from each leaf's cheatsheet, probing first with 1-2 pool exercises to find where explanation should begin, posing more as it goes (it can also spawn a targeted exercise on the spot, which joins the pool). Attempts land in the same grind log; grading is always deterministic. Take one from the scope page — on the whole scope or any subtree.
5. **Grind.** The deterministic practice loop serves exercises one at a time with instant binary feedback — no model in the loop, zero tokens per answer. What you struggle with returns first; what's solid fades to maintenance; what's been idle too long gets flagged **rusty**.

## The knowledge graph

What you learn still accumulates as propositions and reasoning chains — individual claims and the premises that lead to them — with links back to the sessions and topics that produced them. You can also import notes. Cheatsheets draw on the graph; it stays inspectable, and it carries what you know across every session and import.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Run from source

This fork ships no prebuilt downloads — run it locally:

```bash
npm install
npm run dev          # http://localhost:3000
npm run desktop:dev  # Electron shell around the dev server
npm test             # deterministic, no LLM, no network
```

Add your provider API key and choose your models, then start a scope session with what you want to learn. LearnHarness supports 30+ provider options, including OpenAI, Anthropic, Google, DeepSeek, and OpenRouter. Optional dictation and web search use separate service keys.

## Your keys, your data

- **Your keys and models.** No subscription, no markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your scopes, chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

See the [development guide](docs/development.md), [architecture](docs/architecture.md), and [desktop release guide](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/alexvinasdev/learnharness/issues).

## License

[AGPL-3.0](LICENSE), same as the original.
