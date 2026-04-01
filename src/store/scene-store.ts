import { create } from 'zustand'
import type { EntityId, Luminaire, Room, Table } from '@/types/scene'

type SceneState = {
  room: Room | null
  tables: Table[]
  luminaires: Luminaire[]
  selectedEntityId: EntityId | null
  setRoom: (room: Room | null) => void
  setTables: (tables: Table[]) => void
  setLuminaires: (luminaires: Luminaire[]) => void
  updateRoom: (patch: Partial<Omit<Room, 'id'>>) => void
  clearRoom: () => void
  addTable: (table: Table) => void
  updateTable: (tableId: EntityId, patch: Partial<Omit<Table, 'id'>>) => void
  removeTable: (tableId: EntityId) => void
  addLuminaire: (luminaire: Luminaire) => void
  updateLuminaire: (
    luminaireId: EntityId,
    patch: Partial<Omit<Luminaire, 'id'>>,
  ) => void
  removeLuminaire: (luminaireId: EntityId) => void
  selectEntity: (entityId: EntityId | null) => void
  resetScene: () => void
}

const initialScene = {
  room: null,
  tables: [],
  luminaires: [],
  selectedEntityId: null,
}

export const useSceneStore = create<SceneState>((set) => ({
  ...initialScene,
  setRoom: (room) => set({ room }),
  setTables: (tables) => set({ tables }),
  setLuminaires: (luminaires) => set({ luminaires }),
  updateRoom: (patch) =>
    set((state) => {
      if (!state.room) return state

      return {
        room: {
          ...state.room,
          ...patch,
        },
      }
    }),
  clearRoom: () =>
    set((state) => ({
      room: null,
      selectedEntityId:
        state.selectedEntityId === state.room?.id ? null : state.selectedEntityId,
    })),
  addTable: (table) =>
    set((state) => ({
      tables: [...state.tables, table],
    })),
  updateTable: (tableId, patch) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === tableId
          ? {
              ...table,
              ...patch,
            }
          : table,
      ),
    })),
  removeTable: (tableId) =>
    set((state) => ({
      tables: state.tables.filter((table) => table.id !== tableId),
      selectedEntityId:
        state.selectedEntityId === tableId ? null : state.selectedEntityId,
    })),
  addLuminaire: (luminaire) =>
    set((state) => ({
      luminaires: [...state.luminaires, luminaire],
    })),
  updateLuminaire: (luminaireId, patch) =>
    set((state) => ({
      luminaires: state.luminaires.map((luminaire) =>
        luminaire.id === luminaireId
          ? {
              ...luminaire,
              ...patch,
            }
          : luminaire,
      ),
    })),
  removeLuminaire: (luminaireId) =>
    set((state) => ({
      luminaires: state.luminaires.filter((luminaire) => luminaire.id !== luminaireId),
      selectedEntityId:
        state.selectedEntityId === luminaireId ? null : state.selectedEntityId,
    })),
  selectEntity: (entityId) => set({ selectedEntityId: entityId }),
  resetScene: () => set(initialScene),
}))
