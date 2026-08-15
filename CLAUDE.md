# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`iobroker.hm-rega` is an ioBroker adapter that talks to the **logic layer ("ReGaHSS")** of a HomeMatic CCU. It syncs CCU system variables, programs, service messages (alarms), duty cycle, device/channel names and room/function/favorite enums into ioBroker, and can execute arbitrary CCU scripts via `sendTo`.

TypeScript (CommonJS output). Sources live in `src/`, the published/runnable code is the compiled `build/` (`package.json` `main` is `build/main.js`). `build/` is gitignored — always run the build before starting the adapter or the integration tests.

## Commands

```bash
npm run build                             # tsc -p tsconfig.build.json  -> build/
npm run watch                             # same in watch mode
npm run check                             # type check only (tsconfig.json, noEmit)
npm run lint                              # eslint (@iobroker/eslint-config, flat config)
npx eslint -c eslint.config.mjs --fix src # autofix + prettier formatting

npm run test:package                      # validates package.json / io-package.json / admin JSON (fast)
npm run test:integration                  # starts a real js-controller + adapter instance
npx mocha test/integrationAdapter --exit --grep "sendTo"   # single test
npm run release-patch                     # @alcalzone/release-script, moves README changelog into io-package news
```

`npm ci`/`npm install` runs `prepare` → `npm run build`, so a fresh checkout is buildable without an extra step. The integration test requires that **no** js-controller is running on the machine, otherwise it aborts with "JS-Controller is already running!".

## Architecture

### Layout

| Path | Content |
| --- | --- |
| `src/main.ts` | the whole adapter: one `HmRega extends utils.Adapter` class |
| `src/lib/rega.ts` | `Rega` - the HTTP transport to the CCU |
| `src/lib/types.ts` | shapes of the JSON that the `regascripts/*.fn` print |
| `src/lib/utils.ts` | `chars` (WriteURL decoding table), `FORBIDDEN_CHARS`, `nameToString` |
| `src/lib/enumNames.ts` | translations of the well-known CCU room/function names |
| `src/lib/crypto.ts` | legacy XOR credential obfuscation |
| `src/lib/adapter-config.d.ts` | augments `ioBroker.AdapterConfig` and `ioBroker.NotificationScopes` |
| `regascripts/*.fn` | ReGa scripts executed on the CCU |
| `admin/jsonConfig.json` | the configuration dialog |

`src/lib/adapter-config.d.ts` is hand-maintained and must be kept in sync with `native` in `io-package.json` **and** with `admin/jsonConfig.json` — nothing generates it.

### Transport: `src/lib/rega.ts`

A `Rega` class wrapping the CCU's HTTP interface. Two different ports are involved:

- `webinterfacePort` (80/443, overridable) — `GET /ise/checkrega.cgi` is the liveness probe.
- `homematicPort` (8181, or 48181 for HTTPS) — `POST /rega.exe` executes a script.

Details that bite:

- Requests are **strictly serialized**: `pendingRequests` acts as a queue with one request in flight; an identical script that is already pending is dropped with a warning. 90 s timeout.
- The request body is encoded **ISO-8859-1** (`iconv-lite`) — the CCU is not UTF-8.
- The response is `stdout` followed by a trailing `<xml>…</xml>` block, split at `lastIndexOf('<xml>')` and parsed with `xml2js`. A missing `<xml>` block is treated as "ReGaHSS down" and triggers reconnect.
- All connection state changes funnel through the single `options.ready(err)` callback (`RegaError` | undefined), which lands in `HmRega.onRegaReady()`. A successful ready runs the whole initial sync sequence, so it is re-entered on every reconnect.
- `destroy()` stops the reconnect timer; it is called from `onUnload`.

### CCU scripts: `regascripts/*.fn`

HomeMatic ReGa script sources that `Write(...)` JSON-ish output.

- On adapter ready, every `.fn` is compared against ioBroker **file storage** under the `hm-rega` meta object and rewritten if changed. `rega.runScriptFile(name)` then reads from file storage — **not from disk**. Editing a `.fn` therefore only takes effect after an adapter restart, and users can patch scripts in file storage without touching the npm package.
- `syncRegaScripts()` resolves the directory as `join(__dirname, '..', 'regascripts')`, i.e. relative to `build/`.
- The output is not valid JSON: newlines are stripped and `-inf`/`nan` are replaced by `null` before `JSON.parse`. Strings are written with ReGa's `WriteURL` and must be decoded with `this.unescape()` (table in `src/lib/utils.ts` + `decodeURI`).
- `dutycycle.fn` shells out to `tclsh`/`xmlrpc` and returns a TCL-ish dict, not JSON — `HmRega.convertDataToJSONArray()` parses it positionally by key name. Any change to that script must be mirrored there.
- `polling.fn` / `variables.fn` have `*Inv` twins used when `showInvSysVar` is set (hidden system variables).

### Where states are written

This adapter deliberately writes into **other adapters' namespaces**:

| Target | Source | Notes |
| --- | --- | --- |
| `hm-rega.<i>.<regaId>` | `variables.fn`, `programs.fn` | id is the numeric ReGa object id; `native.TypeName` = `VARDP`/`ALARMDP`/`PROGRAM` |
| `hm-rega.<i>.alarms` / `.maintenance` | ReGa ids 40 / 41 | aliased both ways — `onStateChange` maps the name back to 40/41 before `dom.GetObject(...)` |
| `hm-rega.<i>.<iface>.0.*` | `dutycycle.fn` + `system.fn` | DUTY_CYCLE, CONNECTED, firmware/rega version, object counters |
| `hm-rpc.<n>.<channel>.<dp>` | `datapoints.fn` | only written when the object already exists (`existingStates`), else logged and skipped |
| `hm-rpc.<n>.<channel>_ALARM` | `alarms.fn` | service messages; `_ALARM` objects are created by this adapter |
| `enum.rooms/functions/favorites` | `rooms.fn`, `functions.fn`, `favorites.fn` | one-way CCU → ioBroker, overwrites ioBroker edits |

The `_design/hm-rega` CouchDB views (`variables`, `programs`, declared in `io-package.json` `objects`) are how sync finds previously created objects to delete stale ones — object creation must keep `native.TypeName` correct or cleanup silently misses them.

### Interface → hm-rpc instance mapping

Every CCU interface name (`BidCos-RF`, `BidCos-Wired`, `CUxD`, `HmIP-RF`, `VirtualDevices`) maps to `config.rfdAdapter` / `hs485dAdapter` / `cuxdAdapter` / `hmipAdapter` / `virtualDevicesAdapter`. There are **two** resolvers and they are not interchangeable:

- `instanceOfEnabledInterface()` — honours the `<x>Enabled` flags. Used by datapoints, devices and functions.
- `instanceOfConfiguredInterface()` — only looks at whether `<x>Adapter` is set (except virtual devices, which check the flag). Rooms and favorites have always behaved that way; keeping it preserves the members of existing enums.

`buildRpcRegex()` builds `hmRpcRegex` from the enabled instances; it decides which enum members `syncEnum()` is allowed to remove.

### Polling and triggers

- `pollingTimer` — variables + programs, started at the end of `getVariables()`.
- `pollingTimerDC` — duty cycle, started at the end of `getDutyCycle()` (`pollingIntervalDC` defaults to `0` = off).
- `pollingTrigger` — an optional foreign hm-rpc state (a CCU button press) whose ack'd change forces `pollVariables()`.
- `checkInit()` periodically writes a trigger datapoint so hm-rpc notices a dead connection. It has always been called with the **rfd** instance, whichever interface enabled it.
- Writing `<hm-rpc>.updated` re-reads devices; `<hm-rpc>.info.connection` going true re-reads variables after a 60 s debounce.

Always use `this.setTimeout` / `this.setInterval` (adapter-core, auto-cleared on unload), never the globals — this is why js-controller >= 5.0.19 is required.

### Caches

`states` and `objects` are instance-level caches used to skip redundant `setForeignState`/object writes; `existingStates` and `units` are populated during `syncDevices()`/`getDatapoints()` and then **set to `null`/`[]` to free RAM** (CCUs with many devices). Code that runs later must null-check `units`.

### Admin configuration

`admin/jsonConfig.json` (`common.adminUI.config = "json"`, admin >= 6.17.14). Translations are the flat `admin/i18n/<lang>.json` files, selected by `"i18n": true`.

The two dynamic controls call back into the running instance via `sendTo`, handled in `onMessage()` **before** the legacy fallback:

- `getCcuAddresses` → distinct `native.homematicAddress` of all hm-rpc instances (`autocompleteSendTo`, free text stays possible).
- `getRpcInstances` with `{ type, ip }` → hm-rpc instances whose `native.daemon`/`native.type` matches and whose CCU address matches (`selectSendTo`, falls back to a manual input when the instance is offline).

Every other message is still executed as a ReGa script and answered with `{ result, error }` — that is the documented `sendTo('hm-rega.0', '<script>')` API, so new commands must use distinctive names.

`webinterfaceProtocol` is a hidden field whose value is derived from `useHttps` via `onChange.calculateFunc`; it only exists because `common.localLinks` interpolates it. `webinterfacePort` is snapped back to 80/443 the same way when it holds a default value.

### Misc conventions

- `FORBIDDEN_CHARS` (`src/lib/utils.ts`) is applied to every id fragment built from CCU names.
- Credentials are only decrypted when `useHttps` is set, using the XOR helper in `src/lib/crypto.ts` with `system.config.native.secret`. The admin side must stay on `"type": "password", "encrypted": true` — `io-package.json` does not use `encryptedNative`, so switching would invalidate stored credentials.
- Low battery: `LOWBAT_ALARM`/`LOW_BAT_ALARM` alarms feed `info.lowbatDevices` and `registerNotification('hm-rega', 'lowbat', …)`, which only fires for devices not already in the stored list. The scope is declared in `io-package.json` `notifications` and typed by augmenting `ioBroker.NotificationScopes`.
- `main.ts` exports a factory when required (compact mode) and self-starts when run directly.
- `getPrograms()` writes `native.PrgInfo` from `data[dp].DPInfo` although `programs.fn` emits `PrgInfo`. That mismatch is intentional (kept from the JS version) so existing objects do not change.

## Release flow

Changelog lives in `README.md` under the `### **WORK IN PROGRESS**` placeholder comment; `release-script` (config in `.releaseconfig.json`) moves it into `io-package.json` `common.news`. CI (`.github/workflows/test-and-release.yml`) lints, type-checks, builds and runs `test:package`, then `test:integration` on Node 18/20/22 × Linux/Windows/macOS, and publishes to npm on tagged auto-merged PRs.
