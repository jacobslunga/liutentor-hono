# Study chat prompt review

Chat instructions use English to reduce incidental Swedish cues. Response language follows the student's request, with Swedish as the fallback for a language-neutral first message. Quiz generation has its own Swedish-only contract.

The prompts use explicit guidance for task-dependent depth, user-led language switching, and readable formatting. Inspiration: the writing-style and verbosity sections in the [collected ChatGPT prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/gpt-5.2-thinking.md) and the tone/formatting section in the [collected Claude prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-opus-4.6-no-tools.md). These are community-collected examples, not verified vendor specifications. The backend uses its own study-specific instructions and renderer capabilities.

## Manual behavioral checks

Run these in both available chat models, in exam and learning chat where applicable. Repeat language-switch cases with Swedish course material and with selected text. Compare baseline and revised answers using the same question, history, material, model, and reasoning effort. These checks require actual model responses; unit tests alone do not establish prompt quality.

| Case | Input / context | Expected behavior |
| --- | --- | --- |
| English over Swedish material | Swedish exam; `Explain exercise 1` | English prose and headings; correct exercise used. |
| Swedish over English material | English notes; `Förklara detta begrepp` | Swedish explanation with technical terms preserved where helpful. |
| Selected text | Swedish excerpt selected; `Why is this true?` | English explanation; excerpt language does not control prose. |
| Switch language | English question, then `Förklara det igen med ett exempel` | Switch to Swedish immediately. |
| Neutral follow-up | English question about an exam, then `5` | Explain exercise 5 in English. |
| Neutral first turn | Attached exam; first question `5` | Swedish fallback; address only exercise 5. |
| Explicit language | `Explain eigenvalues in Swedish` | Swedish despite the English request. |
| Mixed language | `Explain uppgift 5` | English, using the referenced exercise. |
| Conceptual depth | `Explain eigenvalues` | Intuition, definition, a worked example, and connection to the concept without needing a depth request. |
| Narrow follow-up | After that explanation: `Why must the vector be nonzero?` | Focused explanation of that condition without restarting the lesson. |
| Requested brevity | `Explain eigenvalues in two sentences` | Two useful sentences. |
| Comparison | `Compare stacks and queues` | Compact comparison table and clear explanation of ordering. |
| Visual structure | `Explain how a binary search tree is organized` | Small labeled ASCII tree in a text fence, explained in prose. |
| Mathematics and code | `Explain binary search and show a Python implementation` | Inline identifiers, fenced Python, valid math delimiters if needed; no Mermaid or HTML. |
| Missing exercise | Refer to an exercise absent from the material | Focused request for the missing exercise; no invented problem. |

Review correctness, language consistency, completeness, relevance, rendered formatting, and scope. More words alone do not indicate better teaching. Check tables, math, and ASCII diagrams in the actual chat interface. Longer teaching answers can use more output tokens; review latency and usage alongside quality.
