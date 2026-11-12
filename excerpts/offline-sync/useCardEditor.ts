import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchCard,
  flushDraft,
  flushPending,
  isAuthError,
  isCardLockedError,
  loadLocalDraft,
  markSynced,
  newDeparture,
  newExpense,
  newFueling,
  newLoading,
  newTrailer,
  saveLocalDraft,
  serverToDraft,
  submitCard,
} from '../sync/cardSync'
import type {
  CardDraft,
  CardFields,
  ChildKey,
  SaveState,
  TrailerRow,
} from '../sync/types'

export const MAX_TRAILERS = 4

const DEBOUNCE_MS = 800

type AnyRow = { id: string; position: number } & Record<string, string | number>

const rowFactory: Record<ChildKey, (position: number) => AnyRow> = {
  fuelings: (p) => newFueling(p) as unknown as AnyRow,
  expenses: (p) => newExpense(p) as unknown as AnyRow,
  departures: (p) => newDeparture(p) as unknown as AnyRow,
  loadings: (p) => newLoading(p) as unknown as AnyRow,
}

const reindex = (rows: AnyRow[]): AnyRow[] =>
  rows.map((r, i) => ({ ...r, position: i }))

function mutateRows(
  d: CardDraft,
  key: ChildKey,
  fn: (rows: AnyRow[]) => AnyRow[],
): CardDraft {
  const rows = d[key] as unknown as AnyRow[]
  return { ...d, [key]: fn(rows) } as unknown as CardDraft
}

export function useCardEditor(cardId: string) {
  const [draft, setDraft] = useState<CardDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [readonly, setReadonly] = useState(false)
  const [status, setStatus] = useState<string>('draft')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [kmTotal, setKmTotal] = useState<number | null>(null)
  // uwaga administratora po cofnięciu karty do szkicu (tylko z serwera)
  const [reviewComment, setReviewComment] = useState<string | null>(null)

  const draftRef = useRef<CardDraft | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doFlush = useCallback(
    async (d: CardDraft) => {
      setSaveState('saving')
      try {
        // updatedAt szkicu sprzed zapisu — markSynced zdejmie flagę dirty
        // tylko jeśli w trakcie zapisu nie doszły nowsze zmiany
        const local = await loadLocalDraft(cardId)
        const card = await flushDraft(d)
        await markSynced(cardId, local?.updatedAt)
        setKmTotal(card.km_total)
        setSaveState('saved')
      } catch (e) {
        if (isAuthError(e)) {
          // Sesja wygasła — retry bez zalogowania nie ma sensu. Szkic zostaje
          // dirty w buforze i wejdzie po ponownym zalogowaniu.
          setSaveState('auth')
          return
        }
        if (isCardLockedError(e)) {
          // Karta przestała być edytowalna w trakcie edycji (np. oddana lub
          // usunięta z panelu). Ponawianie nie ma sensu — przeładuj stan
          // z serwera i zablokuj formularz; lokalne zmiany nie mogą już wejść.
          if (timer.current) clearTimeout(timer.current)
          try {
            const server = await fetchCard(cardId)
            const next = serverToDraft(server)
            draftRef.current = next
            setDraft(next)
            setReadonly(server.card.status !== 'draft')
            setStatus(server.card.status)
            setKmTotal(server.card.km_total)
            setReviewComment(server.card.review_comment)
            await saveLocalDraft(cardId, next, false)
            setSaveState('locked')
          } catch {
            setSaveState('error')
          }
          return
        }
        setSaveState(navigator.onLine ? 'error' : 'offline')
      }
    },
    [cardId],
  )

  const scheduleFlush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (draftRef.current) void doFlush(draftRef.current)
    }, DEBOUNCE_MS)
  }, [doFlush])

  // Wczytanie karty: serwer (źródło prawdy) z fallbackiem na bufor offline.
  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const server = await fetchCard(cardId)
        if (!active) return
        const ro = server.card.status !== 'draft'
        setReadonly(ro)
        setStatus(server.card.status)
        setKmTotal(server.card.km_total)
        setReviewComment(server.card.review_comment)

        const local = await loadLocalDraft(cardId)
        if (local && local.dirty === 1 && !ro) {
          // niezapisane lokalne zmiany — użyj ich i dograj na serwer
          draftRef.current = local.draft
          setDraft(local.draft)
          void doFlush(local.draft)
        } else {
          const d = serverToDraft(server)
          draftRef.current = d
          setDraft(d)
          await saveLocalDraft(cardId, d, false)
          setSaveState('saved')
        }
      } catch {
        // brak sieci — spróbuj z bufora offline
        const local = await loadLocalDraft(cardId)
        if (active && local) {
          draftRef.current = local.draft
          setDraft(local.draft)
          setSaveState('offline')
        } else if (active) {
          setLoadError('Nie udało się wczytać karty (brak połączenia).')
        }
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [cardId, doFlush])

  // Po powrocie sieci: opróżnij kolejkę retry.
  useEffect(() => {
    const onOnline = () => {
      void flushPending()
      if (draftRef.current && !readonly) void doFlush(draftRef.current)
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [doFlush, readonly])

  // Każda zmiana: aktualizacja stanu + natychmiastowy autozapis do IndexedDB
  // + debounce do Supabase.
  const apply = useCallback(
    (next: CardDraft) => {
      draftRef.current = next
      setDraft(next)
      setSaveState('saving')
      void saveLocalDraft(cardId, next, true)
      scheduleFlush()
    },
    [cardId, scheduleFlush],
  )

  const setCardField = useCallback(
    (field: keyof CardFields, value: string) => {
      if (!draftRef.current || readonly) return
      apply({
        ...draftRef.current,
        card: { ...draftRef.current.card, [field]: value },
      })
    },
    [apply, readonly],
  )

  // — naczepy (lista w nagłówku, poza mechanizmem ChildKey/bottom-sheet) —
  const addTrailer = useCallback(() => {
    if (!draftRef.current || readonly) return
    const rows = draftRef.current.trailers
    if (rows.length >= MAX_TRAILERS) return
    apply({
      ...draftRef.current,
      trailers: [...rows, newTrailer(rows.length)],
    })
  }, [apply, readonly])

  const patchTrailer = useCallback(
    (id: string, patch: Partial<TrailerRow>) => {
      if (!draftRef.current || readonly) return
      apply({
        ...draftRef.current,
        trailers: draftRef.current.trailers.map((r) =>
          r.id === id ? { ...r, ...patch } : r,
        ),
      })
    },
    [apply, readonly],
  )

  const removeTrailer = useCallback(
    (id: string) => {
      if (!draftRef.current || readonly) return
      apply({
        ...draftRef.current,
        trailers: draftRef.current.trailers
          .filter((r) => r.id !== id)
          .map((r, i) => ({ ...r, position: i })),
      })
    },
    [apply, readonly],
  )

  const addRow = useCallback(
    (key: ChildKey) => {
      if (!draftRef.current || readonly) return
      apply(
        mutateRows(draftRef.current, key, (rows) => [
          ...rows,
          rowFactory[key](rows.length),
        ]),
      )
    },
    [apply, readonly],
  )

  // Upsert całego wiersza (z bottom-sheet): podmiana po id lub dołączenie.
  const saveRow = useCallback(
    (key: ChildKey, row: AnyRow) => {
      if (!draftRef.current || readonly) return
      apply(
        mutateRows(draftRef.current, key, (rows) => {
          const exists = rows.some((r) => r.id === row.id)
          const next = exists
            ? rows.map((r) => (r.id === row.id ? row : r))
            : [...rows, row]
          return reindex(next)
        }),
      )
    },
    [apply, readonly],
  )

  const removeRow = useCallback(
    (key: ChildKey, id: string) => {
      if (!draftRef.current || readonly) return
      apply(
        mutateRows(draftRef.current, key, (rows) =>
          reindex(rows.filter((r) => r.id !== id)),
        ),
      )
    },
    [apply, readonly],
  )

  const patchRow = useCallback(
    (key: ChildKey, id: string, patch: Record<string, string>) => {
      if (!draftRef.current || readonly) return
      apply(
        mutateRows(draftRef.current, key, (rows) =>
          rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        ),
      )
    },
    [apply, readonly],
  )

  const retry = useCallback(() => {
    if (draftRef.current && !readonly) void doFlush(draftRef.current)
  }, [doFlush, readonly])

  // Oddanie karty: dograj ostatnie zmiany, potem draft → submitted.
  // Rzuca wyjątkiem przy braku sieci / błędzie — UI pokazuje komunikat.
  const submit = useCallback(async () => {
    const d = draftRef.current
    if (!d || readonly) return
    if (timer.current) clearTimeout(timer.current)
    setSaveState('saving')
    try {
      const local = await loadLocalDraft(cardId)
      const card = await flushDraft(d)
      await markSynced(cardId, local?.updatedAt)
      setKmTotal(card.km_total)
      const updated = await submitCard(cardId)
      setKmTotal(updated.km_total)
      setStatus(updated.status)
      setReadonly(true)
      setReviewComment(null)
      setSaveState('saved')
    } catch (e) {
      setSaveState(
        isAuthError(e) ? 'auth' : navigator.onLine ? 'error' : 'offline',
      )
      throw e
    }
  }, [cardId, readonly])

  return {
    draft,
    loading,
    loadError,
    readonly,
    status,
    saveState,
    kmTotal,
    reviewComment,
    setCardField,
    addTrailer,
    patchTrailer,
    removeTrailer,
    addRow,
    saveRow,
    removeRow,
    patchRow,
    retry,
    submit,
  }
}

export type CardEditor = ReturnType<typeof useCardEditor>

