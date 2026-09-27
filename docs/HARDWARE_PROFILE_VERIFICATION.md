# Hardware Profile Verification Runbook

How to check whether a `custom_components/esphome_designer/frontend/hardware/*.yaml`
recipe is actually accepted by ESPHome, before opening or merging a hardware-support PR.

## What existed before this runbook

- `frontend/tests/io/hardware_profile_sources.test.js` and friends import a
  handful of specific profiles and assert on the *parsed metadata* (name,
  resolution, chip, touch config). They do not catch YAML syntax errors,
  ESPHome schema errors, pin conflicts, or missing components, and they only
  cover the profiles someone remembered to add an `import` for.
- Nothing in the repo (script, CI job, or doc) actually invokes ESPHome
  against a hardware recipe.

This runbook adds that missing check.

## Running it

```bash
# Tier 1: static lint only, no external dependencies, safe for CI
npm run verify:hardware

# Tier 2: also schema-validate every profile with the real `esphome` CLI
npm run verify:hardware:schema

# Just one profile
node scripts/verify_hardware_profiles.cjs --schema some-profile.yaml
```

`verify:hardware:schema` requires the ESPHome CLI (`pip install esphome`) on
`PATH`; if it isn't found the script warns and falls back to Tier 1 only.

## Tier 1 - static lint (always runs)

For every file in `frontend/hardware/`:

- YAML parses (using a schema that understands ESPHome's custom tags -
  `!lambda`, `!secret`, `!include`, `!extend`, `!remove`, `!force` - which
  plain `js-yaml` does not know about).
- Contains the exact `__LAMBDA_PLACEHOLDER__` marker. `hardware_import.js`
  refuses to import an uploaded recipe without it - a profile missing this
  will silently fail every user's upload.
- Has the recommended metadata header (`# Name:`/`# TARGET DEVICE:`,
  `# Resolution:`, `# Shape:`) described in `hardware_recipes_guide.md`.
  Missing metadata is a warning, not a failure - the parser falls back to
  defaults (800x480 rect) rather than rejecting the file, but the fallback
  is very likely wrong for the actual device.
- Warns if `wifi:`/`api:`/`ota:`/`captive_portal:` are left active
  (uncommented) at the top level - the importer auto-sanitizes these, but
  leaving them in makes the recipe file itself misleading to read.

## Tier 2 - schema validation (`--schema`)

Confirmed empirically while building this script: the Designer's real
mechanism for combining a hardware recipe with the app-generated sketch is
ESPHome's native `packages: !include` deep-merge (naive concatenation of two
files that both define `esphome:`/`esp32:`/etc. produces a hard
`Duplicate key` error from ESPHome's loader - this is exactly the "dual
sections" bug in [issue #218](https://github.com/koosoli/ESPHomeDesigner/issues/218)).

For each profile, Tier 2:

1. Replaces `# __LAMBDA_PLACEHOLDER__` with a trivial `lambda: |-` body.
2. Writes a throwaway harness that provides `esphome:` (name only - the
   recipe supplies its own `esp32:`/`esp8266:`/`rp2:` platform block, and
   `wifi:`/`logger:`/`api:`/`ota:`, plus the small set of
   globals/script/time entities every Designer-generated sketch injects so
   the profile's own `on_boot:` hooks and page-navigation buttons resolve:
   - `time: - platform: homeassistant id: ha_time`
   - `globals: display_page, page_refresh_default_s, page_refresh_current_s`
   - `script: manage_run_and_sleep` (referenced by most profiles' `on_boot:`)
   - `script: change_page_to` (referenced by Direct-Mode page buttons)
3. Runs `esphome config <harness>.yaml` (schema/pin/component validation
   only - no compiler or toolchain download) and reports pass/fail with the
   trimmed ESPHome error output.

### Known limitation: LVGL-mode profiles

Some profiles' `touchscreen:` blocks call `lvgl.resume`/`lvgl.is_paused`
etc. (e.g. `sunton-esp32-2432s028R.yaml`, all `guition-esp32-jc*`,
`seeedstudio-reterminal-d1001.yaml`, the Waveshare 4.3"/7" touch profiles).
Those actions only exist when the Designer also emits an `lvgl:` component
bound to the display - but ESPHome rejects a display that has *both*
`lambda:` and `lvgl:` configured. Reproducing the app's real
lambda-vs-LVGL rendering-mode selection is out of scope for a static
per-file script, so Tier 2 reports these as `lvgl-conditional` and skips
automated validation rather than emitting a false pass or fail. **Before
merging a change to one of these profiles, generate the real YAML from the
Designer UI (both rendering modes if the device supports both) and run
`esphome config` on that output by hand.**

## Tier 3 - full compile (manual, not automated)

`esphome config` only validates schema/pins/components; it does not compile
the generated C++. Before shipping a new device profile, also run a full
build once:

```bash
esphome compile /path/to/full-generated-config.yaml
```

This is intentionally not wired into `verify:hardware*` or CI: it downloads
a full PlatformIO toolchain per board family and can take several minutes
per profile on first run, which is too slow to run on every push across
~30 profiles. Run it locally against the actual Designer-generated YAML
(not the bare recipe) before opening a hardware-support PR.

## Findings from the first run (for triage, not yet fixed here)

Running `npm run verify:hardware:schema` against every profile currently in
`main` surfaced concrete, pre-existing issues unrelated to any of the
`feat/add-support-for-*` porting work:

- `lilygo-tdisplays3.yaml`: `Component not found: i80` - the `i80:` bus key
  is not a valid ESPHome component in 2026.8.1.
- `m5stack-tab5.yaml`: `display.mipi_dsi` requires an `esp_ldo:` component
  that the profile does not declare.
- `seeedstudio-reterminal-sticky.yaml`: 32MB flash + OTA requires
  `enable_idf_experimental_features: true` under `esp32.framework.advanced`,
  which the profile does not set.
- `waveshare-esp32-universal-epaper-7.5v2.yaml`: `esphome.project.name`
  (`Waveshare.ESP32-Universal-epaper-7.5v2`) fails ESPHome's
  `namespace.name` validation - the extra `.` in `7.5v2` breaks the
  namespace split.

These are tracked for review, not fixed as part of adding this runbook.
