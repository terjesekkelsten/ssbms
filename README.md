# SSBMS — Super Simple Battlefield Management System

Delt situasjonskart for en jegertropp. Ren HTML/JS, ingen byggesteg, ingen
rammeverk. Kjører like godt fra en mappe på PC som fra Vercel.

---

## Kom i gang på 2 minutter

Service worker og geolokasjon krever `http://localhost` eller HTTPS — å åpne
`index.html` direkte som fil virker **ikke**.

```powershell
cd C:\Users\sekke\SSBMS
npx serve -l 5173 .
```

eller, hvis du har Python:

```powershell
cd C:\Users\sekke\SSBMS
python -m http.server 5173
```

Åpne `http://localhost:5173`.

1. Trykk **Generer ny nøkkel**, sett breddegrad/lengdegrad omtrent midt i AO-et,
   velg sone (32 for Sør-Norge), trykk **Lag nøkkel** → **Bruk denne**.
2. Velg kallesignal.
3. **Åpne kart**.

Åpne gjerne to faner med samme nøkkel og ulike kallesignal — i lokal modus
synker de mot hverandre, så du ser hele delingsflyten uten backend.

---

## Teste på telefon: appen krever HTTPS

Prøver du `http://<PC-ens IP>:5173` fra telefonen, nekter appen å starte og
forklarer hvorfor. Det er ikke en feil — **Web Crypto (`crypto.subtle`) finnes
bare i «secure context»**: HTTPS eller `localhost`. Det samme gjelder GPS og
service worker. Over ren HTTP er `crypto.subtle` rett og slett `undefined`.

Dette bør ikke omgås. Over ren HTTP er selve transporten ukryptert uansett hva
appen gjør med innholdet — for et BMS er det verre enn at appen nekter å starte.

Tre veier, i den rekkefølgen jeg ville prøvd dem:

### 1. Vercel — mest pålitelig
Ekte sertifikat, alt virker inkludert offline-cache. Se deploy-avsnittet under.
Du skulle dit uansett.

### 2. HTTPS på eget nett
```powershell
cd C:\Users\sekke\SSBMS
node serve-https.js
```
Lager et selvsignert sertifikat i `.certs/` ved første kjøring (henter `selfsigned`
fra npm én gang), og skriver ut adressene telefonen kan bruke. Åpne
`https://<PC-ens IP>:5174`, godta sertifikatadvarselen én gang.

Sertifikatet dekker `localhost`, PC-ens maskinnavn og alle lokale IP-adresser,
så du slipper ekstra navneadvarsler. Trafikken forlater ikke nettverket ditt.

> **Én begrensning:** nettleseren nekter å registrere en service worker på et
> sertifikat den ikke stoler på. Krypteringen, GPS-en og alt annet virker, men
> **offline-cache av kart gjør det ikke** på denne veien. Appen viser
> `INGEN OFFLINE` i topplinja når det er tilfelle, så du ikke oppdager det først
> uten dekning. Skal du feltteste offline, må du bruke Vercel.

Bruk `PORT=5175 node serve-https.js` hvis porten er opptatt. Brannmuren må slippe
inn porten, og telefonen må være på samme nett.

### 3. PC-en via localhost
`http://localhost:5173` regnes alltid som sikker, uansett protokoll.

---

## Deling mellom enheter må skrus på

**Uten Supabase-oppsett deles ingenting mellom enheter.** Appen starter i lokal
modus, der den bare synker mellom faner i samme nettleser på samme maskin. PC-en
og mobilen ser da hver sine data, selv med identisk nøkkel.

Topplinja viser **`KUN LOKALT`** i rødt når det er tilfelle, og delingsarket
(Meny → Deling) åpnes automatisk første gang per økt. Å tro at man deler når man
ikke gjør det er den verste feilen dette systemet kan gjøre, så den er vanskelig
å overse med vilje.

Oppsettet står under [Supabase](#supabase). Det tar noen minutter.

---

## Nøkkelen

18 siffer, delt i fire:

| Siffer | Betydning | Virkning ved feil |
|---|---|---|
| 1–10 | Sesjonshemmelighet | Feil → avvist umiddelbart (kontrollsiffer) |
| 11–13 | AO-origo østing, i km | Feil → **data vises, men forskjøvet** |
| 14–16 | AO-origo nording, i 10 km | Feil → **data vises, men forskjøvet** |
| 17 | UTM-sone: 2, 3 eller 5 | Feil → data plottes i feil sone |
| 18 | Luhn-kontrollsiffer over 1–10 | — |

**Hvorfor dekker kontrollsifferet bare sesjonsdelen?** Fordi det er nettopp
gridsifrene som skal kunne være feil uten at systemet sier fra — det er
funksjonen du spesifiserte. En tastefeil i sesjonsdelen er derimot bare en
tastefeil, og fanges med én gang.

Alle koordinater sendes som avstand fra AO-origo. Feil gridsiffer gir derfor
korrekt dekryptert innhold plottet med nøyaktig den forskyvningen feilen
tilsvarer (ett siffer i østing = 1 km, ett i nording = 10 km).

### Hva krypteringen faktisk beskytter

Innholdet krypteres klientside med **AES-GCM 256**, nøkkel utledet med
**PBKDF2-SHA256, 600 000 runder**, fra sesjonssifrene. Rom-ID er SHA-256 av de
samme sifrene. Serveren lagrer bare chiffertekst.

**Det betyr at tjenesten ikke kan lese posisjoner, kallesignal eller tekst.**

**Det betyr ikke at nøkkelen er sterk.** 10 siffer er ca. 33 bit. PBKDF2 hever
kostnaden per gjetning kraftig, men en motstander som har fanget chiffertekst
og har tid og maskinvare, kommer gjennom. Vurderingen er:

- Mot tilfeldig innsyn, feiltasting og nysgjerrige: god nok.
- Mot tjenesteleverandøren som passiv leser: god.
- Mot en motstander med ressurser og fanget trafikk: **ikke tilstrekkelig.**

Vil du ha reell margin, bytt til en lengre nøkkel eller en QR-delt tilfeldig
256-bits nøkkel. Formatet er lett å utvide — se `js/keys.js`.

Gridsifrene er **forskyvning, ikke sikkerhet**. En konstant offset avsløres
umiddelbart hvis én sann posisjon er kjent, fordi relativ geometri er bevart.

---

## Bruk i felt

### POI med ett grep — eller tre trykk
**Hold inne** på kartet (eller høyreklikk på PC). Radialmenyen åpnes, og den
virker på to måter:

- **Ett sammenhengende grep:** dra til ikonet for type, fortsett draget ut til
  fargeringen, slipp. Raskest når du har den i fingrene.
- **Løft fingeren og trykk:** slipper du uten å ha valgt noe, blir menyen
  stående. Trykk type, trykk farge. Dette er den naturlige flyten på telefon.

Avbryt ved å trykke «AVBRYT» i midten, trykke utenfor, eller dra tilbake til
midten og slippe.

Skal du merke mange av samme slag: velg type og farge i hurtiglinja nederst,
så plasserer ett trykk i kartet. Trykk typen igjen for å avvæpne.

Trykk på et symbol for å legge til antall, tidspunkt, beskrivelse og
bevegelse/retning. Bevegelse vises som tynn pil i kartet.

### Sektor og retning
⊿-knappen. Trykk en kile på skiva for 22,5°-sprang, eller dra rundt for
gradvis justering. Sett bredde og rekkevidde med sliderne. Teksten genereres
automatisk: *«41 observerer mot NØ (045°), sektor 30°, ut til 800 m.»*

En sektor må ha et utgangspunkt, så den krever at du har en egen posisjon.
Har du ikke det — typisk på PC uten GPS — sier arket fra, og knappen blir
**Sett posisjon i kartet**. Still inn retningen først; den lagres i det du
trykker der du står.

Sektor for andre enheter settes i enhetsarket til en håndplassert enhet
(trykk enheten → **Flytt / sektor**).

### Lokasjoner
⚑-knappen: infil, exfil, sanplass (rødt kors), mål. Velg type, trykk i kartet.

### Navn på enheter
Alle enheter kan ha et klartekstnavn ved siden av kallesignalet — *«Troppssjef»*,
*«Skarpskytter 1»*. Navnet settes ved innlogging, eller senere i Meny →
**Navn på egen enhet**. Det lagres per kallesignal og hentes fram automatisk
neste gang du logger inn med samme kallesignal.

Det er **to uavhengige brytere**, og forskjellen er viktig:

| Bryter | Hvor | Virkning |
|---|---|---|
| **Vis navnet på kartet** | per enhet, i navne-/plasseringsarket | Synkes til **hele troppen**. Skrur du den av, ser ingen det navnet. Standard: **på**. |
| **Skjul alle enhetsnavn** | Meny → 🙈 | Kun **din egen** skjerm. Rører ikke dataene. |

Bruk den første når et navn ikke skal deles. Bruk den andre når kartet er fullt
og du bare vil ha ro på din egen skjerm.

Navnet vises som en liten lapp under enhetssymbolet, følger med i sidepanelet,
i den genererte meldingsteksten og i GeoJSON-eksporten.

### Plassere enheter fra troppen
👥-knappen (eller Meny → Plasser enhet). For enheter som ikke kan melde inn selv.
Velg kallesignal, og enten:

- **navn og avhuking** — samme som over: navn er valgfritt, visning er på som standard.
- **lim inn en rute** — feltet godtar MGRS (`32V NM 84837 39530`), MGRS uten sone
  (`NM 84837 39530`), absolutt UTM (`584837 6639530`, med eller uten E/N) og kort
  feltrute (`848 395`, `84837 39530`). Korte ruter løses mot egen posisjon, eller
  mot kartsenter hvis du ikke har posisjon. Forhåndsvisningen viser tolket rute,
  avstand og retning før du lagrer.
- **slipp på kart** — armer, trykk der enheten står.

Håndplasserte enheter får **stiplet ring og et «M»-merke**, og arket viser
«plassert for hånd av \<kallesignal\>». Det skillet er med vilje: en rapportert
posisjon og en antatt posisjon skal aldri se like ut på kartet. Melder enheten
inn egen posisjon senere, overtar den automatisk (nyeste tidsstempel vinner).

Trykk på en håndplassert enhet for å flytte den, endre navn, gi den en sektor,
eller fjerne den.

### Armering og modusbanner
Når en handling er armert (POI, lokasjon, enhet, manuell posisjon, siktlinje)
vises et gult banner øverst med hva neste kartklikk gjør, og en **Avbryt**-knapp.
**Esc** avvæpner også. Kun én handling kan være armert av gangen.

### Siktlinje
👁-knappen. Startpunkt settes automatisk til egen posisjon hvis den er kjent.
Trykk målpunkt. Du får terrengprofil, grønn/rød markering i kartet og
avstand til første sperre.

> **Forbehold, og det er viktig:** analysen bruker Kartverkets terrengmodell —
> **bar bakke**. Ingen skog, ingen bygninger. I norsk terreng gir dette
> systematisk for optimistisk sikt. Dette er en terrengsperre-analyse, ikke en
> sikthetsvurdering. Teksten står også i appen.

### Nattmodus
🌙 gir sort kart og rød tekst. Filteret legges kun på fliselaget, så
symbolfargene (grønn/blå/grå/rød) består.

### Meny (⋯)
- **Lyttemodus** — mottar, men sender ingenting. Bruk når utsendelse er et
  problem. Køen tømmes når du slår den av igjen.
- **Sett egen posisjon manuelt** — trykk i kartet i stedet for GPS. Sparer batteri
  og unngår GPS-avhengighet. Forblir på til du slår den av.
- **Plasser enhet fra troppen** — samme som 👥-knappen.
- **Navn på egen enhet** — sett eller endre navn, og om det skal deles.
- **Skjul alle enhetsnavn** — lokal opprydding, påvirker ikke andre.
- **Last ned kart offline** — cacher fliser for gjeldende utsnitt, fire
  zoomnivåer. Gjør dette før du mister dekning.
- **Eksporter GeoJSON** — for debrief, QGIS eller arkiv.
- **Slett alt og logg ut** — tømmer lokal lagring og flise-cache.

---

## Deling mellom enheter

### Lokal modus (standard)
Uten Supabase-konfigurasjon synker appen kun mellom faner på samme maskin via
`BroadcastChannel`. Alt lagres i `localStorage`. Perfekt for funksjonstesting,
ubrukelig i felt.

### Supabase
1. Lag et gratis prosjekt på **supabase.com** (velg region `eu-north-1` Stockholm
   eller `eu-central-1` Frankfurt — nærmest, og dataene blir i EØS).
2. Åpne **SQL Editor** og kjør hele `supabase/schema.sql`.
3. **Project Settings → API**: kopier `Project URL` og `anon public`-nøkkelen
   inn i `js/config.js`.
4. Commit og push. Merket øverst i appen skal si **SUPABASE**, ikke `KUN LOKALT`.

#### Hvorfor skjemaet ikke bruker vanlige RLS-policies

`anonKey` står i klientkoden på et offentlig nettsted. Den er offentlig uansett,
og et privat repo endrer ikke på det. Skjemaet kan derfor ikke anta at nøkkelen
er hemmelig.

Med den naive varianten — RLS `using (true)` og direkte tabelltilgang — kunne
hvem som helst med den nøkkelen dumpe **hele** tabellen (all chiffertekst, alle
rom-ID-er, tidsstempler, aktivitetsmønstre) og overskrive **hvilken som helst**
rad. Klienten forkaster data som ikke lar seg dekryptere, så en enhet ville bare
forsvinne fra kartet.

I stedet har tabellen **ingen** policies og ingen rettigheter for `anon`. All
tilgang går gjennom to funksjoner som begge krever rom-ID-en:

| | |
|---|---|
| `ssbms_fetch(rom)` | returnerer kun det rommets rader |
| `ssbms_put(rom, type, ref, iv, ct)` | validerer form og størrelse, upserter én rad |

Rom-ID er SHA-256 av de ti sesjonssifrene, så uten nøkkelen finnes ingen
inngang — verken til å lese eller skrive.

Sanntid går over **Broadcast** på en kanal som heter rom-ID-en, ikke over
`postgres_changes`. Samme grunn: `postgres_changes` ville krevd `SELECT` på
tabellen og dermed åpnet for å abonnere på alt.

Verifisert mot en ekte PostgreSQL 16: direkte `select`, `insert`, `update` og
`delete` som rollen `anon` avvises alle med *permission denied*; ugyldig
rom-ID, ugyldig type og for stor nyttelast avvises av funksjonene; `ssbms_purge`
kan ikke kalles fra klienten.

#### Hva det fortsatt ikke beskytter mot

- Den som har nøkkelen har full tilgang til sitt rom. Det er designet.
- Sesjonsdelen er ti siffer (~33 bit) — se avsnittet om nøkkelen over.
- Trafikkmønster er synlig for Supabase uansett kryptering.

Slå på rate limiting (Settings → API) og kjør `ssbms_purge()` etter øvelse.

---

## Deploy

Allerede satt opp:

| | |
|---|---|
| Live | https://ssbms-inky.vercel.app |
| GitHub | https://github.com/terjesekkelsten/ssbms (offentlig) |
| Vercel-prosjekt | `ssbms` |

Vercel er koblet til GitHub-repoet, så **en push til `main` deployer automatisk**.
Ingen bygging — filene serveres som de er, og `vercel.json` setter cache-headerne.

```powershell
cd C:\Users\sekke\SSBMS
git add -A
git commit -m "beskrivelse av endringen"
git push
```

> **Én linje hver.** Windows PowerShell 5.1 — den som følger med Windows — støtter
> ikke `&&`, og gir `The token '&&' is not a valid statement separator`. `;` virker,
> men kjører videre selv om noe feiler: en feilet commit ville blitt fulgt av en
> push som sender forrige versjon. Tre linjer stopper der det skal.
> I PowerShell 7 (`pwsh`) virker `&&` som i bash.

Etter en deploy kan første lasting vise forrige versjon, fordi service workeren
serverer cache først og oppdaterer i bakgrunnen. Ctrl+Shift+R henter ny med én gang.

### Innstillinger som er satt bevisst

- **Vercel Authentication er AV** — appen ligger åpent på nett, og nøkkelen er hele
  tilgangskontrollen. Skrus på i Project Settings → Deployment Protection.
- **Repoet er offentlig.** Ingen hemmeligheter i koden, men nøkkelformatet er
  dokumentert her. Endres i GitHub Settings → Danger Zone.
- Legger du Supabase-nøklene i `js/config.js`, blir `anonKey` synlig i det
  offentlige repoet. Den er laget for å være offentlig og innholdet er kryptert,
  men slå på rate limiting i Supabase-dashbordet.

---

## Valg som er tatt — og som du bør vurdere bevisst

### Farger avviker fra APP-6
Du spesifiserte grønn=egne, blå=sivil, grå=ukjent, rød=fiendtlig.
NATO/APP-6 bruker **blå=egne, grønn=nøytral, gul=ukjent, rød=fiendtlig**.

Avviket er implementert som du ba om, men det er en reell interoperabilitetsrisiko:
noen som kommer fra et NATO-system leser blå som «egne» og ser en sivil.
Derfor bærer symbolene **også form**: venn-ramme, firkant (nøytral), kløverblad
(ukjent), romb (fiendtlig) — APP-6-formene. Formen er entydig selv når fargen
er misforstått, i gråtone eller i nattmodus.

Vil du over til APP-6-farger er det én linje per tilhørighet i `js/symbols.js`.

### UTM-sone er låst av nøkkelen
Kartet kjører i sonen sifferet ditt angir. Opererer dere over en sonegrense
(f.eks. 32/33 i Nord-Trøndelag), blir koordinater nær grensen strukket.
Løsningen er å velge sone etter AO-et, ikke etter standard.

### Kartkilde
Kartverkets åpne cache, `cache.kartverket.no`. Matrisesettene er verifisert mot
`WMTSCapabilities.xml`: origo varierer per sone (32: −2 000 000, 33: −2 500 000,
35: −3 500 000; alle med N = 9 045 984). Attribusjon «© Kartverket» er påkrevd
og ligger i kartet.

### Høydedata
`ws.geonorge.no/hoydedata/v1/profil`. Krever nett — siktlinje fungerer ikke
offline. Fullt 360° viewshed er neste steg og krever lokal DEM (DTM10 for et
20×20 km AO er ca. 16 MB, fullt regnbart i en Web Worker).

---

## Det du må avklare før dette brukes på noe annet enn øvingsdata

Vercel og Supabase er kommersiell infrastruktur i utlandet. Klientside-kryptering
skjuler innholdet, men **ikke metadata**: hvilket rom som er aktivt, når det
sendes, hvor ofte, og fra hvilke IP-adresser. Et trafikkmønster er i seg selv
informasjon.

Hvorvidt det er akseptabelt er et spørsmål for din organisasjon, ikke for koden.
Avklar det før reelle enhetsdata legges inn.

---

## Filstruktur

```
index.html              oppsett og innlogging
serve-https.js          HTTPS-utviklingsserver med selvsignert sertifikat
sw.js                   service worker: app-cache + flise-cache
manifest.webmanifest    PWA
vercel.json             cache-headere
css/style.css           dag/natt, mobil og PC
js/config.js            Supabase, kallesignal, standardverdier  ← rediger her
js/keys.js              nøkkelformat, Luhn, PBKDF2, AES-GCM
js/geo.js               proj4-defs, UTM, MGRS inn/ut, rutetolkning, rutenettlogikk
js/symbols.js           APP-6-rammer, glyfer, lokasjonssymboler
js/map.js               Leaflet + Proj4Leaflet, Kartverket-WMTS, rutenettlag
js/store.js             tilstand, persistens, utgående kø
js/sync.js              lokal / Supabase-bakende
js/los.js               terrengprofil og siktlinjeberegning
js/ui.js                radialmeny, sektorskive, ark
js/app.js               sammenkobling
supabase/schema.sql     tabell, RLS, oppbevaringsrutine
vendor/                 Leaflet, proj4, Proj4Leaflet, supabase-js (lokalt for offline)
```

---

## Rettet etter andre testrunde

**Hurtigmenyen forsvant når man løftet fingeren.** Den antok at valget skjedde i
ett sammenhengende drag, så et vanlig langtrykk → løft → trykk lukket den uten å
registrere noe. Menyen går nå over i trykkemodus i stedet for å lukke seg når du
slipper uten å ha valgt. Begge flytene virker.

**Sektor kunne ikke settes uten posisjon — i stillhet.** «Del» kalte en funksjon
som returnerte uten å gjøre noe når egen posisjon manglet, og sa så «Sektor
delt». Nå forklarer arket hva som mangler, knappen tilbyr å sette posisjonen, og
sektoren blir med i det posisjonen settes.

**Lokal modus var for lett å overse.** Merket sa «LOKAL» i grått. Det sier nå
`KUN LOKALT` i rødt, menyen viser det samme, og delingsarket med oppsettstegene
åpnes automatisk første gang per økt.

## Rettet etter første test

**«undefined is not an object (evaluating crypto…)» på telefon.** Appen krasjet
med en ubrukelig feilmelding når den ble åpnet over ren HTTP fra LAN-en, fordi
`crypto.subtle` ikke finnes utenfor secure context. Nå oppdages det før
innlogging, og appen forklarer årsaken og de tre veiene videre i stedet for å
kræsje. `serve-https.js` er lagt til for å gjøre vei nummer to enkel.

Samme runde: manglende service worker (som skjer på selvsignert sertifikat)
gir nå et vedvarende `INGEN OFFLINE`-merke i topplinja og en forklaring under
Meny → Vis sesjonsinfo. En toast forsvinner, og at kartet mangler uten dekning
er ikke noe man skal oppdage i felt.


**Egen posisjon flyttet seg når man plasserte en lokasjon.** Lokasjonsplassering
brukte sin egen `map.once('click')`-lytter samtidig som manuell posisjon lyttet
på det samme klikket. Begge kjørte på ett trykk. All kartklikk-håndtering går nå
gjennom én tilstandsmaskin (`pending` i `js/app.js`) der nøyaktig én handling kan
være armert, og armeringen alltid er synlig i modusbanneret. En usynlig modus som
spiser kartklikk var den egentlige feilen — ikke bare den doble lytteren.

## Neste steg, i den rekkefølgen jeg ville tatt dem

1. **Test lokalt med to faner.** Verifiser at POI, sektor og lokasjoner dukker
   opp begge veier, og at rutenettet stemmer mot et papirkart du stoler på.
2. **Supabase.** Test med to telefoner på ulike nett.
3. **Feltprøve uten dekning.** Last ned offline-kart, sett telefonen i flymodus,
   sjekk at kartet består og at køen tømmes når sambandet er tilbake.
4. **360° viewshed** med lokal DEM.
5. **DOM i stedet for DTM** for siktlinjer — vesentlig riktigere i skog.
