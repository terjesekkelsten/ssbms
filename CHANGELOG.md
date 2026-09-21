# Endringslogg

Formatet følger [Keep a Changelog](https://keepachangelog.com/no/1.1.0/),
versjonene [semantisk versjonering](https://semver.org/lang/no/).

Versjonsnummeret står i `js/config.js` (`version` + `released`) og vises i
appen under **Meny → Vis sesjonsinfo** og nederst i menyen. Det er med vilje:
en app som har hengt igjen i nettleserens cache ser ellers helt lik ut som den
nye, og da er versjonsnummeret det eneste som avslører det. Stemmer det ikke
med denne fila, kjører telefonen gammel kode — bruk **Meny → Tving oppdatering
av appen**.

## Rutine for en utgivelse

1. Skriv endringene under `## [Ikke utgitt]` mens du jobber.
2. Ved utgivelse: flytt dem til en ny versjonsoverskrift med dato.
3. Oppdater `version` og `released` i `js/config.js`.
4. `git commit`, `git tag -a v0.3.0 -m "v0.3.0"`, `git push --follow-tags`.

---

## [Ikke utgitt]

Ingenting ennå.

## [0.3.0] — 2026-09-21

### Lagt til

- **Oppdrag-meny.** Lokasjonene (infil, exfil, sanplass, mål) ligger nå under
  ⚑ **Oppdrag** sammen med tegning. Ett ark for alt som beskriver oppdraget,
  i stedet for en flytknapp per ting.
- **Tegning på kartet.** Streker og piler med fritt antall punkter, i sort,
  rød, grønn og hvit. Hver strek tegnes med kontrastkant under, slik at sort
  er lesbar på skygge og hvit på snø. Trykk på en ferdig strek for å endre
  farge og form eller slette den. Fargevalget huskes mellom økter.
- **Kobling mellom observasjoner.** Velg to observasjoner, og streken følger
  dem. Flytter observasjonen seg, flytter koblingen seg med. Slettes en av
  endene, forsvinner streken — en kobling til noe som ikke finnes er verre enn
  ingen kobling. Koblinger tegnes stiplet for å skille dem fra faste streker.
- **Bilder på observasjoner og egen sektor.** Egne knapper for **Ta bilde**
  og **Velg bilde** — på iPhone åpner `capture="environment"` kameraet direkte
  og fjerner fotobiblioteket fra valgene, så begge deler må finnes. Bildet
  komprimeres automatisk til det passer, og krypteres som alt annet. Flere
  bilder per observasjon. Se «Kjente begrensninger».
- **Køen kan ikke lenger forgiftes.** En post serveren avviser (feil type, for
  stor nyttelast) ble tidligere liggende fremst i køen for alltid — og siden
  `flush()` stopper på første feil, ville ett avvist bilde stanset også
  posisjonsrapportene. Avviste poster forkastes nå med et varsel til brukeren,
  og transportfeil gis åtte forsøk før posten gis opp.
- **Snarvei til sektorarket.** Trykk på egen enhet på kartet → «Sektor og
  retning» rett i arket.
- **Aldersfilter på observasjoner.** ⏱ i verktøylinja skjuler observasjoner
  eldre enn 15 min, 1, 4, 12 eller 24 timer. Filteret måler mot
  observasjonstidspunktet, ikke mot når posten sist ble redigert — en
  observasjon du retter en skrivefeil i blir ikke ferskere av det. Det gjelder
  både kartet og lista, og et aktivt filter vises alltid som et merke i
  topplinja: et filter som skjuler halve situasjonsbildet uten at du ser det
  er en felle, særlig hvis det sto på fra forrige økt. Enheter, lokasjoner og
  tegninger skjules aldri, og en kobling til en skjult observasjon skjules
  sammen med den. Ingenting slettes — de andre i troppen ser fortsatt alt.
- **Tid siden på observasjoner.** Observasjonsarket viser nå både
  tidspunkt (Zulu) og hvor lenge det er siden.
- **Versjonsnummer i appen**, i sesjonsinfo og nederst i menyen.
- **Denne endringsloggen.**

### Endret

- Bygningsobservasjoner heter **BYGG** i hurtiglinja, ikke BYG.
- Modelinja har fått **Ferdig** og **Angre** når du tegner.
- Hurtigmenyen (langtrykk) er slått av mens du tegner, kobler eller måler
  siktlinje. Et langtrykk midt i en strek skal legge et punkt, ikke plassere
  en observasjon.
- GeoJSON-eksporten tar med tegninger som `LineString`.

### Rettet

- **Manuell posisjon ble overstyrt av GPS.** Satte du posisjonen for hånd,
  spratt den tilbake ved neste GPS-oppdatering — uten et ord. Manuell posisjon
  slår nå GPS av til du slår den på igjen selv. Topplinja viser **GPS AV**, og
  bryteren ligger i menyen. GPS-lytteren stoppes helt, ikke bare ignoreres:
  en manuell posisjon settes gjerne nettopp når mottaket er dårlig eller
  batteriet skal spares.

### Rettet (bilder, samme dag)

- **«Bildet lar seg ikke komprimere nok» på iPhone.** Årsaken var ikke
  budsjettet, men at WebKits `canvas.toDataURL` ignorerer kvalitetsargumentet
  for JPEG. Kvalitetssløyfen gjorde ingenting — bare bredden hadde effekt — og
  selv nederste trinn havnet over taket. Koding går nå via `toBlob`, som
  respekterer kvaliteten, med `toDataURL` som reserve.
- **Gjetningen på oppblåsingsfaktoren er erstattet med måling.** Klienten
  krypterer hvert komprimeringsforsøk og måler den faktiske chifferteksten
  (`SSBMSSync.cipherLength`) mot nøyaktig det taket serveren håndhever. Målt
  faktor er **1,34×**, ikke 1,8× som først antatt. Feilmeldingen oppgir nå
  oppnådd oppløsning og størrelse, slik at et avvist bilde er mulig å feilsøke.
- **Filvelgeren ga bare kamera på iPhone.** Nå to knapper: «Ta bilde» og
  «Velg bilde».

### Kjente begrensninger

- **Bilder er miniatyrer med standardskjemaet.** `ssbms_put` tar maks 20 000
  tegn chiffertekst, som med målt faktor 1,34× gir ca. **11 kB bilde** — i
  praksis 320–400 px. Nok til å vise hva du ser, ikke til å lese et skilt.
- **Dette kan heves uten Storage.** `supabase/2026-09-21-storre-bilder.sql`
  setter taket til 150 000 tegn ≈ **84 kB bilde**, altså 800 px i god
  kvalitet, og holder seg under Supabase Realtimes tak på 256 kB per
  kringkastet melding. Migreringen er rent utvidende. **Kjør den før du hever
  `photos.maxCipherChars` i `js/config.js` og deployer** — motsatt vei blir
  bildene avvist (men de blokkerer ikke lenger køen).
- Full oppløsning krever fortsatt Supabase Storage med eget herdet
  policy-sett — se veikartet.
- Tegninger og bilder sendes med transportetiketten `loc`, fordi
  check-constrainten i `ssbms_put` bare godtar `pos`, `poi` og `loc`. Se
  kommentaren i `js/store.js`. Ingen skjemaendring er nødvendig for denne
  versjonen.

## [0.2.0] — 2026-09-20

### Lagt til

- Supabase-bakende med herdet skjema: ingen direkte tabelltilgang, all bruk
  gjennom `ssbms_fetch` og `ssbms_put`, som begge krever rom-ID. Sanntid går
  over Broadcast, ikke `postgres_changes`.
- **Meny → Tving oppdatering av appen** som nødutgang fra en fastlåst cache.

### Endret

- Service worker gikk fra cache-først til **nett først** for appfiler, med
  3,5 s tidsavbrudd og cache som reserve. Kartfliser er fortsatt cache-først.

### Rettet

- Appen sa «KUN LOKALT» etter at Supabase-nøklene var lagt inn, fordi
  nettleseren serverte gammel `config.js` fra service worker-cachen.

## [0.1.0] — 2026-09-19

Første versjon: delt situasjonskart for jegertropp.

- 18-sifret sesjonsnøkkel, AES-GCM 256 med PBKDF2-utledet nøkkel.
- UTM-native kart (EPSG:25832/33/35) med MGRS-rutenett på Kartverkets WMTS.
- Observasjoner med APP-6-inspirert symbolikk, hurtigmeny på langtrykk.
- Enheter, observasjonssektorer, siktlinje mot DTM, lokasjoner.
- Offline-nedlasting av kartfliser, GeoJSON-eksport, lyttemodus.

[Ikke utgitt]: https://github.com/terjesekkelsten/ssbms/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/terjesekkelsten/ssbms/releases/tag/v0.3.0
[0.2.0]: https://github.com/terjesekkelsten/ssbms/releases/tag/v0.2.0
[0.1.0]: https://github.com/terjesekkelsten/ssbms/releases/tag/v0.1.0
