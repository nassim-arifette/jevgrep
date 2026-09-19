# JevGrep domain language

JevGrep finds evidence in a repository for a coding agent's natural-language question. The agent interprets that evidence and decides what to do next.

## Language

**Search question**: The behavior, responsibility, or concept the agent wants to locate in code. A question describes an information need, rather than an instruction to modify the repository.
_Avoid_: Task plan, diagnosis.

**Authorized repository**: The repository whose contents the operator has permitted JevGrep to examine and, under the configured disclosure policy, send for remote evaluation.

**Requested scope**: The files or directories inside the authorized repository selected for a search. The requested scope can narrow authorization but cannot expand it.

**Eligible file**: A file within the requested scope that satisfies the configured disclosure and supported-content rules. Being eligible says nothing about relevance.

**Fragment**: A contiguous excerpt prepared from an eligible file for evaluation. It retains its source location and original contents.

**Evaluation**: A provider's relevance judgment for a fragment against a particular search question. An unavailable evaluation is an unknown result, not a negative judgment.

**Relevance score**: The provider's affirmative probability for the specified relevance criterion. It is not a guarantee of usefulness or a measure of certainty that the entire investigation will succeed.
_Avoid_: Confidence, necessity score.

**Scan budget**: The limits on work performed to evaluate a search, including provider usage, estimated spend, and elapsed time.

**Response budget**: The limit on evidence and metadata returned from a search. It is independent of the scan budget.

**Selected excerpt**: An original source range chosen for the response after relevance ranking, overlap handling, and response budgeting.
_Avoid_: Summary, generated explanation, optimal context.

**Coverage**: The extent to which the eligible material in the requested scope was successfully evaluated. Coverage does not establish that the search found all evidence needed for the task.

**Partial scan**: A search with incomplete inventory or eligible material whose evaluation was not completed. A small response can come from a complete scan.

**Source snapshot**: The file contents captured for a search at the time they were read. A snapshot is evidence of those contents, not a promise that the working tree has remained unchanged.

**Exact evaluation reuse**: Reusing a prior judgment only when the question and every evaluation-relevant input are identical. A different question requires a new judgment.

**Coding agent**: The caller that formulates searches, interprets returned evidence, and performs follow-up investigation, edits, and tests.

**Operator**: The person who configures repository authorization, remote disclosure, credentials, and resource limits.
