# Thread plan

A readable paragraph with **important details**, *emphasis*, ~~old wording~~ and a [safe reference](https://example.com/plan).

- Keep the conversation readable.
- [x] Preserve the source text.
- [ ] Add inline feedback.

1. Inspect the transcript.
2. Apply the comments.

```typescript
// A long block spans the transport chunks but stays one code block.
const explanation = "This is a deliberately long code line that demonstrates local horizontal scrolling inside the code block while the surrounding thread and column retain their own width and wrap ordinary paragraphs naturally.";
const plan = [
  "Preserve every character across transport boundaries, including Markdown delimiters.",
  "Keep comments paired with the quoted text and include them in the next reply.",
  "Use the existing reply queue so delivered and handled remain separate facts.",
  "Keep ordinary paragraphs readable at the narrowest allowed column width.",
  "Support list items, fenced code, tables, links, headings and inline formatting.",
  "Allow the conversation to sit in a column or beside the Hydra in its own panel.",
  "Save the Focus preference and let the full trace remain available on demand.",
  "Retain the draft while switching views and editing settings on the Hydra.",
];
const ready = true;
// END LONG CODE
```

| Stage | Expected behavior | Evidence | Result | Next step |
| --- | --- | --- | --- | --- |
| Conversation | Keep messages visible | Fixture transcript | Ready | Review |

<script>window.pnyxUnsafe = true</script>

<img src=x onerror="window.pnyxUnsafe=true">

Fish &amp; chips, escaped as `&amp;` in HTML. [unsafe encoded](jav&#x61;script:alert(1)) and [unsafe](javascript:alert(1)) and ![remote image](https://example.com/tracker.png)

> A quoted reminder stays readable.

Final step: preserve the reply and every inline comment until delivery succeeds.
