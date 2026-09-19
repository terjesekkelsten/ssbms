-- SSBMS - Supabase-skjema
-- Kjør dette i Supabase > SQL Editor på et nytt prosjekt.
--
-- Tjenesten lagrer KUN chiffertekst. Den ser rom-ID, meldingstype og tidspunkt.
-- Posisjoner, kallesignal, beskrivelser og observasjoner er kryptert klientside
-- med AES-GCM og kan ikke leses av databasen eller av Supabase.

create table if not exists public.ssbms_events (
  room        text        not null,
  kind        text        not null check (kind in ('pos', 'poi', 'loc')),
  ref         text        not null,
  iv          text        not null,
  ct          text        not null,
  updated_at  timestamptz not null default now(),
  primary key (room, kind, ref)
);

create index if not exists ssbms_events_room_time
  on public.ssbms_events (room, updated_at desc);

-- Realtime
alter publication supabase_realtime add table public.ssbms_events;
alter table public.ssbms_events replica identity full;

-- ---------------------------------------------------------------------------
-- Tilgang
--
-- Det finnes ingen brukerinnlogging: rom-ID-en (SHA-256 av sesjonssifrene)
-- ER tilgangen. Rader kan derfor skrives og leses av alle som kjenner rommet.
-- Dette er bevisst, men betyr to ting du må vite:
--   1. Innholdet er beskyttet av krypteringen, ikke av databasen.
--   2. Hvem som helst med anon-nøkkelen kan skrive søppelrader i et rom de
--      kjenner ID-en til. Rate limiting i Supabase-dashbordet anbefales.
-- ---------------------------------------------------------------------------

alter table public.ssbms_events enable row level security;

drop policy if exists ssbms_read  on public.ssbms_events;
drop policy if exists ssbms_write on public.ssbms_events;
drop policy if exists ssbms_update on public.ssbms_events;

create policy ssbms_read   on public.ssbms_events for select using (true);
create policy ssbms_write  on public.ssbms_events for insert with check (true);
create policy ssbms_update on public.ssbms_events for update using (true) with check (true);

-- Ingen delete-policy: rader slettes ikke av klienten, de merkes slettet
-- inne i den krypterte nyttelasten.

-- ---------------------------------------------------------------------------
-- Oppbevaring
--
-- Data bør ikke ligge lenger enn nødvendig. Kjør denne manuelt etter øvelse,
-- eller sett den opp som en pg_cron-jobb (Database > Extensions > pg_cron).
-- ---------------------------------------------------------------------------

create or replace function public.ssbms_purge(older_than interval default interval '48 hours')
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  delete from public.ssbms_events where updated_at < now() - older_than;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Slett alt eldre enn 48 timer, hver time:
-- select cron.schedule('ssbms-purge', '0 * * * *', $$select public.ssbms_purge()$$);

-- Slett ett bestemt rom umiddelbart:
-- delete from public.ssbms_events where room = '<rom-id>';
