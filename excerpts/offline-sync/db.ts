import Dexie, { type Table } from 'dexie'
import type { CardDraft } from './types'

// Bufor offline: ostatni stan każdej edytowanej karty + flaga "dirty"
// (czeka na zapis do Supabase). Kolejka retry = wpisy z dirty = 1.
export interface StoredDraft {
  id: string // card id
  draft: CardDraft
  dirty: number // 1 = niezsynchronizowane, 0 = zapisane na serwerze
  updatedAt: number
}

class AppDB extends Dexie {
  drafts!: Table<StoredDraft, string>

  constructor() {
    super('karta-kierowcy')
    this.version(1).stores({
      drafts: 'id, dirty, updatedAt',
    })
  }
}

export const db = new AppDB()
