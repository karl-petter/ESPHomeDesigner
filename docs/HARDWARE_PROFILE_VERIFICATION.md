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

# One or more specific profiles (basenames, or full relative paths - both
# work; this is what the PR check below passes)
node scripts/verify_hardware_profiles.cjs --schema some-profile.yaml another-profile.yaml
```

`verify:hardware:schema` requires the ESPHome CLI (`pip install esphome`) on
`PATH`; if it isn't found the script warns and falls back to Tier 1 only.

**Experimental CI gate:** `.github/workflows/hardware-profile-check.yml`
runs Tier 2 automatically on every PR touching `frontend/hardware/**`,
scoped to only the files that PR actually changed (via `git diff` against
the PR base) - so pre-existing bugs in unrelated profiles never block an
unrelated PR. If the PR instead only changes
`scripts/verify_hardware_profiles.cjs` itself (nothing to scope to), it
runs against every profile as a smoke test of the script - but
non-blockingly (`continue-on-error: true`), since that fallback will
otherwise always surface the pre-existing bugs listed below regardless of
whether the script change itself is correct. Not merged/enabled upstream
yet - see
[koosoli/ESPHomeDesigner#535](https://github.com/koosoli/ESPHomeDesigner/issues/535).

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

### LVGL-mode profiles: best-effort stub, not the real Designer output

Some profiles' `touchscreen:` blocks call `lvgl.resume`/`lvgl.is_paused`
etc. (e.g. `sunton-esp32-2432s028R.yaml`, all `guition-esp32-jc*`,
`seeedstudio-reterminal-d1001.yaml`, the Waveshare 4.3"/7" touch profiles).
Those actions only exist when the Designer also emits an `lvgl:` component
bound to the display - but ESPHome rejects a display that has *both*
`lambda:` and `lvgl:` configured, and separately rejects `rotation:`,
`auto_clear_enabled:`, `show_test_card:`, and `pages:` on a display owned
by LVGL (straight from ESPHome's own error text).

Rather than skip these profiles entirely, Tier 2 builds a **best-effort
LVGL stub**: it drops the `__LAMBDA_PLACEHOLDER__` line (no lambda at all -
LVGL owns rendering), relocates any `rotation:` on the display into a bare
`lvgl: displays: - <id>` block, and strips `auto_clear_enabled:`/
`show_test_card:`/`pages:` if present, then validates the result. This is
**not** the same as the real Designer-generated LVGL YAML - there are no
real pages/widgets, just ESPHome's own `hello_world` fallback page - so it
validates that the profile's hardware wiring (pins, components, touch,
backlight) is schema-correct in LVGL mode, not that any particular sketch
renders correctly. Results are reported as `pass-lvgl-stub`/`fail-lvgl-stub`
(shown as `WARN`/`FAIL`, never silently `OK`) with the stripped/relocated
keys listed, so it's always visible that this wasn't a full validation.
**Before merging a change to one of these profiles, still generate the
real YAML from the Designer UI and run `esphome config` on that output by
hand at least once** - the stub catches wiring/component bugs, not sketch
or page-layout bugs.

If a profile can't be stubbed at all (no detectable `display:` block/id),
Tier 2 falls back to the old behavior: reported as `lvgl-conditional`,
skipped, not silently passed.

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

Non-LVGL profiles:
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

LVGL-mode profiles (surfaced once Tier 2 started actually validating them
via the stub above, instead of skipping):
- **Six profiles are missing the now-required `model:` option on
  `display: platform: mipi_rgb`**: `elecrow-esp32-7inch.yaml`,
  `guition-esp32-jc8048w550.yaml`, `sunton-esp32-4827s032R.yaml`,
  `sunton-esp32-8048s050.yaml`, `sunton-esp32-8048s070.yaml`,
  `waveshare-esp32-s3-touch-lcd-4.3.yaml`. Same root cause across all six -
  likely a schema requirement added in a newer ESPHome release than these
  profiles were last verified against.
- `guition-esp32-s3-4848s040.yaml`: a real YAML structure bug - the
  touchscreen's `on_release:` block is nested *inside* `transform:`
  instead of as its sibling (`[on_release] is an invalid option for
  [transform]`).

9 of the 16 LVGL-mode profiles pass the stub cleanly:
`guition-esp32-jc4827w543.yaml`, `guition-esp32-jc8048w535.yaml`,
`guition-esp32-p4-jc4880p443.yaml`, `guition-esp32-p4-jc8012p4a1c.yaml`,
`seeedstudio-reterminal-d1001.yaml`, `sunton-esp32-2432s028.yaml`,
`sunton-esp32-2432s028R.yaml`, `viewdisplay-esp32-s3-uedx48480021.yaml`,
`waveshare-esp32-s3-touch-lcd-7.yaml`.

These are tracked for review, not fixed as part of adding this runbook.
