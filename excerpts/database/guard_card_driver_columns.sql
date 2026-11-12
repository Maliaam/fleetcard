-- Kierowca nie może sam ustawiać statusu „processed" ani pól należących do
-- biura (uwaga z cofnięcia, data oddania, zakres trasy).
--
-- Wcześniej:
--  * cards_update_owner miał WITH CHECK tylko (driver_id = auth.uid()) —
--    kierowca mógł zwykłym PATCH-em ustawić swojej karcie roboczej
--    status 'processed', dowolny review_comment / submitted_at / trip_*;
--  * cards_insert pozwalał od razu utworzyć kartę jako 'submitted'/'processed'
--    (z pominięciem wymogu km_end, który pilnuje tylko UPDATE).
--
-- Teraz:
--  1. RLS: kierowca tworzy wyłącznie 'draft', a aktualizacja może zostawić
--     'draft' albo zmienić go na 'submitted' (oddanie karty). Nic więcej.
--  2. Trigger: dla wszystkich poza administratorem pola biura są ustawiane
--     przez serwer, niezależnie od tego, co przyśle klient:
--       - submitted_at   = now() przy oddaniu, poza tym bez zmian,
--       - review_comment(_at) = wyczyszczone przy oddaniu, poza tym bez zmian,
--       - trip_start/trip_end = liczone z tabeli departures,
--       - created_at     = bez zmian.
--     Nadpisujemy po cichu zamiast rzucać błąd, więc obecny frontend
--     (submitCard wysyła review_comment = null i czas klienta) działa bez zmian.

-- 1. RLS ---------------------------------------------------------------

drop policy if exists cards_insert on public.cards;
create policy cards_insert on public.cards
  for insert to authenticated
  with check (driver_id = auth.uid() and status = 'draft');

drop policy if exists cards_update_owner on public.cards;
create policy cards_update_owner on public.cards
  for update to authenticated
  using (driver_id = auth.uid() and status = 'draft')
  with check (driver_id = auth.uid() and status in ('draft', 'submitted'));

-- 2. Trigger -----------------------------------------------------------

create or replace function public.guard_card_driver_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- bez JWT (SQL Editor, service_role, migracje) oraz administrator — bez ingerencji
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status            := 'draft';
    new.submitted_at      := null;
    new.review_comment    := null;
    new.review_comment_at := null;
    new.trip_start        := null; -- nowa karta nie ma jeszcze wyjazdów
    new.trip_end          := null;
    return new;
  end if;

  -- UPDATE
  new.created_at := old.created_at;

  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    -- oddanie karty: serwerowy czas oddania, uwaga z cofnięcia zamknięta
    new.submitted_at      := now();
    new.review_comment    := null;
    new.review_comment_at := null;
  else
    new.submitted_at      := old.submitted_at;
    new.review_comment    := old.review_comment;
    new.review_comment_at := old.review_comment_at;
  end if;

  -- zakres trasy zawsze z wyjazdów/zjazdów (tak samo liczy go save_card)
  new.trip_start := (select min(d.departure_date)
                       from public.departures d where d.card_id = new.id);
  new.trip_end   := (select max(d.return_date)
                       from public.departures d where d.card_id = new.id);

  return new;
end;
$$;

-- funkcja triggera nie powinna być wywoływalna przez API
revoke execute on function public.guard_card_driver_columns() from public, anon, authenticated;

drop trigger if exists cards_guard_driver_columns on public.cards;
create trigger cards_guard_driver_columns
  before insert or update on public.cards
  for each row execute function public.guard_card_driver_columns();
