# AI 媒体库（AI Media Library）

AI 媒体库的桌面端与 Web 前端源码。项目使用
[vinext](https://github.com/cloudflare/vinext)、Electron 和本地媒体处理组件，
当前应用版本为 `1.1.17`。

> 大型分类器、下载器、模型、FFmpeg 运行时和安装包不进入 Git。
> 需要打包时请先按 [BUNDLED.md](BUNDLED.md) 恢复并核验对应运行时。

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the client and run the desktop integration tests
- `npm run db:generate`: generate Drizzle migrations after schema changes

## macOS desktop installers

The desktop build selects its bundled classifier engine from
`bundled-classifier/bin/darwin-${arch}` at runtime. Keep both `darwin-arm64`
and `darwin-x64` resources when producing the Universal installer.
Architecture-specific FFmpeg binaries are bundled from `bundled-tools` for
local video processing.

- `npm run desktop:dmg:arm64`: signed and notarized Apple Silicon DMG
- `npm run desktop:dmg:x64`: signed and notarized Intel DMG
- `npm run desktop:dmg:universal`: signed and notarized Universal DMG
- `npm run desktop:dmg:all`: build, sign, notarize, staple, and Gatekeeper-check
  all three installers
- `npm run desktop:dmg:check`: verify the certificate, Apple trust chain, and
  notarization credentials without building an installer

The release script reads the Developer ID certificate from
`$HOME/Downloads/苹果证书.zip` by default and uses the macOS Keychain profile
`AI媒体库公证`. Override these without editing source by setting
`APPLE_CERT_ZIP` or `APPLE_NOTARY_PROFILE`. Credentials and P12 passwords are
never written to the repository. Verified public installers are copied only to
`release/notarized`; a failed notarization never reaches that directory.

Explicit `desktop:dmg:*:unsigned` scripts remain available for internal tests.

Release installers should be signed with a Developer ID Application identity,
submitted to Apple notarization, and stapled before public distribution.

## Online license

The desktop client uses the fixed application identity `ai-media-library`
(`AI媒体库`) and license protocol v2 against
`https://license.dadaozixun.com/api/license`.

- Startup is blocked until `/device/status` confirms an active time license.
- Activation uses `/activate`; device unbinding uses `/device/unbind`.
- Only server-provided license type, duration, activation time, expiration time,
  remaining days, and transfer count are displayed. The client never calculates
  or extends an expiration date.
- Full activation codes are never persisted. Device session and credential data
  are encrypted through Electron `safeStorage`, which uses macOS Keychain and
  Windows DPAPI, and are never exposed to the renderer.
- A stable one-way machine-code digest is derived from the operating-system
  machine identifier. The raw identifier, username, hostname, and local paths
  are not sent to the license service.
- Media, classifier, voice, filesystem, and local dynamic HTTP routes are also
  protected in the Electron main process, rather than relying only on visible
  page state.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
