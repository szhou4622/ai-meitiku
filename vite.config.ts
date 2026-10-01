import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";
import { createContactService } from "./electron/contact-service.mjs";
import { LICENSE_CONFIG } from "./electron/license-config.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

function contactPreviewApi(): Plugin {
  const contactService = createContactService({
    appName: LICENSE_CONFIG.appName,
    userDataPath: path.resolve(".wrangler", "contact-preview"),
  });

  return {
    name: "ai-media-library-contact-preview-api",
    apply: "serve" as const,
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url || "/", "http://localhost");
        if (requestUrl.pathname !== "/api/contact") {
          next();
          return;
        }
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Allow", "GET");
          response.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
          return;
        }
        const contact = await contactService.getContactConfig();
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store, max-age=0");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(JSON.stringify(contact));
      });
    },
  };
}

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      contactPreviewApi(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
