import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://sudharsan454yahoo.github.io/tpf-job-tracker-app/
export default defineConfig({
  base: "/tpf-job-tracker-app/",
  plugins: [react()],
  server: { port: 5173 },
});
