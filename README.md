# crypto-mm

Four bots, one shared core.

```
git clone https://github.com/blakelapierre/crypto-mm-public.git
cd crypto-mm-public
npm i
cp .env.example .env   # put keys here only — never commit .env
```

| Command | Bot |
|---------|-----|
| `npm run ladder` | Post-only ladder |
| `npm run inventory` | Inventory-skewed quotes |
| `npm run xex` | Coinbase vs Kraken hedge |
| `npm run comp` | Kraken GNOT + SN64 competition |

Bot knobs live in `configs/*.env` and override `.env`.
