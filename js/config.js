/* SSBMS - lokal konfigurasjon
 *
 * Kopier denne fila til config.local.js hvis du vil holde nøkler utenfor git,
 * og endre <script>-taggen i index.html tilsvarende.
 */

window.SSBMS_CONFIG = {

  /* Supabase. La stå tom for lokal modus (synker kun faner på samme maskin).
   * anonKey er en offentlig nøkkel - den er ment å ligge i klienten. Innholdet
   * er uansett kryptert før det sendes. Se supabase/schema.sql. */
  supabase: {
    url: '',        // f.eks. 'https://abcdefgh.supabase.co'
    anonKey: ''     // 'eyJhbGciOi...'
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

  /* Offline-nedlasting: hvor mange zoomnivåer over gjeldende som hentes. */
  offline: {
    extraZoomLevels: 3,
    maxTiles: 4000
  }
};
