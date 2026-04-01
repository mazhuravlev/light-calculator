import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const basePath = process.env.VITE_BASE_PATH ?? (repositoryName ? `/${repositoryName}/` : '/')

// https://vite.dev/config/
export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
