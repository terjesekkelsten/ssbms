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

    async function ingest(row) {
      const rec = await SSBMSKey.decryptJSON(aesKey, { iv: row.iv, ct: row.ct });
      if (rec) SSBMSStore.apply(rec);
    }

    return {
      name: 'supabase',
      async connect() {
        client = window.supabase.createClient(cfg.url, cfg.anonKey, {
          realtime: { params: { eventsPerSecond: 20 } },
          auth: { persistSession: false }
        });

        channel = client
          .channel('ssbms:' + roomId)
          .on('postgres_changes',
            { event: '*', schema: 'public', table: 'ssbms_events', filter: 'room=eq.' + roomId },
            payload => { if (payload.new) ingest(payload.new); })
          .subscribe(status => {
            SSBMSStore.setOnline(status === 'SUBSCRIBED', 'supabase');
          });

        await this.loadAll();
        return true;
      },

      async loadAll() {
        const { data, error } = await client
          .from('ssbms_events')
          .select('kind,ref,iv,ct,updated_at')
          .eq('room', roomId)
          .order('updated_at', { ascending: true })
          .limit(2000);
        if (error) { console.warn('[ssbms] lasting feilet', error.message); return; }
        for (const row of data || []) await ingest(row);
        SSBMSStore.emit('remote');
      },

      async send(item) {
        try {
          const env = await SSBMSKey.encryptJSON(aesKey, item.rec);
          const { error } = await client.from('ssbms_events').upsert({
            room: roomId,
            kind: item.kind,
            ref: item.ref,
            iv: env.iv,
            ct: env.ct,
            updated_at: new Date().toISOString()
          }, { onConflict: 'room,kind,ref' });
          if (error) { console.warn('[ssbms] sending feilet', error.message); return false; }
          return true;
        } catch (e) {
          console.warn('[ssbms] sending feilet', e);
          return false;
        }
      },

      disconnect() {
        if (channel) client.removeChannel(channel);
        channel = null; client = null;
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
    const useSupabase = cfg.supabase && cfg.supabase.url &&
      cfg.supabase.anonKey && window.supabase;

    backend = useSupabase ? SupabaseBackend(cfg.supabase) : LocalBackend();
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
