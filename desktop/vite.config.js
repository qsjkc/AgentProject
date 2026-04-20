import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

import { normalizeApiBaseUrl } from './src/shared/api-base-url.js'

function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {}
  }

  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((result, line) => {
      const trimmedLine = line.trim()
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        return result
      }

      const separatorIndex = trimmedLine.indexOf('=')
      if (separatorIndex <= 0) {
        return result
      }

      const key = trimmedLine.slice(0, separatorIndex).trim()
      const value = trimmedLine.slice(separatorIndex + 1).trim()
      result[key] = value.replace(/^['"]|['"]$/g, '')
      return result
    }, {})
}

export default defineConfig(({ mode }) => {
  const projectRoot = resolve(__dirname, '..')
  const rootEnv = loadEnv(mode, projectRoot, '')
  const backendEnv = readEnvFile(resolve(projectRoot, 'backend', '.env'))

  const defaultApiBaseUrl = normalizeApiBaseUrl(
    rootEnv.VITE_API_BASE_URL ||
      rootEnv.DETACHYM_API_BASE_URL ||
      rootEnv.WEB_APP_URL ||
      backendEnv.WEB_APP_URL
  )

  return {
    plugins: [react()],
    base: './',
    define: {
      __DETACHYM_DEFAULT_API_BASE_URL__: JSON.stringify(defaultApiBaseUrl),
    },
    server: {
      port: 5174,
      strictPort: true,
      fs: {
        allow: [projectRoot],
      },
    },
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          pet: resolve(__dirname, 'pet.html'),
          quickChat: resolve(__dirname, 'quick-chat.html'),
          mainPanel: resolve(__dirname, 'main-panel.html'),
        },
      },
    },
  }
})
