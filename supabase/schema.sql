-- SSBMS - Supabase-skjema
-- Kjør hele denne fila i Supabase > SQL Editor på et nytt prosjekt.
--
-- ---------------------------------------------------------------------------
-- HVORFOR DETTE SKJEMAET SER UT SOM DET GJØR
--
-- Appen ligger offentlig på nett, så `anonKey` står i klientkoden og er
-- offentlig uansett. Et privat repo hjelper ikke. Derfor kan skjemaet ikke
-- basere seg på at nøkkelen er hemmelig.
--
-- Den naive varianten - RLS med `using (true)` og direkte tabelltilgang -
-- ville latt hvem som helst med den nøkkelen:
--   * dumpe HELE tabellen: all chiffertekst, alle rom-ID-er, tidsstempler og
--     aktivitetsmønstre for alle sesjoner
--   * overskrive hvilken som helst rad. Klienten forkaster data som ikke lar
--     seg dekryptere, så en enhet ville bare forsvinne fra kartet
--
-- I stedet: INGEN direkte tabelltilgang. To funksjoner som begge KREVER
-- rom-ID-en. Rom-ID er SHA-256 av de ti sesjonssifrene i nøkkelen, så uten
-- nøkkelen finnes det ingen inngang - verken til å lese eller skrive.
--
-- Sanntid går over Broadcast på en kanal som heter rom-ID-en, ikke over
-- postgres_changes. Samme grunn: postgres_changes ville krevd SELECT på
-- tabellen, og dermed åpnet for å abonnere på alt.
--
-- Databasen ser fortsatt rom-ID, meldingstype og tidspunkt. Posisjoner,
-- kallesignal, navn og beskrivelser er kryptert klientside (AES-GCM) og kan
-- ikke leses av Supabase.
-- ---------------------------------------------------------------------------

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

-- RLS på, og bevisst INGEN policies: da slipper ingen til på tabellen direkte.
alter table public.ssbms_events enable row level security;

-- Fjern eventuelle policies fra en tidligere versjon av dette skjemaet.
drop policy if exists ssbms_read   on public.ssbms_events;
drop policy if exists ssbms_write  on public.ssbms_events;
drop policy if exists ssbms_update on public.ssbms_events;

revoke all on public.ssbms_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Lesing: krever rom-ID
-- ---------------------------------------------------------------------------

create or replace function public.ssbms_fetch(p_room text)
returns table (kind text, ref text, iv text, ct text, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select e.kind, e.ref, e.iv, e.ct, e.updated_at
  from public.ssbms_events e
  where e.room = p_room
    and p_room ~ '^[0-9a-f]{32}$'      -- rom-ID har alltid denne formen
  order by e.updated_at
  limit 2000;
$$;

-- ---------------------------------------------------------------------------
-- Skriving: krever rom-ID, og validerer formen på alt som kommer inn
-- ---------------------------------------------------------------------------

create or replace function public.ssbms_put(
  p_room text, p_kind text, p_ref text, p_iv text, p_ct text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_room !~ '^[0-9a-f]{32}$' then
    raise exception 'ugyldig rom';
  end if;
  if p_kind not in ('pos', 'poi', 'loc') then
    raise exception 'ugyldig type';
  end if;
  if length(p_ref) > 64 or length(p_iv) > 32 or length(p_ct) > 20000 then
    raise exception 'for stor nyttelast';
  end if;

  insert into public.ssbms_events (room, kind, ref, iv, ct, updated_at)
  values (p_room, p_kind, p_ref, p_iv, p_ct, now())
  on conflict (room, kind, ref) do update
    set iv = excluded.iv, ct = excluded.ct, updated_at = now();
end;
$$;

revoke all on function public.ssbms_fetch(text) from public;
revoke all on function public.ssbms_put(text, text, text, text, text) from public;
grant execute on function public.ssbms_fetch(text) to anon, authenticated;
grant execute on function public.ssbms_put(text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Oppbevaring
--
-- Data bør ikke ligge lenger enn nødvendig. Kjør manuelt etter øvelse, eller
-- sett opp som pg_cron-jobb (Database > Extensions > pg_cron).
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

-- Purge skal IKKE kunne kjøres fra klienten.
revoke all on function public.ssbms_purge(interval) from public, anon, authenticated;

-- Slett alt eldre enn 48 timer, hver time:
--   select cron.schedule('ssbms-purge', '0 * * * *', $$select public.ssbms_purge()$$);
--
-- Slett ett bestemt rom umiddelbart (kjøres i SQL Editor):
--   delete from public.ssbms_events where room = '<rom-id>';

-- ---------------------------------------------------------------------------
-- Hva dette IKKE beskytter mot
--
-- * Den som har nøkkelen har full tilgang til sitt rom. Det er designet.
-- * Sesjonsdelen er ti siffer (~33 bit). PBKDF2 gjør gjetting dyrt, men en
--   motstander med fanget chiffertekst, tid og maskinvare kommer gjennom.
-- * Trafikkmønster - når et rom er aktivt, hvor ofte, fra hvilke IP-er - er
--   synlig for Supabase uansett kryptering.
--
-- Slå på rate limiting i Supabase-dashbordet (Settings > API) i tillegg.
-- ---------------------------------------------------------------------------
