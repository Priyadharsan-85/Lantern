import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/auth': 'http://127.0.0.1:3000',
      '/order': 'http://127.0.0.1:3000',
      '/products': 'http://127.0.0.1:3000',
      '/projects': 'http://127.0.0.1:3000',
      '/spans': 'http://127.0.0.1:3000',
      '/traces': 'http://127.0.0.1:3000',
    },
  },
})
