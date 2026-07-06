# Verstak v1.8.6

Hotfix over v1.8.5.

## Fixed

- Windows installer now uses Electron `original-fs` for payload file operations.
- Silent install / update no longer treats `resources/app.asar` as a virtual asar archive and falsely reports it as empty.

## Verification

- `npm run type`
- targeted installer tests
- `npm run test:fast`
- `npm run build`
- `npm run dist:win`
- silent install over the existing local Verstak installation
