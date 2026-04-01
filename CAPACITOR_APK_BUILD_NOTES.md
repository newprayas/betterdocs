# Capacitor APK Build Notes

## Problem

The APK build was failing because Capacitor expects a static web export in `out/`, but this app still contains Next.js server-only code:

- `src/app/api/groq/route.ts`
- `src/app/api/embed/route.ts`
- `src/middleware.ts`

When `CAPACITOR_BUILD=true npm run build` was run, Next.js tried to include those server-only files in the export and failed. The main error was that `dynamic = "force-dynamic"` route handlers cannot be used with `output: 'export'`.

## Root Cause

Capacitor Android is using:

- `webDir: 'out'` in `capacitor.config.ts`
- static export mode in `next.config.js` when `CAPACITOR_BUILD=true`

That means the mobile build must be fully static. Local Next.js API routes and middleware are not compatible with that build path.

## Fix Implemented

### 1. Dedicated Capacitor build script

Added:

- `scripts/build-capacitor.mjs`

What it does:

- temporarily moves `src/app/api` out of the app tree
- temporarily moves `src/middleware.ts` out of the app tree
- runs `CAPACITOR_BUILD=true npm run build`
- runs `npx cap sync android`
- restores the moved files afterward
- cleans `.next/types` so normal TypeScript checks do not break afterward

### 2. Native Groq fallback for APK builds

Updated:

- `src/services/groq/groqService.ts`

What changed:

- on native Capacitor builds, Groq requests no longer depend on `/api/groq`
- the app can call Groq directly from the native WebView
- public Groq keys are loaded only for the Capacitor build path

This was needed because the APK cannot use local Next.js API routes once the app is exported statically.

### 3. Capacitor build env updates

Updated:

- `next.config.js`

What changed:

- Capacitor builds now expose:
  - `NEXT_PUBLIC_GROQ_API_1` through `NEXT_PUBLIC_GROQ_API_7`
  - existing Voyage embedding env values

### 4. Package scripts added

Updated:

- `package.json`

Scripts:

- `npm run build:capacitor`
- `npm run apk:debug`

## Build Steps That Worked

### Web export and Capacitor sync

```bash
node scripts/build-capacitor.mjs
```

### Debug APK build

Use Java 21:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
GRADLE_USER_HOME=/Users/pustak/Documents/VS\ code\ projects/rag-web/.gradle-local \
./gradlew assembleDebug
```

Run that from:

```bash
android/
```

## Other Build Issues We Hit

### 1. Java 17 was not enough

Gradle failed with:

```text
error: invalid source release: 21
```

Fix:

- use Java 21, not Java 17

### 2. Sandbox blocked Gradle cache and network

Gradle initially failed because:

- it could not write to the default `~/.gradle` lock path
- it could not download the Gradle distribution inside the sandbox

Fix:

- set `GRADLE_USER_HOME` to a workspace-local folder
- run the Gradle build with permission to access network when needed

## Current Output Path

Latest successful debug APK:

- `android/app/build/outputs/apk/debug/app-debug.apk`

## Recommended Next Time

1. Run `node scripts/build-capacitor.mjs`
2. Build Android with Java 21
3. Use `GRADLE_USER_HOME` inside the workspace if sandboxing causes issues
4. If the app gains new server-only routes, make sure they are also excluded from the Capacitor export path

