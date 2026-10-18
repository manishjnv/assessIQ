# Documentation style

*Type: reference* — The writing standard for every surface in this repository, and how the checks enforce it.

## Standard by surface

| Surface | Standard |
| --- | --- |
| Markdown docs (`docs/`, `README.md`, module `SKILL.md`) | ASD-STE100 sentences, Google developer documentation style voice, Diátaxis page types |
| UI copy (labels, buttons, errors, empty states) | Material Design writing guidelines, plus the glossary in [the branding guideline](10-branding-guideline.md) |
| Help YAML (`modules/16-help-system/content/`) and email templates (`modules/13-notifications/src/email/`) | ASD-STE100 and Google developer documentation style |
| Architecture decisions | MADR short form, in `docs/adr/` (see [the ADR index](adr/README.md)) |
| RCA entries (`docs/RCA_LOG.md`) | SRE postmortem shape: symptom, cause, fix, prevention |
| Changelog (`docs/CHANGELOG.md`) | Keep a Changelog |

## Sentence rules

1. Write an instruction in 20 words or fewer. Write a description in 25 words or fewer.
2. Put one instruction in each sentence. Use a numbered list for a procedure.
3. Use active voice and simple present, past or future tense.
4. Use "you". Put the condition before the instruction.
5. Do not use contractions, idioms, slang or phrasal verbs.
6. Use one word for one meaning, every time.
7. Use sentence case in headings. Put code, commands and file names in backticks.
8. Keep articles ("the", "a") in sentences.

## Glossary rule

The single source for user-visible words is section 2.5 of [the branding guideline](10-branding-guideline.md). Code, API fields and database columns keep their names. Starter terms:

| Concept | Use in visible text | Avoid |
| --- | --- | --- |
| Customer | organisation | company, tenant, workspace |
| Question pack | question set | pack |
| One candidate run | attempt | sitting |
| What the candidate takes | assessment | test, exam |
| Make live | publish | release |
| Show a result to the candidate | release | publish |
| Take an AI-proposed grade | accept | approve |

Developer docs may say "tenant" and "pack" when they describe code. The Vale vocabulary in `.vale/styles/config/vocabularies/AssessIQ/` allows those words.

## Page type line

Every page in `docs/` and `README.md` has a type line. It is the first non-blank line after the H1:

```markdown
# Page title

*Type: reference* — One sentence that says what the page covers.
```

Allowed types:

- `tutorial`: learn by doing.
- `how-to`: one goal, numbered steps.
- `reference`: facts to look up.
- `explanation`: why and how it works.

A page has one type. `README.md` is the landing page and uses `reference`.

## Run the checks

1. Install [Vale](https://vale.sh) and run `vale sync` once.
2. Run `node tools/lint-docs.mjs` (script `pnpm lint:docs`).
3. Add `--strict` to exit with code 1 on any finding.

The script does four things:

- Maps help YAML `short_text` and `long_md`, and the email `.txt` templates, to temporary Markdown files.
- Checks the page type line.
- Runs `vale` when it is on the path.
- Runs `markdownlint-cli2` through `npx`.

A missing tool prints a "not installed" note. It does not fail the run.

## CI

The workflow `.github/workflows/docs-lint.yml` runs on changes to `docs/**`, `README.md`, help content and email templates. It runs Vale, markdownlint and `tools/lint-docs.mjs`.

## Advisory window

The checks are advisory from 2026-10-15 to 2026-10-29. They report findings but do not fail the build. From 2026-10-29 they are required. On that date, make two changes in the workflow:

1. Set `fail_on_error: true` for Vale.
2. Remove `continue-on-error` from the markdownlint step.

`tools/lint-docs.mjs` turns strict on its own from that date.

### Vale settings (Z-48)

The Vale run reports 0 errors on the checked pages. The settings that make this true are in `.vale.ini`:

- Inline code and fenced code are not checked (`SkippedScopes`, `IgnoredScopes`).
- Project terms, snake_case names, camelCase names and hash strings pass the spelling check. Add new terms to `.vale/styles/config/vocabularies/AssessIQ/accept.txt`.
- Google rules that do not fit the STE style are off: em dash, quotes, units, Latin words, date format and a few more. The list is in `.vale.ini`.
- `Vale.Avoid` (for example "via", "etc") is a warning until the pages are reworded (RW-100). The contraction rule stays an error.
- The workflow uses the `github-check` reporter, because the default reporter failed with an "Unhandled error event" socket error.

To run Vale on all checked pages, use `vale --config=.vale.ini docs README.md`. Run `vale sync` once first.

Not checked: `docs/plans/archive/`, `docs/SESSION_STATE.md` and `docs/RCA_LOG.md` history.

## Not included

- Mermaid render check (the repo has no diagrams yet).
- OpenAPI checks (engineering row).
- A UI copy lint from TSX (wording does not lint from code).
- Rewrite of existing pages (RW-86) and the copy pass (RW-87).
