export async function resolve(spec, ctx, next) { if (spec === 'electron') return { url: new URL('./stub-electron.mjs', import.meta.url).href, shortCircuit: true }; return next(spec, ctx); }
