# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-10-26

Forked as `compta-cli` (binary `compta`); speaks the Compta API.

### Changed
- All requests go to the Compta API (`/v1/…`) with `Authorization: Bearer <token>`; API errors
  are read from the `{"error":{"code","message","details"}}` envelope.
- `COMPTA_API_BASE` is required for API commands (`API_BASE_MISSING`, exit 2).
- Environment variables `COMPTA_*`; config, cache and credential-store service `compta-cli`;
  default rules file `compta.rules.json`; skill at `skills/compta/SKILL.md`.
- `export` column `compta_id`; plans record `createdBy: compta-cli <version> <command>`.
- Normalized output, plan format, flags, exit codes and error JSON are otherwise unchanged.
- The cache lives under `~/.cache/compta-cli/<schema version>/<API origin>/<company>/`: data
  cached from one API origin or company is never read for another.

### Fixed
- A cached category list that lacks a category referenced by an operation is read again from
  the API; a category still unknown fails with `CATEGORY_UNKNOWN` instead of a blank name.

### Removed
- `login --from-browser` and automatic session refresh from a browser.
- Session-cookie handling (tokens do not rotate).
