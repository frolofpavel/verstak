import { create } from 'zustand'
import type { FileNode } from '../types/api'

interface ProjectState {
  path: string | null
  tree: FileNode[]
  setProject: (path: string) => Promise<void>
}

export const useProject = create<ProjectState>((set) => ({
  path: null,
  tree: [],
  setProject: async (path: string) => {
    const tree = await window.api.files.tree(path)
    set({ path, tree })
  }
}))
