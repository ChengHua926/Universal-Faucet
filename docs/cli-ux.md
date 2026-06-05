# Drip CLI UX Notes

Goal: make `drip` self-explanatory in a terminal without turning it into an
interactive wizard.

Reference patterns:

```text
clig.dev       examples, next commands, actionable errors, quiet by default
gh            clear command tree and descriptions
stripe cli    local status/log/test loops for developer workflows
vercel cli    action output that ends with useful follow-up commands
```

Applied rules:

```text
help
  include product-shaped examples
  describe commands and positional args
  show relevant env vars

errors
  state the problem first
  give the exact next command
  keep stack/internal details out of normal user output

success output
  title line
  aligned fields
  next/observe command where useful

status output
  split local miner, worker, mining, credit, payout
  format numbers and hashrates
  avoid raw booleans
```

Demo:

```bash
cargo build -p xpool-cli
vhs docs/demo/drip-cli-ux.tape
```

Output:

```text
docs/demo/drip-cli-ux.gif
```
