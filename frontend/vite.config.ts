import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig(({mode})=>{const target=loadEnv(mode,'.','').API_PROXY_TARGET||'http://localhost:8080';return {plugins:[react()],server:{proxy:{'/api':{target,changeOrigin:false},'/health':{target,changeOrigin:false}}}}})
