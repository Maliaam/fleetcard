-- Fragment migracji supabase/migrations/20260713120000_card_trailers.sql
-- (aktualna wersja funkcji save_card; pomocnicze funkcje audytu
--  card_audit_snapshot / jsonb_changed_fields / diff_row_maps / log_card_changes
--  są zdefiniowane w innych migracjach).

create function public.save_card(
  p_card jsonb,
  p_fuelings jsonb default '[]'::jsonb,
  p_expenses jsonb default '[]'::jsonb,
  p_departures jsonb default '[]'::jsonb,
  p_loadings jsonb default '[]'::jsonb,
  p_trailers jsonb default null
)
returns public.cards
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cid uuid := (p_card->>'id')::uuid;
  result public.cards;
  old_card jsonb;
  old_f jsonb; old_e jsonb; old_d jsonb; old_l jsonb; old_t jsonb;
  new_f jsonb; new_e jsonb; new_d jsonb; new_l jsonb; new_t jsonb;
  card_diff jsonb;
  changes jsonb;
begin
  -- migawka „przed" (RLS: kierowca czyta tylko swoją kartę)
  select public.card_audit_snapshot(c) into old_card
    from public.cards c where c.id = cid;
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into old_f from public.fuelings t where t.card_id = cid;
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into old_e from public.expenses t where t.card_id = cid;
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into old_d from public.departures t where t.card_id = cid;
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into old_l from public.loadings t where t.card_id = cid;
  -- naczepy w dzienniku jako czytelne wartości (nr rej. zamiast uuid)
  select coalesce(jsonb_object_agg(ct.id::text, jsonb_build_object(
           'position', ct.position,
           'plate', coalesce(v.plate, ct.external_plate),
           'external', ct.vehicle_id is null and ct.external_plate is not null)), '{}'::jsonb)
    into old_t
    from public.card_trailers ct
    left join public.vehicles v on v.id = ct.vehicle_id
    where ct.card_id = cid;

  update public.cards set
    period_year            = (p_card->>'period_year')::int,
    period_month           = (p_card->>'period_month')::int,
    tractor_id             = nullif(p_card->>'tractor_id','')::uuid,
    km_start               = nullif(p_card->>'km_start','')::int,
    km_end                 = nullif(p_card->>'km_end','')::int,
    inspection_tractor     = nullif(p_card->>'inspection_tractor','')::date,
    inspection_trailer     = nullif(p_card->>'inspection_trailer','')::date,
    tachograph_calibration = nullif(p_card->>'tachograph_calibration','')::date,
    reg_doc_tractor        = nullif(p_card->>'reg_doc_tractor','')::boolean,
    reg_doc_trailer        = nullif(p_card->>'reg_doc_trailer','')::boolean,
    insurance_tractor      = nullif(p_card->>'insurance_tractor','')::date,
    insurance_trailer      = nullif(p_card->>'insurance_trailer','')::date,
    equip_straps           = nullif(p_card->>'equip_straps','')::int,
    equip_buckles          = nullif(p_card->>'equip_buckles','')::int,
    equip_corners          = nullif(p_card->>'equip_corners','')::int,
    equip_mats             = nullif(p_card->>'equip_mats','')::int
  where id = cid
  returning * into result;

  if not found then
    raise exception 'Brak karty lub brak uprawnień do edycji (karta może być już oddana).';
  end if;

  -- NACZEPY
  if p_trailers is not null then
    if jsonb_array_length(p_trailers) > 4 then
      raise exception 'Karta może mieć najwyżej 4 naczepy.';
    end if;
    insert into public.card_trailers as ct
      (id, card_id, position, vehicle_id, external_plate)
    select (r->>'id')::uuid, cid, (r->>'position')::int,
           nullif(r->>'vehicle_id','')::uuid, nullif(r->>'external_plate','')
    from jsonb_array_elements(p_trailers) r
    on conflict (id) do update set
      position=excluded.position, vehicle_id=excluded.vehicle_id,
      external_plate=excluded.external_plate;
    delete from public.card_trailers where card_id = cid and id not in
      (select (r->>'id')::uuid from jsonb_array_elements(p_trailers) r);
  end if;

  -- TANKOWANIA
  insert into public.fuelings as f
    (id, card_id, position, date, "time", quantity, price, currency,
     odometer, city, country, payment, fuel_type)
  select (r->>'id')::uuid, cid, (r->>'position')::int,
         nullif(r->>'date','')::date, nullif(r->>'time','')::time,
         nullif(r->>'quantity','')::numeric,
         nullif(r->>'price','')::numeric, nullif(r->>'currency',''),
         nullif(r->>'odometer','')::int,
         nullif(r->>'city',''), nullif(r->>'country',''),
         nullif(r->>'payment',''), nullif(r->>'fuel_type','')
  from jsonb_array_elements(coalesce(p_fuelings,'[]'::jsonb)) r
  on conflict (id) do update set
    position=excluded.position, date=excluded.date, "time"=excluded."time",
    quantity=excluded.quantity, price=excluded.price, currency=excluded.currency,
    odometer=excluded.odometer, city=excluded.city,
    country=excluded.country, payment=excluded.payment, fuel_type=excluded.fuel_type;
  delete from public.fuelings where card_id = cid and id not in
    (select (r->>'id')::uuid from jsonb_array_elements(coalesce(p_fuelings,'[]'::jsonb)) r);

  -- WYDATKI INNE
  insert into public.expenses as e
    (id, card_id, position, name, price, currency, payment)
  select (r->>'id')::uuid, cid, (r->>'position')::int,
         nullif(r->>'name',''), nullif(r->>'price','')::numeric,
         nullif(r->>'currency',''), nullif(r->>'payment','')
  from jsonb_array_elements(coalesce(p_expenses,'[]'::jsonb)) r
  on conflict (id) do update set
    position=excluded.position, name=excluded.name,
    price=excluded.price, currency=excluded.currency, payment=excluded.payment;
  delete from public.expenses where card_id = cid and id not in
    (select (r->>'id')::uuid from jsonb_array_elements(coalesce(p_expenses,'[]'::jsonb)) r);

  -- WYJAZDY / ZJAZDY
  insert into public.departures as d
    (id, card_id, position, departure_date, departure_time, return_date, return_time)
  select (r->>'id')::uuid, cid, (r->>'position')::int,
         nullif(r->>'departure_date','')::date, nullif(r->>'departure_time','')::time,
         nullif(r->>'return_date','')::date, nullif(r->>'return_time','')::time
  from jsonb_array_elements(coalesce(p_departures,'[]'::jsonb)) r
  on conflict (id) do update set
    position=excluded.position, departure_date=excluded.departure_date,
    departure_time=excluded.departure_time, return_date=excluded.return_date,
    return_time=excluded.return_time;
  delete from public.departures where card_id = cid and id not in
    (select (r->>'id')::uuid from jsonb_array_elements(coalesce(p_departures,'[]'::jsonb)) r);

  -- ZAŁADUNKI / ROZŁADUNKI
  insert into public.loadings as l
    (id, card_id, position, load_date, load_km, load_time, load_country, load_city,
     unload_date, unload_time, unload_country, unload_city, unload_km)
  select (r->>'id')::uuid, cid, (r->>'position')::int,
         nullif(r->>'load_date','')::date, nullif(r->>'load_km','')::int,
         nullif(r->>'load_time','')::time, nullif(r->>'load_country',''), nullif(r->>'load_city',''),
         nullif(r->>'unload_date','')::date, nullif(r->>'unload_time','')::time,
         nullif(r->>'unload_country',''), nullif(r->>'unload_city',''), nullif(r->>'unload_km','')::int
  from jsonb_array_elements(coalesce(p_loadings,'[]'::jsonb)) r
  on conflict (id) do update set
    position=excluded.position, load_date=excluded.load_date, load_km=excluded.load_km,
    load_time=excluded.load_time, load_country=excluded.load_country, load_city=excluded.load_city,
    unload_date=excluded.unload_date, unload_time=excluded.unload_time,
    unload_country=excluded.unload_country, unload_city=excluded.unload_city, unload_km=excluded.unload_km;
  delete from public.loadings where card_id = cid and id not in
    (select (r->>'id')::uuid from jsonb_array_elements(coalesce(p_loadings,'[]'::jsonb)) r);

  -- Tytuł karty = zakres trasy (liczony z wyjazdów po ich podmianie).
  update public.cards set
    trip_start = (select min(departure_date) from public.departures where card_id = cid),
    trip_end   = (select max(return_date)    from public.departures where card_id = cid)
  where id = cid
  returning * into result;

  -- migawka „po" + diff → dziennik zdarzeń
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into new_f from public.fuelings t where t.card_id = cid;
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into new_e from public.expenses t where t.card_id = cid;
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into new_d from public.departures t where t.card_id = cid;
  select coalesce(jsonb_object_agg(t.id::text, to_jsonb(t) - 'id' - 'card_id'), '{}'::jsonb)
    into new_l from public.loadings t where t.card_id = cid;
  select coalesce(jsonb_object_agg(ct.id::text, jsonb_build_object(
           'position', ct.position,
           'plate', coalesce(v.plate, ct.external_plate),
           'external', ct.vehicle_id is null and ct.external_plate is not null)), '{}'::jsonb)
    into new_t
    from public.card_trailers ct
    left join public.vehicles v on v.id = ct.vehicle_id
    where ct.card_id = cid;

  card_diff := public.jsonb_changed_fields(old_card, public.card_audit_snapshot(result));

  -- uuid ciągnika → numer rejestracyjny (czytelny dziennik)
  if card_diff ? 'tractor_id' then
    card_diff := jsonb_set(card_diff, '{tractor_id}', jsonb_build_object(
      'old', (select to_jsonb(v.plate) from public.vehicles v
              where v.id = (old_card->>'tractor_id')::uuid),
      'new', (select to_jsonb(v.plate) from public.vehicles v
              where v.id = result.tractor_id)));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'at', now(), 'kind', 'card', 'field', d.key,
           'old', d.value->'old', 'new', d.value->'new')), '[]'::jsonb)
    into changes
    from jsonb_each(card_diff) d;

  changes := changes
    || public.diff_row_maps('card_trailers', old_t, new_t)
    || public.diff_row_maps('fuelings',   old_f, new_f)
    || public.diff_row_maps('expenses',   old_e, new_e)
    || public.diff_row_maps('departures', old_d, new_d)
    || public.diff_row_maps('loadings',   old_l, new_l);

  if jsonb_array_length(changes) > 0 then
    perform public.log_card_changes(cid, changes);
  end if;

  return result;
end;
$$;

revoke execute on function public.save_card(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from anon, public;
grant execute on function public.save_card(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;
