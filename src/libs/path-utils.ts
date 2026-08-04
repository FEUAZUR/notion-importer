/**
 * Pure path helpers, kept out of filesystem.ts because that module configures a zip.js
 * web worker at import time and therefore cannot be loaded outside a browser (or a test).
 */

export function splitext(name: string): [string, string] {
    const dotIndex = name.lastIndexOf('.');
    if (dotIndex > 0) {
        return [name.substring(0, dotIndex), name.substring(dotIndex + 1).toLowerCase()];
    }
    return [name, ''];
}

export function parseFilePath(filepath: string): { parent: string, name: string, basename: string, extension: string } {
    const lastIndex = Math.max(filepath.lastIndexOf('/'), filepath.lastIndexOf('\\'));
    let name = filepath;
    let parent = '';
    if (lastIndex >= 0) {
        name = filepath.substring(lastIndex + 1);
        parent = filepath.substring(0, lastIndex);
    }

    const [basename, extension] = splitext(name);
    return { parent, name, basename, extension };
}
