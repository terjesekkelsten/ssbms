-- SSBMS - hev taket for chiffertekst slik at bilder kan bli brukbare
--
-- Kjør denne i Supabase > SQL Editor FØR du hever photos.maxCipherChars i
-- js/config.js og deployer. Migreringen er rent utvidende: den gamle klienten
-- fortsetter å virke mot det nye skjemaet, så rekkefølgen er trygg den veien.
-- Motsatt vei blir bildene avvist av serveren.
--
-- HVORFOR 150 000
--   20 000 tegn chiffertekst gir ca. 11 kB bilde, altså rundt 320 px. Nok til
--   å se at det står et kjøretøy der, ikke til å se hva slags.
--   150 000 gir ca. 80 kB, altså rundt 800 px.
--   Taket er ikke databasen, men Supabase Realtime: en kringkastet melding
--   kan være inntil 256 kB. 150 000 tegn pluss JSON-rammen ligger trygt under.
--   Går du høyere, slutter bildene å nå fram til dem som er tilkoblet nå -
--   raden lagres, men kringkastingen feiler, og de andre ser den først ved
--   neste innlasting.
--
-- LAGRINGSPLASS
--   Supabase gratisnivå gir 500 MB. 80 kB per bilde = ca. 6 000 bilder.
--   ssbms_purge rydder uansett bort alt eldre enn 48 timer.

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
  if length(p_ref) > 64 or length(p_iv) > 32 or length(p_ct) > 150000 then
    raise exception 'for stor nyttelast';
  end if;

  insert into public.ssbms_events (room, kind, ref, iv, ct, updated_at)
  values (p_room, p_kind, p_ref, p_iv, p_ct, now())
  on conflict (room, kind, ref) do update
    set iv = excluded.iv, ct = excluded.ct, updated_at = now();
end;
$$;

-- Grants overlever create or replace, men gjentas her for sikkerhets skyld.
revoke all on function public.ssbms_put(text, text, text, text, text) from public;
grant execute on function public.ssbms_put(text, text, text, text, text) to anon, authenticated;

-- Etterpå: sett photos.maxCipherChars = 150000 i js/config.js, commit og push.
