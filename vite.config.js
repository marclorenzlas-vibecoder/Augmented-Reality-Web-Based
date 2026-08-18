import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Specifically allow any localtunnel domain, or we can use an array
    allowedHosts: ['.loca.lt'],
    // Expose on all network interfaces
    host: true,
    cors: true
  }
});
