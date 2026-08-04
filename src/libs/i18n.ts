type Dict = Record<string, string>

let dict: Dict = {}

export function setI18n(next: Dict) {
    dict = next ?? {}
}

/**
 * Translate `key`, substituting `{0}`, `{1}`, ... with `args`.
 * Falls back to the key itself so a missing entry is visible rather than blank.
 */
export function t(key: string, ...args: Array<string | number>): string {
    const template = dict[key] ?? key
    if (!args.length) {
        return template
    }
    return template.replace(/\{(\d+)\}/g, (match, index) => {
        const value = args[Number(index)]
        return value === undefined ? match : String(value)
    })
}
