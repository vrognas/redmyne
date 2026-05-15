/* eslint-disable @typescript-eslint/no-var-requires, no-console */
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "out/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  const ganttJsCtx = await esbuild.context({
    entryPoints: ["src/webviews/gantt/index.js"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: production ? false : "external",
    sourcesContent: false,
    platform: "browser",
    outfile: "media/gantt.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  const timesheetJsCtx = await esbuild.context({
    entryPoints: ["src/webviews/timesheet/index.js"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: production ? false : "external",
    sourcesContent: false,
    platform: "browser",
    outfile: "media/timesheet.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  // CSS is a first-class esbuild target; minification strips comments and
  // whitespace and shortens color/length values. No bundling needed since
  // these files have no @import edges.
  const ganttCssCtx = await esbuild.context({
    entryPoints: ["src/webviews/gantt/styles.css"],
    minify: production,
    sourcemap: false,
    outfile: "media/gantt.css",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  const timesheetCssCtx = await esbuild.context({
    entryPoints: ["src/webviews/timesheet/styles.css"],
    minify: production,
    sourcemap: false,
    outfile: "media/timesheet.css",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  const contexts = [extensionCtx, ganttJsCtx, timesheetJsCtx, ganttCssCtx, timesheetCssCtx];

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
