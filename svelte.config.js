import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

// Svelte 5 renamed every warning code from hyphens to underscores.
const NoWarns = new Set([
    "a11y_click_events_have_key_events",
    "a11y_no_static_element_interactions",
    "a11y_no_noninteractive_element_interactions",
])

export default {
    preprocess: vitePreprocess(),
    compilerOptions: {
        runes: true,
    },
    // onwarn(warning, handler) was replaced by a predicate in vite-plugin-svelte 4+.
    warningFilter: (warning) => !NoWarns.has(warning.code),
}
