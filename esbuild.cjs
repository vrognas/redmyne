/* eslint-disable @typescript-eslint/no-var-requires, no-console */
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

// Options shared by every build target. Per-target entries override/extend these.
const baseOpts = {
  minify: production,
  sourcesContent: false,
  logLevel: "silent",
  plugins: [esbuildProblemMatcherPlugin],
};

// JS bundles + the two CSS targets (CSS is a first-class esbuild target;
// minification strips comments/whitespace and shortens values — no bundling
// needed since these files have no @import edges).
const targets = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "out/extension.js",
    bundle: true,
    format: "cjs",
    platform: "node",
    external: ["vscode"],
    sourcemap: !production,
  },
  {
    entryPoints: ["src/webviews/gantt/index.js"],
    outfile: "media/gantt.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    sourcemap: production ? false : "external",
  },
  {
    entryPoints: ["src/webviews/timesheet/index.js"],
    outfile: "media/timesheet.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    sourcemap: production ? false : "external",
  },
  { entryPoints: ["src/webviews/gantt/styles.css"], outfile: "media/gantt.css", sourcemap: false },
  { entryPoints: ["src/webviews/timesheet/styles.css"], outfile: "media/timesheet.css", sourcemap: false },
];

async function main() {
  const contexts = await Promise.all(
    targets.map((t) => esbuild.context({ ...baseOpts, ...t }))
  );

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
