import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://benchoi.me",
  redirects: {
    "/510k": "https://510klineage.org",
  },
});
