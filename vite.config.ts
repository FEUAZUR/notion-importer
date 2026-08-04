import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig } from "vite"
import minimist from "minimist"
import { viteStaticCopy } from "vite-plugin-static-copy"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import zipPack from "vite-plugin-zip-pack"
import fg from "fast-glob"

import vitePluginYamlI18n from "./yaml-plugin"

const rootDir = fileURLToPath(new URL(".", import.meta.url))
const args = minimist(process.argv.slice(2))
const isWatch = args.watch || args.w || false
const devDistDir = "dev"
const distDir = isWatch ? devDistDir : "dist"

// SiYuan refuses to install a package.zip missing any of these.
const REQUIRED_PACKAGE_FILES = [
    "index.js",
    "index.css",
    "plugin.json",
    "icon.png",
    "preview.png",
    "README.md",
    "i18n/en_US.json",
    "i18n/zh_CN.json",
    "i18n/fr_FR.json",
]

function assertPackageContents(dir: string) {
    return {
        name: "assert-package-contents",
        closeBundle: {
            sequential: true,
            order: "pre" as const,
            handler() {
                const missing = REQUIRED_PACKAGE_FILES.filter((file) => !existsSync(resolve(rootDir, dir, file)))
                if (missing.length) {
                    throw new Error(`Build output "${dir}/" is missing: ${missing.join(", ")}`)
                }
            },
        },
    }
}

export default defineConfig({
    resolve: {
        alias: {
            "@": resolve(rootDir, "src"),
        },
    },

    plugins: [
        svelte(),

        vitePluginYamlI18n({
            inDir: "public/i18n",
            outDir: `${distDir}/i18n`,
        }),

        viteStaticCopy({
            targets: [
                { src: "./README*.md", dest: "./" },
                { src: "./plugin.json", dest: "./" },
                { src: "./preview.png", dest: "./" },
                { src: "./icon.png", dest: "./" },
            ],
        }),

        ...(isWatch
            ? [
                {
                    name: "watch-external",
                    async buildStart() {
                        const files = await fg(["public/i18n/**", "./README*.md", "./plugin.json"])
                        for (const file of files) {
                            this.addWatchFile(file)
                        }
                    },
                },
            ]
            : [
                // Must stay after viteStaticCopy: it copies in writeBundle, we zip in closeBundle.
                assertPackageContents(distDir),
                zipPack({ inDir: `./${distDir}`, outDir: "./", outFileName: "package.zip" }),
            ]),
    ],

    define: {
        "process.env.DEV_MODE": JSON.stringify(String(isWatch)),
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
    },

    publicDir: false,

    build: {
        outDir: distDir,
        emptyOutDir: !isWatch,
        sourcemap: isWatch ? "inline" : false,
        minify: !isWatch,

        lib: {
            entry: resolve(rootDir, "src/index.ts"),
            fileName: "index",
            // Replaces the old assetFileNames "style.css" rename, which broke silently
            // whenever Rollup picked a different name and shipped the plugin with no CSS.
            cssFileName: "index",
            formats: ["cjs"],
        },
        rollupOptions: {
            external: ["siyuan", "process"],
            output: {
                entryFileNames: "[name].js",
            },
        },
    },
})
