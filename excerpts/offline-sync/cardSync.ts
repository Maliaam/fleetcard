import { supabase } from '../lib/supabase'
import type {
  Card,
  CardTrailer,
  Fueling,
  Expense,
  Departure,
  Loading,
} from '../types/models'
import type { Json } from '../types/database'
import { db } from './db'
import type {
  CardDraft,
  DepartureRow,
  ExpenseRow,
  FuelingRow,
  LoadingRow,
  TrailerRow,
} from './types'

// — helpery konwersji —
const s = (v: string | number | boolean | null | undefined): string =>
  v === null || v === undefined ? '' : String(v)

export function newId(): string {
  return crypto.randomUUID()
}

// — budowanie pustych wierszy —
export const newTrailer = (position: number): TrailerRow => ({
  id: newId(),
  position,
  vehicle_id: '',
  external_plate: '',
})

export const newFueling = (position: number): FuelingRow => ({
  id: newId(),
  position,
  date: '',
  time: '',
  quantity: '',
  price: '',
  currency: 'PLN',
  odometer: '',
  city: '',
  country: '',
  payment: '',
  fuel_type: 'ON',
})

export const newExpense = (position: number): ExpenseRow => ({
  id: newId(),
  position,
  name: '',
  price: '',
  currency: 'EUR',
  payment: 'UTA',
})

export const newDeparture = (position: number): DepartureRow => ({
  id: newId(),
  position,
  departure_date: '',
  departure_time: '',
  return_date: '',
  return_time: '',
})

export const newLoading = (position: number): LoadingRow => ({
  id: newId(),
  position,
  load_date: '',
  load_km: '',
  load_time: '',
  load_country: '',
  load_city: '',
  unload_date: '',
  unload_time: '',
  unload_country: '',
  unload_city: '',
  unload_km: '',
})

// — serwer → szkic (string everywhere) —
export interface ServerCardData {
  card: Card
  trailers: CardTrailer[]
  fuelings: Fueling[]
  expenses: Expense[]
  departures: Departure[]
  loadings: Loading[]
}

export function serverToDraft(data: ServerCardData): CardDraft {
  const c = data.card
  return {
    card: {
      id: c.id,
      period_year: s(c.period_year),
      period_month: s(c.period_month),
      tractor_id: s(c.tractor_id),
      km_start: s(c.km_start),
      km_end: s(c.km_end),
      inspection_tractor: s(c.inspection_tractor),
      inspection_trailer: s(c.inspection_trailer),
      tachograph_calibration: s(c.tachograph_calibration),
      reg_doc_tractor: c.reg_doc_tractor === null ? '' : String(c.reg_doc_tractor),
      reg_doc_trailer: c.reg_doc_trailer === null ? '' : String(c.reg_doc_trailer),
      insurance_tractor: s(c.insurance_tractor),
      insurance_trailer: s(c.insurance_trailer),
      equip_straps: s(c.equip_straps),
      equip_buckles: s(c.equip_buckles),
      equip_corners: s(c.equip_corners),
      equip_mats: s(c.equip_mats),
    },
    trailers: data.trailers.map((r, i) => ({
      id: r.id,
      position: r.position ?? i,
      vehicle_id: s(r.vehicle_id),
      external_plate: s(r.external_plate),
    })),
    fuelings: data.fuelings.map((r, i) => ({
      id: r.id,
      position: r.position ?? i,
      date: s(r.date),
      time: s(r.time),
      quantity: s(r.quantity),
      price: s(r.price),
      currency: s(r.currency) || 'EUR', // starsze wiersze bez waluty = EUR
      odometer: s(r.odometer),
      city: s(r.city),
      country: s(r.country),
      payment: s(r.payment),
      fuel_type: s(r.fuel_type),
    })),
    expenses: data.expenses.map((r, i) => ({
      id: r.id,
      position: r.position ?? i,
      name: s(r.name),
      price: s(r.price),
      currency: s(r.currency) || 'EUR', // starsze wiersze bez waluty = EUR
      payment: s(r.payment),
    })),
    departures: data.departures.map((r, i) => ({
      id: r.id,
      position: r.position ?? i,
      departure_date: s(r.departure_date),
      departure_time: s(r.departure_time),
      return_date: s(r.return_date),
      return_time: s(r.return_time),
    })),
    loadings: data.loadings.map((r, i) => ({
      id: r.id,
      position: r.position ?? i,
      load_date: s(r.load_date),
      load_km: s(r.load_km),
      load_time: s(r.load_time),
      load_country: s(r.load_country),
      load_city: s(r.load_city),
      unload_date: s(r.unload_date),
      unload_time: s(r.unload_time),
      unload_country: s(r.unload_country),
      unload_city: s(r.unload_city),
      unload_km: s(r.unload_km),
    })),
  }
}

// — pobranie karty z wierszami z Supabase —
export async function fetchCard(cardId: string): Promise<ServerCardData> {
  const [card, trailers, fuelings, expenses, departures, loadings] =
    await Promise.all([
      supabase.from('cards').select('*').eq('id', cardId).single(),
      supabase.from('card_trailers').select('*').eq('card_id', cardId).order('position'),
      supabase.from('fuelings').select('*').eq('card_id', cardId).order('position'),
      supabase.from('expenses').select('*').eq('card_id', cardId).order('position'),
      supabase.from('departures').select('*').eq('card_id', cardId).order('position'),
      supabase.from('loadings').select('*').eq('card_id', cardId).order('position'),
    ])
  if (card.error) throw card.error
  // Błąd któregokolwiek zapytania podrzędnego = błąd całości. Bez tego szkic
  // powstałby z pustymi wierszami, a kolejny zapis skasowałby je na serwerze.
  if (trailers.error) throw trailers.error
  if (fuelings.error) throw fuelings.error
  if (expenses.error) throw expenses.error
  if (departures.error) throw departures.error
  if (loadings.error) throw loadings.error
  return {
    card: card.data,
    trailers: trailers.data ?? [],
    fuelings: fuelings.data ?? [],
    expenses: expenses.data ?? [],
    departures: departures.data ?? [],
    loadings: loadings.data ?? [],
  }
}

// — bufor offline (IndexedDB) —
// Szkic zapisany przed aktualizacją „naczepy" nie ma pola trailers — dorabiamy
// pustą listę, żeby UI i zapis (p_trailers) dostały spójny kształt.
function normalizeDraft(draft: CardDraft): CardDraft {
  const d = draft as CardDraft & { card: { trailer_id?: string } }
  if (!Array.isArray(d.trailers)) {
    // stara pojedyncza naczepa (trailer_id) → pierwszy wiersz listy
    d.trailers = d.card.trailer_id
      ? [{ ...newTrailer(0), vehicle_id: d.card.trailer_id }]
      : []
    delete d.card.trailer_id
  }
  return d
}

export async function loadLocalDraft(cardId: string) {
  const row = await db.drafts.get(cardId)
  if (row) row.draft = normalizeDraft(row.draft)
  return row
}

export async function saveLocalDraft(
  cardId: string,
  draft: CardDraft,
  dirty: boolean,
) {
  await db.drafts.put({
    id: cardId,
    draft,
    dirty: dirty ? 1 : 0,
    updatedAt: Date.now(),
  })
}

// Oznacz szkic jako zsynchronizowany. `flushedAt` = updatedAt szkicu, który
// faktycznie poszedł na serwer — jeśli kierowca w trakcie zapisu zdążył coś
// zmienić (nowszy updatedAt), NIE czyścimy flagi, bo te zmiany nie są jeszcze
// na serwerze. Bez tego zabicie aplikacji w oknie debounce gubiłoby edycje.
// Bez `flushedAt` czyścimy bezwarunkowo (świadome zdjęcie z kolejki).
export async function markSynced(cardId: string, flushedAt?: number) {
  await db.drafts
    .where('id')
    .equals(cardId)
    .modify((row) => {
      if (flushedAt === undefined || row.updatedAt === flushedAt) row.dirty = 0
    })
}

// — klasyfikacja błędów zapisu —
// PostgREST przekazuje SQLSTATE w polu `code`; błędy sieci go nie mają.
const errCode = (e: unknown): string =>
  typeof (e as { code?: unknown })?.code === 'string'
    ? ((e as { code: string }).code)
    : ''

// Problem z sesją, nie z kartą: wygasły/nieodświeżalny JWT (PGRST301, 401,
// AuthError z supabase-js) albo zapytanie bez sesji — wtedy leci jako anon,
// a save_card ma revoke dla anon → 42501. Retry pomoże dopiero po zalogowaniu.
export function isAuthError(e: unknown): boolean {
  const c = errCode(e)
  if (c === 'PGRST301' || c === 'PGRST302' || c === '42501') return true
  const o = e as { status?: unknown; __isAuthError?: unknown } | null
  return o?.status === 401 || o?.__isAuthError === true
}

// Karta nie jest już edytowalna (oddana / cofnięta / usunięta) — save_card
// zgłasza P0001. Lokalne zmiany nie mogą już wejść.
export function isCardLockedError(e: unknown): boolean {
  return errCode(e) === 'P0001'
}

// Serwer odrzucił zapis (błąd danych/ograniczeń) — ponowienie identycznego
// payloadu nie może się udać. To NIE jest problem z siecią.
export function isPermanentSaveError(e: unknown): boolean {
  const c = errCode(e)
  return isCardLockedError(e) || c.startsWith('22') || c.startsWith('23')
}

// — zapis karty do Supabase (atomowy RPC) —
export async function flushDraft(draft: CardDraft): Promise<Card> {
  const { data, error } = await supabase.rpc('save_card', {
    p_card: draft.card as unknown as Json,
    p_fuelings: draft.fuelings as unknown as Json,
    p_expenses: draft.expenses as unknown as Json,
    p_departures: draft.departures as unknown as Json,
    p_loadings: draft.loadings as unknown as Json,
    p_trailers: draft.trailers as unknown as Json,
  })
  if (error) throw error
  return data as Card
}

// — oddanie karty: draft → submitted (RLS pilnuje własności i statusu draft) —
// Ponowne oddanie zamyka też uwagę administratora z poprzedniego cofnięcia.
export async function submitCard(cardId: string): Promise<Card> {
  const { data, error } = await supabase
    .from('cards')
    .update({
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      review_comment: null,
      review_comment_at: null,
    })
    .eq('id', cardId)
    .select()
    .single()
  if (error) throw error
  return data as Card
}

// — opróżnienie kolejki retry (wszystkie niezsynchronizowane szkice) —
// Szkic odrzucony trwale przez serwer nie może blokować kolejki innych kart.
export async function flushPending(): Promise<void> {
  const pending = await db.drafts.where('dirty').equals(1).toArray()
  for (const row of pending) {
    try {
      await flushDraft(normalizeDraft(row.draft))
      await markSynced(row.id, row.updatedAt)
    } catch (e) {
      if (isAuthError(e)) {
        // sesja wygasła — szkice zostają w kolejce, wejdą po zalogowaniu
        return
      }
      if (isCardLockedError(e)) {
        // karta w międzyczasie oddana/usunięta — zmian nie da się już
        // zastosować; zdejmij z kolejki
        await markSynced(row.id)
        continue
      }
      if (isPermanentSaveError(e)) {
        // odrzucone przez serwer (błąd danych) — zostaw szkic (dane kierowcy
        // do poprawy przy otwarciu karty), ale nie zatrzymuj kolejki
        continue
      }
      // brak sieci / serwer niedostępny — przerwij, ponowimy po powrocie online
      return
    }
  }
}
