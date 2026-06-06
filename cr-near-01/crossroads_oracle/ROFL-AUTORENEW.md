# Programmatic top-up & renewal of the oracle ROFL machine

The block-hash oracle runs on a **rented ROFL machine** that expires (testnet
rentals are short — ~1h at a time — and **non-refundable**, ~**5 TEST/hour**).
When it lapses the oracle URL goes dead and `oasis rofl machine show` reports
*"Machine instance not found"*. [`rofl-autorenew.sh`](rofl-autorenew.sh) +
[a launchd agent](com.crossroads.rofl-autorenew.plist) automate keeping it alive.

## How it works

`rofl-autorenew.sh auto` (what the scheduler runs):

1. **Lapsed?** (`machine show` says "not found") → `oasis rofl deploy
   --replace-machine` to re-rent, then **re-derive the new URL** and rewrite
   `CROSSROADS_ORACLE_API` in `backend_contracts/.env.demo-keys` (the proxy
   sub-domain changes per rental, so the URL must be refreshed).
2. **Still alive?** read `Paid until`; if the runway is below
   `RENEW_THRESHOLD_HOURS` → `oasis rofl machine top-up --term hour --term-count
   RENEW_TERM_HOURS` (top-up keeps the same machine/URL).
3. **Balance guard:** before paying, check the admin account covers the cost; if
   not it logs an alert and exits non-zero (code 3) so the operator refills from
   the faucet. There is **no free-forever** — this renews *while funds last*.

Non-interactive signing: the `oasis` CLI reads the keystore passphrase from
**stdin**, so the script pipes it in from the macOS **Keychain** (never stored in
the repo).

## One-time setup

```sh
# 1. Put the keystore passphrase in the login Keychain (prompts; not echoed):
security add-generic-password -s oasis-rofl-passphrase -a "$USER" -w

# 2. Sanity check (read-only — no signing, no cost):
cd crossroads_oracle
./rofl-autorenew.sh status
#  → machine=default state=gone|<runway> admin_balance=… TEST

# 3. Install the scheduler (runs every 30 min):
cp com.crossroads.rofl-autorenew.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.crossroads.rofl-autorenew.plist
tail -f /tmp/rofl-autorenew.log
```

## Manual use

```sh
./rofl-autorenew.sh status        # show state + runway + balance, no changes
./rofl-autorenew.sh topup 24      # force-buy 24h now (= 120 TEST)
./rofl-autorenew.sh auto          # one renew/redeploy pass (what launchd runs)
```

## Config (env / plist `EnvironmentVariables`)

| var | default | meaning |
|---|---|---|
| `RENEW_THRESHOLD_HOURS` | `2` | top up when runway drops below this |
| `RENEW_TERM_HOURS` | `6` | hours bought per top-up |
| `TEST_PER_HOUR` | `5` | rental price, for the balance guard |
| `ADMIN_ADDR` | `0xFF53…779a` | account billed (balance check) |
| `KEYCHAIN_SERVICE` | `oasis-rofl-passphrase` | Keychain item with the passphrase |
| `OASIS_PASSPHRASE` | — | alternative to Keychain (e.g. Linux/cron) |
| `ENV_FILE` | `../backend_contracts/.env.demo-keys` | file whose `CROSSROADS_ORACLE_API` is refreshed |

**Linux/cron** instead of launchd: store the passphrase in `OASIS_PASSPHRASE`
and add `*/30 * * * * OASIS_PASSPHRASE=… /…/rofl-autorenew.sh auto >> /tmp/rofl-autorenew.log 2>&1`.

## Limitation / future work

This wraps the `oasis` CLI. A fully chain-native renewer would sign the
`roflmarket` top-up transaction directly with a raw key (the CLI can emit it via
`top-up --unsigned -o tx.json`), removing the CLI/Keychain dependency — left as
follow-up. Sustained uptime still needs a funded admin account; the alert (exit
3) is the seam where a human (or a faucet bot) tops up the TEST balance.
