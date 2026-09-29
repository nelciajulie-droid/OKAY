# Boppy FireProx Worker — Cloudflare Worker proxy for boppy.me

A Cloudflare Worker that mimics FireProx's wire interface, so the same
`boppy.ts` code path routes through it. Drop-in replacement for the mock
service `mini-services/mock-fireprox/` — runs on Cloudflare's edge instead
of `localhost:8788`.

## ⚠️ CE QUE CE WORKER NE FAIT PAS (lisez avant de déployer)

**Il ne résout PAS le rate-limit de boppy.me.**

Pourquoi : FireProx AWS fonctionne parce que **AWS API Gateway fait tourner
l'IP egress à chaque requête**. Cloudflare Workers **ne font pas ça** — ils
partagent un pool d'IPs egress commun à tous les utilisateurs du free tier.
boppy.me rate-limit par IP TCP source, pas par header `X-Forwarded-For`, donc
ce Worker :

| Feature | Résultat |
|---|---|
| Cache votre IP réelle de boppy | ✅ Oui |
| Ajoute `X-Forwarded-For` spoofé | ✅ Oui (FireProx trick) |
| Streaming Range/206 pour l'audio | ✅ Oui |
| Rotation d'IP par requête | ❌ **Impossible** (limitation Cloudflare) |
| Résout le rate-limit boppy | ❌ **Non** (boppy limite par IP TCP) |
| Risque d'être **plus** limité | ⚠️ Oui (IPs Cloudflare déjà connues de boppy) |

**Pour une vraie rotation d'IP**, deployez FireProx sur AWS :
`fireprox/DEPLOY-BOPPY.md` (guide complet dans ce dépôt).

**Pour une solution légitime illimitée** : auto-hébergez ACE-Step
(voir Settings → "API endpoint (advanced)").

---

## Ce que CE Worker fait (utile pour : privacy, CORS, middleware)

- **Proxy transparent** vers `https://boppy.me` — toute path/query préservée
- **FireProx-compatible** : `X-My-X-Forwarded-For` copié dans `X-Forwarded-For`
- **Streaming Range/206** pour l'audio mp3 (pas de buffer)
- **Free tier 100k req/jour** (assez pour un usage perso)
- **Edge network** — faible latence depuis n'importe où
- **Logs** via `wrangler tail`

---

## Déploiement (3 commandes sur votre machine)

### Prérequis

- Un compte Cloudflare (gratuit sur https://dash.cloudflare.com/sign-up)
- Node.js 16+ sur votre machine
- 5 minutes

### Étapes

```bash
# 1) Installer Wrangler (CLI Cloudflare, one-time)
npm install -g wrangler

# 2) Auth (one-time — ouvre le navigateur)
wrangler login

# 3) Cloner ce dépôt et aller dans le dossier worker/
git clone <votre-repo>  # ou juste copiez worker/ + wrangler.toml
cd worker

# 4) Déployer
wrangler deploy
# → Sortie attendue:
#   Published boppy-fireprox
#     https://boppy-fireprox.<votre-subdomain>.workers.dev
```

### Configurer dans Boppy Studio

1. Ouvrez Boppy Studio dans le navigateur
2. Bouton **Settings** (en haut à droite)
3. Champ **"FireProx URL (advanced)"** → collez l'URL Worker
4. **Save** → le badge "active" doit apparaître
5. L'app route maintenant via le Worker

---

## Vérifier que ça marche

### 1. Health check (depuis votre machine)

```bash
curl https://boppy-fireprox.<votre-subdomain>.workers.dev/health
# → {"ok":true,"type":"cloudflare-worker-fireprox","upstream":"https://boppy.me",...}
```

### 2. Test direct (sans Boppy Studio)

```bash
# Compose lyrics via le Worker
curl -X POST https://boppy-fireprox.<votre-subdomain>.workers.dev/api/llm/compose \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A dreamy lo-fi beat about rain on a window in Tokyo"}'

# → 200 OK, title + lyrics + caption
```

### 3. Test via Boppy Studio

1. Tapez un prompt → "Generate track"
2. Le toast "Track queued" doit apparaître
3. La carte passe de PENDING → Ready en ~10-20s
4. Si vous voyez une bannière 429 → boppy rate-limit le Worker.
   Solutions :
   - Patientez (compte à rebours déjà affiché dans l'app)
   - Déployez un vrai FireProx AWS (autre IP pool)
   - Auto-hébergez ACE-Step (plus de quota du tout)

### 4. Logs en temps réel

```bash
wrangler tail
# Affiche les lignes [worker] POST /api/llm/compose → boppy.me (X-My-XFF: ...)
# en temps réel. Vérifiez que chaque requête a un XFF différent.
```

---

## Comparaison des 3 options

| Critère | Ce Worker (Cloudflare) | FireProx (AWS) | ACE-Step auto-hébergé |
|---|---|---|---|
| Coût | 100k req/jour gratuit | 1M req/region/mois gratuit | VPS ~5€/mois |
| Setup | 3 commandes | 6 étapes | 5 étapes |
| Compte requis | Cloudflare | AWS | VPS provider |
| Rotation IP | ❌ | ✅ | N/A (votre IP) |
| Résout rate-limit boppy | ❌ | ✅ (avec risque ban) | ✅ (légitime) |
| Risque ban | Faible | Élevé (AWS+boppy) | Aucun |
| Latence | Très faible (edge) | Faible | Dépend du VPS |

---

## Sécurité : protéger votre Worker

Par défaut, votre Worker est **public** — n'importe qui avec l'URL peut
l'utiliser et consommer votre quota de 100k req/jour. Pour limiter l'accès :

### Option A — Restriction par IP (éditez `wrangler.toml`)

```toml
[vars]
ALLOWED_CALLER_IP = "ip.de.votre.serveur.boppy.studio"
```

Puis ajoutez dans `worker.js` (au début du `fetch`):
```javascript
if (env.ALLOWED_CALLER_IP && request.headers.get("CF-Connecting-IP") !== env.ALLOWED_CALLER_IP) {
  return new Response("Forbidden", { status: 403 });
}
```

### Option B — Secret partagé (recommandé)

```bash
wrangler secret put FIREPROX_SECRET
# → entrez une longue chaîne aléatoire
```

Puis dans `worker.js`:
```javascript
if (env.FIREPROX_SECRET && request.headers.get("x-fireprox-secret") !== env.FIREPROX_SECRET) {
  return new Response("Forbidden", { status: 403 });
}
```

Et dans `boppy.ts`, ajoutez le header dans `boppyFetch`:
```typescript
headers["x-fireprox-secret"] = process.env.BOPPY_FIREPROX_SECRET ?? "";
```

---

## Fichiers

```
worker/
├── worker.js       # Le Worker (proxy FireProx-compatible)
├── wrangler.toml    # Config Cloudflare
└── README.md        # Ce fichier
```
