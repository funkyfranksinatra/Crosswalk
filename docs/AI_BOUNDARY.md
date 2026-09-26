# The model boundary

The language model never touches the database. It receives only the data the application puts in
a request and hands its answer back to the application; the application checks that answer and is
the only thing that writes anything.

```
 application                                   model layer                 provider
 ───────────                                   ───────────                 ────────
 1. read what it needs from the DB
 2. build the input (text + response schema)
 3. src/lib/ai/gateway.ts ───────────────────▶ src/lib/llm/client.ts ────▶ Responses API
                                               (two messages + schema,
                                                no tools)
                                               4. validate against the ◀── JSON answer
                                                  response schema
 5. gateway receives the validated answer ◀─── return value
 6. check it against the hard constraints
    (component, diameter, caps; sibling floor)
 7. write the result to the DB
    (and the call record to LlmCall)
```

## The two layers

| Layer | Files | May | May not |
|---|---|---|---|
| **Model layer** | `src/lib/llm/client.ts` (provider client, structured calls, embeddings), `src/lib/llm/tasks.ts` (prompts for binning and code hints) | build a request from the arguments it is given; call the provider; validate the answer against the zod schema; return it | import `@/lib/db`, Prisma, `pg`, `pg-boss`, the Neon driver, or any module that does — directly or transitively |
| **Application** | everything else; `src/lib/ai/gateway.ts` is its single entrance to the model layer | read and write the database; decide what goes into a prompt; apply the hard constraints to an answer; persist results; record calls | import `src/lib/llm/*` anywhere except the gateway |

The gateway registers an observer with the model layer (`onModelCall`) and writes each structured
call's record to `LlmCall`: purpose, subject (the catalog numbers involved), model, outcome,
latency and token counts. Prompt text and answer text are never in the record. Embedding calls go
to the Prometheus metrics instead (`crosswalk_embedding_*`), as before.

## What the model is and is not given

- A request is exactly two messages (system, user) built by application code, plus a JSON response
  schema and a token limit. No tools, no function definitions, no tool choice, no connection
  strings, no credentials. The model cannot call anything; it can only return text, and text that
  does not match the schema is discarded before it leaves the model layer.
- What goes into the text is decided by the application: competitor codes, product descriptions and
  attributes, candidate SKUs with their attributes and attribute scores, the company name, and for
  the unresolved-code hint the customer account name (switch off with `LLM_SEND_ACCOUNT_NAME=false`).
  Never prices, costs, margins, contracts or people (DATA_ACCESS_POLICY).
- An answer is a proposal. Binning answers are merged with the deterministic heuristic bin and
  normalised; grading answers can lower a grade but never lift one past the cap the hard and soft
  constraints allow, and the sibling floor is re-applied deterministically; code hints only steer a
  lookup the application performs itself against openFDA and the GUDID library.

The grading cache (`LlmGrade`) stores the schema-validated verdict as the model gave it, keyed by a
hash of its exact inputs; the constraint caps are applied every time a verdict is used, cached or
fresh, so a tightened constraint applies to old verdicts too. The run result written to the request
lines is always the post-constraint result.

## Enforcement

`tests/unit/llm-boundary.test.ts` (part of `npm test` and CI):

- walks the real import graph from each file in `src/lib/llm/` and fails with the offending chain
  (e.g. `src/lib/llm/tasks.ts → src/lib/audit.ts → src/lib/db.ts`) if the database, the job queue or
  a database driver becomes reachable;
- fails if any file in `src/` or `scripts/` other than the gateway imports the model layer;
- drives the client against a local stand-in for the provider and checks what leaves the process
  (only `model`, `input` with the two given messages, `text` with a JSON schema, `max_output_tokens`;
  no `tools`), that a schema-invalid answer never reaches the caller as data, that provider errors
  are returned rather than thrown, and that the call record carries no prompt or answer text.

A new model task goes in `src/lib/llm/` as a pure function (arguments in, validated answer out) and
is re-exported from the gateway; the code that reads its inputs and writes its result lives in the
application.
