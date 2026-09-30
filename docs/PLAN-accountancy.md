# Plan: van eigen MCP naar aanbod voor accountantskantoren

*Status: concept — 24 september 2026. Context: de Exact Online MCP-server (63 tools) draait nu single-user op AWS Lambda voor eigen gebruik. Mogelijk volgt een demo bij een accountantskantoor; bij interesse wordt dit een aanbod voor kantoren met honderden klantadministraties, meerdere medewerkers met verschillende rechten, en op termijn meerdere kantoren.*

## Uitgangspunten

1. **Medewerkers loggen in met hun eigen Exact-account.** Exact handhaaft dan zelf wie welke administratie mag zien — de rechten die het kantoor al in Exact beheert worden geërfd, niet nagebouwd.
2. **Twee sloten.** Bovenop Exact's rechten komt een eigen policy-laag: per kantoor/medewerker een divisie-allowlist en toolcategorie-rechten (lezen / schrijven / insights). De MCP krijgt dus nooit "overal" toegang.
3. **Geen boekhouddata opslaan.** De server bewaart alleen tokens en audit-logs. Dit is het sterkste verkoop- en compliance-argument; zo houden.
4. **De 63 tools zijn grotendeels klaar.** Het werk zit in identiteit, autorisatie, tenancy en onboarding — niet in de tools.

## Architectuurwijzigingen

### 1. Per-gebruiker tokens (grootste verbouwing)
- DynamoDB-tabellen (KMS-versleuteld): `tokens` per (kantoor, gebruiker), `tenants`, `users`, `policies`, `audit`.
- Refresh-lock verplicht: Exact-refresh-tokens zijn eenmalig bruikbaar → conditional writes per gebruiker (de in-process mutex + store-herlezing van nu volstaat niet meer bij meerdere gebruikers).
- De bestaande OAuth 2.1-server (src/auth/oauthServer.ts) blijft de basis; tokens worden gebonden aan gebruikersidentiteit i.p.v. één `ALLOWED_EXACT_USER`.
- **Dynamic Client Registration (DCR)** toevoegen zodat Claude-clients koppelen zonder client-id/secret te kopiëren.

### 2. Eén centrale Exact-app
- Nu: handmatige app-registratie per setup in het App Center (incl. 45-tekens-truncatiebug in het redirect-URI-veld).
- Straks: **één partner-app via het Exact App Center / partnerprogramma**. Elke medewerker van elk kantoor geeft gewoon consent. Reviewproces duurt weken → vroeg starten (al tijdens fase 1).
- Levert ook: nettere rate-limits en een App Center-vermelding (vertrouwen bij accountants).

### 3. Infra volwassen maken
- Custom domain (`mcp.<product>.nl`) achter CloudFront/API Gateway + WAF; Lambda blijft (goedkoop, schaalt vanzelf, eu-central-1).
- **Audit-log per actie** (wie, tenant, divisie, tool, wanneer) in DynamoDB — voor accountants een eis, geen nice-to-have.
- Caching van afgesloten boekperioden; rate-budget per divisie (Exact limiteert per app per administratie — één zware groepsrapportage mag een klant niet leegtrekken).
- Eigen tokens krijgen aparte read-only en schrijf-scopes; schrijftools blijven dry-run-first en zijn per tenant uitschakelbaar.

### 4. Onboarding
- **Kantoorbeheerder:** aanmeldpagina → Exact-consent → uitnodigingslinks voor medewerkers. Geen AWS-console, geen secrets-gedoe.
- **Medewerker:** connector toevoegen in Claude → "Log in met Exact Online" → klaar. Divisie-namen worden al dynamisch opgelost ("pak de btw-aangifte van klant X" werkt direct).
- Per-kantoor instellingen (allowlists, schrijfrechten, intercompany-mappings voor `exact_group_report`) via een simpel admin-scherm; in fase 1 mag dit een beheerd configuratiebestand zijn.

### 5. Compliance (parallel spoor)
- Verwerkersovereenkomst + GDPR-datakaart (alleen tokens & audit-logs, geen boekhouddata).
- EU-hosting (eu-central-1 ✓).
- Pentest vóór de eerste betalende klant.
- ISO 27001 / SOC 2 pas als grotere kantoren erom vragen.

## Fasering

| Fase | Wat | Wanneer |
|---|---|---|
| **0. Demo** | Huidige stack + deploy, demo-administratie, demoscript | Nu — er hoeft niets bij |
| **1. Pilot bij kantoor 1** | Per-gebruiker login, DynamoDB-tokens + refresh-lock, divisie-allowlist, audit-log, custom domain | Bij serieuze interesse; ~2–4 weken bouwwerk |
| **2. Multi-tenant + onboarding** | Tenant-model, self-service onboarding, admin-beheer, DCR, Exact partner-app live | Zodra kantoor 2 in beeld is (partner-aanvraag al in fase 1 indienen) |
| **3. Schaal & commercie** | Caching/rate-budgets, billing (per seat of per administratie), status/support, certificering | Bij betalende klanten |

## Strategische keuze: SaaS of stack-per-kantoor

- **Optie A — gedeelde multi-tenant SaaS:** bovenstaand eindbeeld. Efficiënt beheer, één deploy, maar tenant-isolatie moet in software.
- **Optie B — dedicated CDK-stack per kantoor:** kan bijna vandaag al (de stack bestaat), maximale isolatie ("uw data draait in een eigen omgeving" — accountants houden daarvan), stelt het tenant-model uit. Schaalt slechter in beheer; per-gebruiker-auth is alsnog nodig.

**Advies:** fase 1 als dedicated stack bij het pilotkantoor; het tenant-model pas bouwen als kantoor 2 concreet is. De pilot financiert dan de generalisatie en er wordt niets voor niets gebouwd.

## Openstaande beslissingen

- [ ] Productnaam + domein
- [ ] SaaS vs. stack-per-kantoor voor de pilot (advies: B, zie boven)
- [ ] Prijsmodel: per seat of per administratie
- [ ] Exact partnerprogramma-aanvraag indienen (lange doorlooptijd)
- [ ] Wie doet de pentest
