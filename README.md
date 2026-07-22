# ⚽ FPL Optimizer

Et komplett Fantasy Premier League-dashbord som finner **det best mulige laget ditt for neste runde** — basert på laget du hadde forrige runde, med alle offisielle FPL-regler innebygd.

Legg inn FPL-ID-en din og få:

- **Optimalt lag**: beste XI, formasjon og benkerekkefølge ut fra forventede poeng (xP)
- **Transferplaner** for 1–3 bytter, vurdert mot −4-hits — appen sier fra når det lønner seg å beholde laget
- **Kapteinsrangering** for neste runde
- **Chip-rådgiver**: forventet gevinst av Wildcard, Free Hit, Bench Boost og Triple Captain akkurat nå
- **Stats**: sorterbar spillertabell med xP, form, xGI, pris og eierandel
- **Fixture-ticker** med FDR for de neste 5 rundene (lettest først)
- **Live-poeng** med auto-refresh, **mini-liga-tabell** og **sesonghistorikk** med grafer

Norsk UI, mørkt tema, mobilvennlig.

## Kom i gang lokalt

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 39 enhetstester (regelmotor + optimaliserer)
```

I sandkasser uten tilgang til FPL-API-et kan du kjøre mot en innebygd mock:

```bash
npm run mock-api                          # mock-FPL-API på :4100
FPL_API_BASE=http://localhost:4100 npm run dev
```

## Deploy til GitHub + Vercel

1. **GitHub**: opprett et tomt repo (f.eks. `fpl-optimizer`) på github.com, og push:

   ```bash
   git remote add origin https://github.com/<brukernavn>/fpl-optimizer.git
   git push -u origin main
   ```

   (Eller med GitHub CLI: `gh repo create fpl-optimizer --public --source=. --push`)

2. **Vercel**: gå til [vercel.com/new](https://vercel.com/new), logg inn med GitHub, velg repoet og trykk **Deploy**. Next.js trenger null konfigurasjon. Ferdig — siden er live, og hver push til `main` deployes automatisk.

CI (lint + test + build) kjører på GitHub Actions ved hver push.

## Arkitektur

```
src/
├── app/
│   ├── page.tsx                  # Landing: FPL-ID-inntasting + validering
│   ├── team/[id]/page.tsx        # Dashbordet
│   └── api/fpl/[...path]/route.ts# Proxy mot fantasy.premierleague.com (påkrevd: ingen CORS)
├── lib/
│   ├── rules.ts                  # FPL-regelmotoren (se under)
│   ├── xp.ts                     # Forventet poeng-modell — alle vekter i XP_CONFIG
│   ├── optimizer.ts              # Beste XI + beam search over transferkombinasjoner
│   ├── fpl.ts                    # Datalag: henter og setter sammen lagtilstand
│   └── types.ts                  # Typer for FPL-API-et
└── components/                   # Pitch, OptimizePanel, StatsTable, m.m.
```

### Regelmotoren (`lib/rules.ts`)

Implementerer og enhetstester de offisielle reglene: tropp på 15 (2 GK / 5 DEF / 5 MID / 3 FWD), maks 3 per klubb, alle 8 gyldige formasjoner, **salgspriser** (kjøpspris + 50 % av prisstigning, rundet ned til nærmeste £0.1m — beregnet fra transferhistorikken din), gratis bytter med banking (opptil 5) og −4-hits, og chips. Chip-tilgjengelighet leses **dynamisk** fra API-et (vinduer og antall), så appen overlever regelendringer mellom sesonger.

### xP-modellen (`lib/xp.ts`)

Per spiller per runde: xG/xA per 90 vektet med fixture-vanskelighet (FDR) og hjemme/borte, clean sheet-sannsynlighet for GK/DEF, forventet baklengs-trekk, bonuspoeng fra ICT, og spilletidssannsynlighet fra status/skadegrad og minuttandel. Blandes med form (poeng per kamp) og FPL-s egen `ep_next` for neste runde. Doble og blanke runder håndteres automatisk via fixtures-endepunktet. Alle vekter ligger i `XP_CONFIG` — juster og se hva som skjer.

### Optimalisereren (`lib/optimizer.ts`)

Beste XI finnes eksakt ved å enumerere alle gyldige formasjoner. Transferforslag finnes med **beam search**: alle lovlige 1-bytter evalueres (posisjon, budsjett med ekte salgspriser, klubbgrense), de beste tilstandene utvides til 2 og 3 bytter. Målfunksjonen er summen av beste-XI-xP (inkl. kaptein) over valgt horisont, minus hits. Chip-gevinster beregnes fra samme modell (Bench Boost = benkens xP, Triple Captain = kapteinens xP, Wildcard/Free Hit = optimalt lag innenfor lagverdien din vs. dagens lag).

## Datakilde

Det offisielle, åpne FPL-API-et (`https://fantasy.premierleague.com/api/…`) via en server-side proxy med caching (5 min for bootstrap/fixtures, 60 s for live). Ingen innlogging, ingen database — alt beregnes fra FPL-ID-en.

---

Uoffisiell app — ikke tilknyttet Premier League eller FPL.
