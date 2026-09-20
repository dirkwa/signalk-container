# Contributing

Bug reports, feature requests and pull requests are welcome at
<https://github.com/dirkwa/signalk-container>.

Before opening a pull request, run the full local chain:

```bash
npm run format && npm run build:all && npm run ci-lint
```

`npm run build:all` covers the unit tests. If you have podman or docker
available, `npm run build:all:integration` runs the integration suite too.

## Contributor license grant

By submitting a pull request or patch, you grant Dirk Wahrheit a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce,
modify, publish, sublicense and distribute your contribution, and to relicense
it under any terms, including as part of signalk-container releases. You confirm
that you have the right to grant this.
