/* SSBMS - synkronisering
 *
 * To bakender med samme grensesnitt:
 *   lokal     BroadcastChannel + localStorage. Synker faner på samme maskin.
 *             Brukes automatisk når Supabase ikke er konfigurert.
 *   supabase  Postgres + Realtime. Ekte deling mellom enheter.
 *
 * Alt innhold krypteres klientside (AES-GCM) før det forlater enheten.
 * Tjenesten ser rom-ID, tidsstempel og meldingstype - ikke posisjoner eller tekst.
 */

const SSBMSSync = (() => {
  'use strict';

  let aesKey = null;
  let roomId = null;
  let backend = null;

  /* =========================================================
   *  Lokal bakende
   * ========================================================= */

  function LocalBackend() {
    let ch = null;

    return {
      name: 'lokal',
      async connect() {
        ch = new BroadcastChannel('ssbms:' + roomId);
        ch.onmessage = async ev => {
          const rec = await SSBMSKey.decryptJSON(aesKey, ev.data);
          if (rec) SSBMSStore.apply(rec);
        };
        SSBMSStore.setOnline(true, 'lokal');
        return true;
      },
      async send(item) {
        const env = await SSBMSKey.encryptJSON(aesKey, item.rec);
        ch.postMessage(env);
        return true;
      },
      async loadAll() { /* alt ligger allerede i localStorage */ },
      disconnect() { if (ch) ch.close(); ch = null; SSBMSStore.setOnline(false); }
    };
  }

  /* =========================================================
   *  Supabase-bakende
   * ========================================================= */

  function SupabaseBackend(cfg) {
    let client = null;
    let channel = null;
    let ready = false;

    async function ingest(row) {
      const rec = await SSBMSKey.decryptJSON(aesKey, { iv: row.iv, ct: row.ct });
      if (rec) SSBMSStore.apply(rec);
    }

    return {
      name: 'supabase',

      async connect() {
        client = window.supabase.createClient(cfg.url, cfg.key, {
          realtime: { params: { eventsPerSecond: 20 } },
          auth: { persistSession: false }
        });

        /* Sanntid går over Broadcast på en kanal som heter rom-ID-en - ikke
           over postgres_changes. postgres_changes ville krevd SELECT på
           tabellen, og siden anonKey er offentlig (appen ligger åpent på nett)
           hadde det latt hvem som helst abonnere på alle rom. Her må du kjenne
           rom-ID-en for å i det hele tatt finne kanalen. */
        channel = client.channel('ssbms:' + roomId, { config: { broadcast: { self: false } } });
        channel.on('broadcast', { event: 'rec' }, msg => {
          if (msg && msg.payload) ingest(msg.payload);
        });

        await new Promise(resolve => {
          let settled = false;
          const done = ok => { if (!settled) { settled = true; ready = ok; resolve(); } };
          channel.subscribe(status => {
            if (status === 'SUBSCRIBED') { SSBMSStore.setOnline(true, 'supabase'); done(true); }
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              SSBMSStore.setOnline(false, 'supabase'); done(false);
            }
          });
          setTimeout(() => done(ready), 12000);   // ikke heng for alltid
        });

        await this.loadAll();
        return true;
      },

      /** Henter romhistorikken. Databasen slipper oss ikke til uten rom-ID. */
      async loadAll() {
        const { data, error } = await client.rpc('ssbms_fetch', { p_room: roomId });
        if (error) {
          console.warn('[ssbms] lasting feilet:', error.message);
          SSBMSUI && SSBMSUI.toast && SSBMSUI.toast('Kunne ikke hente romdata: ' + error.message, 'warn');
          return;
        }
        for (const row of data || []) await ingest(row);
        SSBMSStore.emit('remote');
      },

      async send(item) {
        try {
          const env = await SSBMSKey.encryptJSON(aesKey, item.rec);

          // Lagres først, slik at en enhet som kobler til senere ser den.
          const { error } = await client.rpc('ssbms_put', {
            p_room: roomId, p_kind: item.kind, p_ref: item.ref,
            p_iv: env.iv, p_ct: env.ct
          });
          if (error) { console.warn('[ssbms] sending feilet:', error.message); return false; }

          // Så ut til dem som er på nå. Feiler dette, er raden likevel lagret,
          // så vi regner sendingen som vellykket og lar mottakeren hente den.
          if (channel) {
            try { await channel.send({ type: 'broadcast', event: 'rec', payload: env }); }
            catch (e) { console.warn('[ssbms] kringkasting feilet (raden er lagret):', e); }
          }
          return true;
        } catch (e) {
          console.warn('[ssbms] sending feilet:', e);
          return false;
        }
      },

      disconnect() {
        if (channel && client) client.removeChannel(channel);
        channel = null; client = null; ready = false;
        SSBMSStore.setOnline(false);
      }
    };
  }

  /* =========================================================
   *  Oppsett
   * ========================================================= */

  async function start(key) {
    const d = await SSBMSKey.derive(key);
    aesKey = d.aesKey;
    roomId = d.roomId;
    SSBMSStore.state.roomId = roomId;
    SSBMSStore.state.key = key;
    SSBMSStore.restore();

    const cfg = window.SSBMS_CONFIG || {};
    // publishableKey er det nye navnet; anonKey godtas fortsatt.
    const sb = cfg.supabase || {};
    const sbKey = sb.publishableKey || sb.anonKey;
    const useSupabase = sb.url && sbKey && window.supabase;

    backend = useSupabase ? SupabaseBackend({ url: sb.url, key: sbKey }) : LocalBackend();
    SSBMSStore.setSender(item => backend.send(item));

    try {
      await backend.connect();
    } catch (e) {
      console.warn('[ssbms] tilkobling feilet, faller tilbake til lokal modus', e);
      backend = LocalBackend();
      SSBMSStore.setSender(item => backend.send(item));
      await backend.connect();
    }

    window.addEventListener('online', () => SSBMSStore.flush());
    window.addEventListener('offline', () => SSBMSStore.setOnline(false));

    return { roomId, backend: backend.name };
  }

  function stop() { if (backend) backend.disconnect(); }
  function reload() { return backend && backend.loadAll ? backend.loadAll() : null; }

  return { start, stop, reload };
})();
