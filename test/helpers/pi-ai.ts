/**
 * pi-ai.ts — single import point for the test helpers pi-ai exports only from
 * its `/compat` subpath, the global-registry API. pi-ai marks that subpath
 * temporary: it is deleted with the coding-agent ModelManager migration, and
 * the replacement then is `fauxProvider()` + `createModels()`.
 */
export { getModel, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
