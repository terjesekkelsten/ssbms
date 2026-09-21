/* SSBMS - lokal konfigurasjon
 *
 * Kopier denne fila til config.local.js hvis du vil holde nøkler utenfor git,
 * og endre <script>-taggen i index.html tilsvarende.
 */

window.SSBMS_CONFIG = {

  /* Versjon. Holdes i sync med CHANGELOG.md og git-taggen, og vises i
     Meny -> Sesjonsinfo. Poenget er at du i felt kan lese av hvilken versjon
     telefonen faktisk kjorer - en app som har hengt igjen i cachen ser ellers
     helt lik ut som den nye. */
  version: '0.3.0',
  released: '2026-09-21',

  /* Supabase. La stå tom for lokal modus (synker kun faner på samme maskin).
   *
   * publishableKey er Supabases nye navn på det som het «anon public». Den er
   * ment å ligge i klienten og er offentlig - innholdet krypteres uansett før
   * det sendes, og skjemaet slipper ingen til uten rom-ID. Se
   * supabase/schema.sql.
   *
   * ADVARSEL: sb_secret_... (tidligere service_role) skal ALDRI inn her.
   * Den omgår RLS og alle grants, og ville gjort hele skjemaet virkningsløst. */
  supabase: {
    url: 'https://jucjxprexxjyjlijfrho.supabase.co',
    publishableKey: 'sb_publishable_ofqrBW8vVq523-5I-fgYdQ_ITsJ6hBR'
  },

  /* Kallesignal i nedtrekkslista. Rediger fritt - det er kun forslag. */
  callsigns: [
    '41', '42', '4F',
    'S1.1', 'S1.2', 'S2.1', 'S2.2', 'S3.1', 'S3.2',
    'O1.1', 'O1.2', 'O2.1', 'O2.2', 'O3.1', 'O3.2'
  ],

  /* Standardverdier */
  defaults: {
    observationRange: 800,     // m
    observationWidth: 30,      // grader
    observerHeight: 1.7,       // m over bakken, brukt i siktlinje
    targetHeight: 1.7,         // m
    positionIntervalMs: 15000, // hvor ofte egen posisjon sendes
    staleMinutes: 10
  },

  /* Bilder. Miniatyrer gar gjennom den samme krypterte kanalen som alt annet,
     og ssbms_put tar maks 20 000 tegn chiffertekst. Base64 + AES + base64 gir
     omtrent 1,8x oppblasing, sa taket i praksis er ca. 10 kB bilde. Det er en
     miniatyr - ikke dokumentasjonsfoto. Full opplosning krever Supabase
     Storage, se CHANGELOG / veikart. */
  photos: {
    maxBytes: 10000,
    widths: [480, 384, 320, 256],
    qualities: [0.6, 0.5, 0.42, 0.34]
  },

  /* Offline-nedlasting: hvor mange zoomnivåer over gjeldende som hentes. */
  offline: {
    extraZoomLevels: 3,
    maxTiles: 4000
  }
};
