import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [
    basicSsl()
  ],
  server: {
    // Specifically allow any localtunnel domain, or we can use an array
    allowedHosts: ['.loca.lt'],
    // Expose on all network interfaces
    host: true,
    cors: true
  }
});
