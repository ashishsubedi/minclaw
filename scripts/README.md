# MinClaw Deterministic Helper Scripts (`scripts/`)

This directory houses deterministic helper utilities (Python, Bun/TypeScript, Bash) generated or used by MinClaw for repetitive, data-heavy, or multi-step tasks.

Following Google Research's **Harness²** framework (arXiv:2610.14224), open-world self-improvement targets execution scaffolding rather than rewriting daemon core code (`src/*.ts`). Generating standalone scripts offloads complex, multi-step procedures into verified code executions, eliminating hallucination risks and token degradation in long reasoning loops.

## Core Conventions

1. **Portable Shebangs**: Every script must declare an appropriate shebang on line 1:
   - Python: `#!/usr/bin/env python3`
   - TypeScript / Bun: `#!/usr/bin/env bun`
   - Bash: `#!/usr/bin/env bash`

2. **Executable Permissions**: Ensure all helper scripts have executable bits set:
   ```bash
   chmod +x scripts/<script-name>
   ```

3. **Clean Output Stream Separation**:
   - Write primary machine-readable or clean textual results to `stdout` (e.g. JSON or clean plaintext).
   - Write logs, diagnostics, progress messages, and error traces to `stderr`.

4. **Strict Error Handling & Exit Codes**:
   - Non-zero exit code (`sys.exit(1)`, `process.exit(1)`, or `exit 1`) on any fatal error.
   - For Bash scripts, always enable strict error propagation:
     ```bash
     set -euo pipefail
     ```

5. **Self-Contained & Deterministic**:
   - Prefer standard libraries or existing workspace dependencies (`bun`, `python3`).
   - Do not mutate global environment state or daemon files.
