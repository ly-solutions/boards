# Licenses

boards is licensed under the [Apache License 2.0](../LICENSE). All runtime and bundled dependencies use licenses
compatible with it (checked against `package-lock.json` for 0.1.0):

| Dependency | Where | License |
| --- | --- | --- |
| [@excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) 0.18.1 | web editor bundle, server-side engine | MIT |
| Excalidraw fonts (Excalifont, Virgil, Nunito, Lilita One, Cascadia Code, Liberation Sans, Assistant, Xiaolai, Comic Shanns) | served with the editor | SIL OFL 1.1 (Comic Shanns: MIT) |
| React, React DOM | web editor bundle | MIT |
| [jsdom](https://github.com/jsdom/jsdom) | server (Excalidraw under Node) | MIT |
| [ws](https://github.com/websockets/ws) | server (live channel) | MIT |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre) | server (graph layout) | MIT |
| [yaml](https://github.com/eemeli/yaml) | server | ISC |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-s3`) | server (S3 driver) | Apache-2.0 |
| DOMPurify (transitive, via Excalidraw) | web editor bundle | MPL-2.0 OR Apache-2.0 (used under Apache-2.0) |

Production dependency tree by license: MIT 31, Apache-2.0 25, BSD-2/3-Clause 4, ISC 2, MIT-0 2, 0BSD 1,
BlueOak-1.0.0 1, CC0-1.0 1. Build-only tools (Vite, esbuild, TypeScript, Lightning CSS — MPL-2.0) are not
distributed. Regenerate with:

```sh
npx license-checker --production --summary
```

Brand assets in `docs/assets` and `web/public` (the "boards." wordmark and "b." mark, set in Unbounded — SIL OFL 1.1 —
and converted to outlines) are part of this repository under the same license.
