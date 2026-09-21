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

  /* Bilder. De går gjennom den samme krypterte kanalen som alt annet.
   *
   * maxCipherChars MÅ stemme med length(p_ct)-grensen i ssbms_put. Klienten
   * måler den faktiske chifferteksten før den sender (SSBMSSync.cipherLength),
   * så dette tallet er hele budsjettet - ingen gjetning på oppblåsingsfaktor.
   *
   * Målt faktor base64 → chiffertekst er 1,34x (verifisert mot ekte AES-GCM,
   * ikke anslått):
   *
   *   20 000  = standardskjemaet. Gir ca. 11 kB bilde, altså rundt 400 px.
   *  150 000  = etter supabase/2026-09-21-storre-bilder.sql. Gir ca. 84 kB,
   *             altså rundt 800 px i god kvalitet. Holder seg under
   *             Realtime-taket på 256 kB per kringkastet melding.
   *
   * REKKEFØLGE: kjør migreringen FØR du hever tallet her og deployer. Motsatt
   * vei blir bildene avvist av serveren. (De blokkerer riktignok ikke køen -
   * se flush() i store.js - men de kommer ikke fram.) */
  photos: {
    maxCipherChars: 20000,
    widths: [800, 640, 512, 400, 320, 256, 192],
    qualities: [0.6, 0.45, 0.33, 0.24]
  },

  /* Offline-nedlasting: hvor mange zoomnivåer over gjeldende som hentes. */
  offline: {
    extraZoomLevels: 3,
    maxTiles: 4000
  }
};
