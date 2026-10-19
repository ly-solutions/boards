// Import order matters: the shim must run before the package touches window.
import './dom-shim.mjs'

export { measureLine } from './dom-shim.mjs'
export { convertToExcalidrawElements } from '@excalidraw/excalidraw'
export { generateNKeysBetween } from 'fractional-indexing'
