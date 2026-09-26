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

Bot knobs: `configs/*.env` override `.env`.
