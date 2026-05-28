# Line of Sight

Line of Sight is a browser-first lab for extracting and reviewing visibility
metadata from geomorphic tactical maps. It is intended to support:

- arranging local geomorph images into a board grid;
- detecting candidate wall segments from raster map art;
- correcting walls and doors by hand;
- toggling closed doors open to recalculate visibility;
- tracking areas that are visible now and areas that have been seen before;
- exporting reviewed LOS sidecar JSON for another virtual tabletop.

The app keeps published map and counter assets out of git. Local development may
copy `Geomorphs/` and `Counters/` into the project root, but those folders are
ignored and are not deployed.

## Stack

- Rust geometry and image-analysis core compiled to WebAssembly.
- TypeScript browser UI.
- WebGPU-ready frontend with a runtime capability check.
- Cloudflare Workers static assets for deployment.

## Development

```bash
npm install
npm run build
npm run dev
```

The local asset folders are optional. The deployed public app expects users to
select their own map images in the browser.

## Deployment

```bash
npm run deploy
```

The Worker is configured for `los.tre.systems`.

## License

MIT. This license applies to the source code in this repository, not to any
locally copied map or counter artwork.

