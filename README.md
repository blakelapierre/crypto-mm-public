# crypto-mm

Four bots, one shared core.

```
git clone https://github.com/blakelapierre/crypto-mm-public.git
cd crypto-mm-public
git pull
npm i
cp .env.example .env   # keys stay local — never commit .env or *.pem
```

| Command | Bot |
|---------|-----|
| `npm run ladder` | Post-only ladder, slide on fill |
| `npm run inventory` | Inventory-skewed quotes |
| `npm run xex` | Coinbase vs Kraken hedge |
| `npm run comp` | Kraken GNOT + SN64 competition |

`MM_LEVELS=1` means **one bid + one ask per coin**. After a fill the bot queues a same-side slide (left `pending` if cash/inventory is under Kraken min) and can skew the other side.

## AS control

The Avellaneda-Stoikov bots (`as-cb`, `as-kraken`) read `data/<bot>.control.json` on the next loop and append `{cmd, at, result}` to `logs/control-<bot>.jsonl`. The status line shows the last command.

| Command | Body | Effect |
|---|---|---|
| `resume` | `{"cmd":"resume"}` | Clears any halt, including `lifetime-dd` and `day-loss`. No restart and no `AS_RESUME` env. |
| `book-transfer` | `{"cmd":"book-transfer","usd":-10.01,"note":"withdrawal"}` | Books a deposit or withdrawal, shifts every baseline (session, lifetime, equity marks, halt, reset), and replaces a matching pending entry. A loss halt that the transfer explains is cleared. |
| `clear-pending` | `{"cmd":"clear-pending","id":"jump-…"}` | Drops one pending transfer after a human confirms it was not a deposit or withdrawal. |
| `halt` | `{"cmd":"halt"}` | Soft stop. This is preferred to `systemctl stop`. |
| `reset-session` | `{"cmd":"reset-session"}` | Starts a new session at the current equity. |

`AS_RESUME=1` still clears a halt at startup, and logs that it is deprecated.

`systemctl stop` on an AS unit stays stopped until the next reboot or an explicit `systemctl start`. It does not disable the unit. Use `halt` when you want the bot to stay up but stop quoting.

`npm run smoke` checks every file under `src/`, imports the AS bot, and runs the AS tests. Run it before restarting. The AS units allow 5 starts per 60 seconds so a crash loop stops and is visible.

Bot knobs: `configs/*.env` override `.env`.
