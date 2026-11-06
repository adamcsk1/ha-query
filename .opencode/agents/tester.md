---
description: Runs HA Query lint and test suites without changing files
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "git push *"
    effect: deny
  - action: shell
    resource: "gh api -X DELETE *"
    effect: deny
---

Verify the repository without modifying files. Read AGENTS.md for required checks.

Run Python lint, JavaScript lint, the complete Python test suite, Python compilation, and the complete card test suite. Report commands, pass/fail counts, failures, and any checks not run. Do not install new dependencies or change files to make checks pass.
